import ky, {isHTTPError} from "ky";
import type {BeforeErrorHook, Hooks, Options} from "ky";
import type {
  CacheConfig,
  FetchFunction,
  GraphQLResponse,
  GraphQLResponseWithData,
  RequestParameters,
  Subscribable,
  UploadableMap,
  Variables,
} from "relay-runtime";
// @ts-expect-error https://github.com/jaydenseric/extract-files/issues/28
import extractFiles, {type ExtractableFile} from "extract-files/extractFiles.mjs";
// @ts-expect-error https://github.com/jaydenseric/extract-files/issues/28
import isExtractableFile from "extract-files/isExtractableFile.mjs";
import type {Sink} from "relay-runtime/network/RelayObservable";

import {emitRelayCompatiblePayload, extractBoundary, streamMultipartMixed} from "./defer";

type Headers = Record<string, string | undefined>;

interface Configuration {
  /** GraphQL endpoint, or a function resolving one (e.g. per-tenant routing). */
  url: string | (() => Promise<string>);
  /** Static headers, or a function invoked per request to produce them. */
  headers?: Headers | ((request: RequestParameters) => Promise<Headers>);
  /** Per-attempt request timeout in ms. See ky's `timeout` option. */
  timeout?: Options["timeout"];
  /**
   * Retry policy for retriable (non-mutation) operations. Queries are sent as
   * GET, so the default `methods: ["get"]` applies. See ky's `retry` option.
   */
  retry?: Options["retry"];
  /**
   * Decides whether a response means the user's session is gone. Defaults to
   * treating HTTP 403 as logged-out.
   */
  logoutCheck?(response: Response): boolean;
  /** Invoked when `logoutCheck` matches, e.g. to clear the store / tokens. */
  handleLogout?(): Promise<void> | void;
  /**
   * When a payload contains both `data` and `errors`, drop `data` so Relay
   * routes the failure through `onError` instead of `onCompleted`. Defaults to
   * `true` (works around servers such as Hot Chocolate that return an empty
   * data object on error). Set to `false` to emit payloads verbatim.
   */
  deleteDataIfError?: boolean;
  /**
   * Accept plain `application/json` responses in addition to the spec's
   * `application/graphql-response+json`. Off by default.
   */
  allowApplicationJsonContentType?: boolean;
  /** ky lifecycle hooks (beforeRequest, afterResponse, beforeError, ...). */
  hooks?: Hooks;
}

function defaultLogoutCheck(response: Response) {
  return response.status === 403;
}

export class ServerError extends Error {
  constructor(public status?: number, message?: string, public response?: string) {
    super(message);
  }
}

export function createFetchQuery(config: Configuration): FetchFunction {
  const deleteDataIfError = config.deleteDataIfError ?? true;
  return function fetchQuery(
    request: RequestParameters,
    variables: Variables,
    cacheConfig: CacheConfig,
    uploadables?: UploadableMap | null,
  ): Subscribable<GraphQLResponse> {
    return {
      subscribe: (sink: Sink<GraphQLResponse>) => {
        const controller = new AbortController();
        const {signal} = controller;
        const emit = (value: GraphQLResponse) => {
          if (deleteDataIfError) {
            if (
              (value as GraphQLResponseWithData).data
              && (value as GraphQLResponseWithData).errors
            ) {
              // @ts-expect-error delete
              delete value.data;
            }
          }
          sink.next(value);
        };

        doFetch(
          config,
          signal,
          request,
          variables,
          cacheConfig,
          uploadables,
          emit,
        )
          .then(() => sink.complete())
          .catch((error) => {
            if (error && error.name && error.name === "AbortError") {
              sink.complete();
            } else {
              sink.error(error);
            }
          });

        return {
          unsubscribe() {
            controller.abort();
          },
          get closed() {
            return sink.closed;
          },
        };
      },
    };
  };
}

const defaultRetry: Options["retry"] = {
  limit: 2,
  methods: ["get"],
  statusCodes: [503],
};

