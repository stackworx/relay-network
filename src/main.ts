import ky, { BeforeRequestHook, HTTPError, Options } from "ky";
import {
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
import extractFiles, { ExtractableFile } from "extract-files/extractFiles.mjs";
// @ts-expect-error https://github.com/jaydenseric/extract-files/issues/28
import isExtractableFile from "extract-files/isExtractableFile.mjs";
import { Sink } from "relay-runtime/lib/network/RelayObservable";

type Headers = Record<string, string | undefined>;

interface Configuration {
  url: string | (() => Promise<string>);
  headers?: Headers | ((request: RequestParameters) => Promise<Headers>);
  timeout?: Options["timeout"];
  retry?: Options["retry"];
  // Check if we should log the user out
  logoutCheck?(response: Response): boolean;
  // Handle 401
  handleLogout?(): Promise<void> | void;
  // Hotchocolate will return an empty object when mutations fail
  // This breaks the useMutation error handling because
  // The error will arrive as the second argument to the onCompleted method instead of the onError
  deleteDataIfError?: boolean;
  allowApplicationJsonContentType?: boolean;
  beforeRequest?: BeforeRequestHook[];
}

function defaultLogoutCheck(response: Response) {
  return response.status === 403;
}

export class ServerError extends Error {}

export function createFetchQuery(config: Configuration): FetchFunction {
  return function fetchQuery(
    request: RequestParameters,
    variables: Variables,
    cacheConfig: CacheConfig,
    uploadables?: UploadableMap | null,
    deleteDataIfError = true
  ): Subscribable<GraphQLResponse> {
    return {
      subscribe: (sink: Sink<GraphQLResponse>) => {
        const controller = new AbortController();
        const { signal } = controller;
        const res = doFetch(
          config,
          signal,
          request,
          variables,
          cacheConfig,
          uploadables
        );

        res
          .then((value) => {
            if (deleteDataIfError) {
              if (
                (value as GraphQLResponseWithData).data &&
                (value as GraphQLResponseWithData).errors
              ) {
                // @ts-expect-error delete
                delete value.data;
              }
            }
            sink.next(value);
            sink.complete();
          })
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
  { allowApplicationJsonContentType = false, ...config }: Configuration,
  signal: AbortSignal,
  request: RequestParameters,
  variables: Variables,
  _cacheConfig: CacheConfig,
  _uploadables?: UploadableMap | null
): Promise<GraphQLResponse> {
  if (!request.text) {
    throw new Error("Persisted Queries are not supported");
  }

  const url =
    typeof config.url === "function" ? await config.url() : config.url;
  const headers =
    typeof config.headers === "function"
      ? await config.headers(request)
      : config.headers ?? {};

  try {
    const { files, clone: variablesClone } = extractFiles(
      {
        ...variables,
      },
      isExtractableFile
    );

    let resp: Response;

    const retry =
      request.operationKind !== "mutation"
        ? config.retry ?? defaultRetry
        : undefined;

    const options: Options = {
      timeout: config.timeout,
      retry,
      headers,
      signal,
      method: request.operationKind == "query" ? "get" : "post",
      hooks: {
        beforeError: config.handleLogout
          ? [
              async (error) => {
                const { response } = error;
                if (
                  config.logoutCheck
                    ? config.logoutCheck(response)
                    : defaultLogoutCheck(response)
                ) {
                  if (config.handleLogout) {
                    await config.handleLogout();
                  }
                }

                return error;
              },
            ]
          : [],
        beforeRequest: config.beforeRequest ?? [],
      },
    };

    if (files.size > 0) {
      resp = await postMultipart(url, options, request, variablesClone, files);
    } else {
      resp = await postJson(url, options, request, variables);
    }

    const contentType = resp.headers.get("content-type");

    if (contentType == null) {
      throw new ServerError(`Missing content-type on response`);
    } else if (
      contentType.startsWith("application/graphql-response+json") ||
      (contentType.startsWith("application/json") &&
        allowApplicationJsonContentType)
    ) {
      const result: GraphQLResponse = await resp.json();

      // TODO: validate response
      // https://spec.graphql.org/June2018/#sec-Errors
      return result;
    } else {
      throw new ServerError(
        `Unhandled content-type ${contentType} on response`
      );
    }
  } catch (ex) {
    if (ex instanceof HTTPError) {
      const contentType = ex.response.headers.get("content-type");

      if (contentType == null) {
        throw new ServerError(`Missing content-type on response`);
      } else if (contentType === "text/plain") {
        throw new ServerError(await ex.response.text());
      } else if (
        contentType.startsWith("application/graphql-response+json") ||
        (contentType.startsWith("application/json") &&
          allowApplicationJsonContentType)
      ) {
        // We got a well formed graphql response
        if (!allowApplicationJsonContentType) {
          return await ex.response.json();
        }
        throw new Error(JSON.stringify(await ex.response.json()));
      } else {
        throw new ServerError(
          `Unhandled content-type ${contentType} on response`
        );
      }
    }

    throw ex;
  }
}

async function postJson(
  url: string,
  options: Options,
  request: RequestParameters,
  variables: Variables
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
  files: Map<ExtractableFile, string[]>
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
      })
    );
  }

  const map: { [key: number]: string[] } = {};
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