async function doFetch(
  {allowApplicationJsonContentType = false, ...config}: Configuration,
  signal: AbortSignal,
  request: RequestParameters,
  variables: Variables,
  _cacheConfig: CacheConfig,
  _uploadables?: UploadableMap | null,
  onPayload?: (payload: GraphQLResponse) => void,
): Promise<void> {
  if (!request.text) {
    throw new Error("Persisted Queries are not supported");
  }

  const url = typeof config.url === "function" ? await config.url() : config.url;

  try {
    const {files, clone: variablesClone} = extractFiles(
      {
        ...variables,
      },
      isExtractableFile,
    );
    const multipart = files.size > 0;

    const headers: Headers = typeof config.headers === "function"
      ? await config.headers(request)
      : {...config.headers};
    if (multipart) {
      // Enable the preflight header for graphql-multipart uploads.
      headers["graphql-preflight"] = "1";
    }

    let resp: Response;

    const retry = request.operationKind !== "mutation"
      ? config.retry ?? defaultRetry
      : undefined;

    const logoutHook: BeforeErrorHook = async ({error}) => {
      // ky v2 runs beforeError for all error types (network, timeout, ...),
      // but only HTTPError carries a response to inspect.
      if (isHTTPError(error)) {
        const {response} = error;
        if (
          config.logoutCheck
            ? config.logoutCheck(response)
            : defaultLogoutCheck(response)
        ) {
          if (config.handleLogout) {
            await config.handleLogout();
          }
        }
      }

      return error;
    };

    const options: Options = {
      timeout: config.timeout,
      retry,
      headers,
      signal,
      hooks: {
        ...config.hooks,
        beforeError: config.handleLogout
          ? [logoutHook, ...(config.hooks?.beforeError ?? [])]
          : config.hooks?.beforeError,
      },
    };

    if (multipart) {
      resp = await postMultipart(url, options, request, variablesClone, files);
    } else if (request.operationKind === "query") {
      resp = await getQuery(url, options, request, variables);
    } else {
      resp = await postJson(url, options, request, variables);
    }

    const contentType = resp.headers.get("content-type");

    if (contentType == null) {
      const text = await resp.text();
      if (!resp.ok) {
        throw new ServerError(resp.status, resp.statusText, text);
      }
      throw new ServerError(resp.status, `Missing content-type on response`, text);
    } else if (contentType.startsWith("multipart/mixed")) {
      const boundary = extractBoundary(contentType);
      if (!boundary) {
        const text = await resp.text();
        throw new ServerError(
          resp.status,
          "Missing boundary on multipart/mixed response",
          text,
        );
      }

      const emit = onPayload
        ? (payload: GraphQLResponse) => emitRelayCompatiblePayload(payload, onPayload)
        : () => {};
      await streamMultipartMixed(resp, boundary, emit);
      return;
    } else if (
      contentType.startsWith("application/graphql-response+json")
      || (contentType.startsWith("application/json")
        && allowApplicationJsonContentType)
    ) {
      const result = await resp.json() as GraphQLResponse;

      // TODO: validate response
      // https://spec.graphql.org/June2018/#sec-Errors
      if (onPayload) {
        emitRelayCompatiblePayload(result, onPayload);
        return;
      }

      return;
    } else {
      throw new ServerError(
        resp.status,
        `Unhandled content-type ${contentType} on response`,
      );
    }
  } catch (ex) {
    if (isHTTPError(ex)) {
      const {response, data} = ex;
      const contentType = response.headers.get("content-type");
      // ky v2 auto-consumes the HTTPError body into `data`: a parsed object for
      // JSON content types, plain text otherwise, or undefined when empty.
      const asText = () => typeof data === "string" ? data : data == null ? "" : JSON.stringify(data);

      if (contentType == null) {
        if (!response.ok) {
          throw new ServerError(response.status, response.statusText, asText());
        }
        throw new ServerError(undefined, `Missing content-type on response`);
      } else if (contentType.startsWith("multipart/mixed")) {
        throw new ServerError(response.status, response.statusText, asText());
      } else if (contentType === "text/plain") {
        throw new ServerError(undefined, asText());
      } else if (
        contentType.startsWith("application/graphql-response+json")
        || (contentType.startsWith("application/json")
          && allowApplicationJsonContentType)
      ) {
        // We got a well formed graphql response
        const payload = data as GraphQLResponse;
        if (!allowApplicationJsonContentType) {
          if (onPayload) {
            emitRelayCompatiblePayload(payload, onPayload);
            return;
          }
          throw new Error(JSON.stringify(payload), {cause: ex});
        }
        throw new Error(JSON.stringify(payload), {cause: ex});
      } else {
        throw new ServerError(
          undefined,
          `Unhandled content-type ${contentType} on response`,
        );
      }
    }

    throw ex;
  }
}

async function getQuery(
  url: string,
  options: Options,
  request: RequestParameters,
  variables: Variables,
): Promise<Response> {
  // GraphQL-over-HTTP GET: the operation is carried in the query string.
  return ky.get(url, {
    ...options,
    searchParams: {
      query: request.text ?? "",
      operationName: request.name,
      variables: JSON.stringify(variables),
    },
  });
}

async function postJson(
  url: string,
  options: Options,
  request: RequestParameters,
  variables: Variables,
): Promise<Response> {
  return ky.post(url, {
    ...options,
    json: {
      query: request.text,
      operationName: request.name,
      variables,
      // (Optional): This entry is reserved for implementors to extend the protocol however they see fit.
      extensions: undefined,
    },
  });
}

async function postMultipart(
  url: string,
  options: Options,
  request: RequestParameters,
  variables: Variables,
  files: Map<ExtractableFile, string[]>,
): Promise<Response> {
  const body = new FormData();
  if (request.text) {
    body.append(
      "operations",
      JSON.stringify({
        query: request.text,
        operationName: request.name,
        variables,
        // (Optional): This entry is reserved for implementors to extend the protocol however they see fit.
        extensions: undefined,
      }),
    );
  }

  const map: {[key: number]: string[]} = {};
  let i = 0;
  files.forEach((paths) => {
    map[++i] = paths.map((path) => `variables.${path}`);
  });

  body.append("map", JSON.stringify(map));

  i = 0;
  files.forEach((_, file) => {
    body.append(`${++i}`, file, file.name);
  });

  return ky.post(url, {
    ...options,
    body,
  });
}
