import ky, {AfterResponseHook, BeforeErrorHook, BeforeRequestHook, HTTPError, Options} from "ky";
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
import extractFiles, {ExtractableFile} from "extract-files/extractFiles.mjs";
// @ts-expect-error https://github.com/jaydenseric/extract-files/issues/28
import isExtractableFile from "extract-files/isExtractableFile.mjs";
import {Sink} from "relay-runtime/lib/network/RelayObservable";

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
  afterResponse?: AfterResponseHook[];
  beforeError?: BeforeErrorHook[];
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
  return function fetchQuery(
    request: RequestParameters,
    variables: Variables,
    cacheConfig: CacheConfig,
    uploadables?: UploadableMap | null,
    deleteDataIfError = true,
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

function extractBoundary(contentType: string): string | null {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return (match?.[1] ?? match?.[2] ?? null)?.trim() ?? null;
}

function boundaryLineIsFinal(boundaryLine: string, boundary: string): boolean {
  const marker = `--${boundary}`;
  const line = boundaryLine.trim();
  if (!line.startsWith(marker)) {
    return false;
  }

  // Final boundary is "--{boundary}--" (some servers may send extra dashes)
  const after = line.slice(marker.length);
  return after.startsWith("--");
}

function findNextBoundaryLineStart(
  buffer: string,
  boundary: string,
  fromIndex: number,
): number {
  const marker = `--${boundary}`;
  let idx = buffer.indexOf(marker, fromIndex);
  while (idx !== -1) {
    if (idx === 0 || buffer[idx - 1] === "\n") {
      return idx;
    }
    idx = buffer.indexOf(marker, idx + marker.length);
  }
  return -1;
}

function parseMultipartHeaders(headerText: string): Headers {
  const headers: Headers = {};
  for (const line of headerText.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = value;
  }
  return headers;
}

async function streamMultipartMixed(
  response: Response,
  boundary: string,
  onPayload: (payload: GraphQLResponse) => void,
): Promise<void> {
  if (!response.body) {
    const text = await response.text();
    throw new ServerError(response.status, "Missing response body", text);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let done = false;
  type State = "SEARCH_BOUNDARY" | "READ_HEADERS" | "READ_BODY";
  let state: State = "SEARCH_BOUNDARY";
  let partHeaders: Headers = {};

  const parseAvailable = (final: boolean) => {
    while (true) {
      if (state === "SEARCH_BOUNDARY") {
        const start = findNextBoundaryLineStart(buffer, boundary, 0);
        if (start === -1) {
          // Keep a small tail in case boundary spans chunks
          if (buffer.length > 4096) {
            buffer = buffer.slice(-4096);
          }
          return;
        }

        if (start > 0) {
          // Drop preamble bytes before the boundary
          buffer = buffer.slice(start);
        }

        const boundaryLineEnd = buffer.indexOf("\n");
        if (boundaryLineEnd === -1) {
          return;
        }

        const boundaryLine = buffer.slice(0, boundaryLineEnd);
        buffer = buffer.slice(boundaryLineEnd + 1);
        if (buffer.startsWith("\r")) {
          buffer = buffer.slice(1);
        }

        if (boundaryLineIsFinal(boundaryLine, boundary)) {
          buffer = "";
          done = true;
          return;
        }

        partHeaders = {};
        state = "READ_HEADERS";
        continue;
      }

      if (state === "READ_HEADERS") {
        const headerSepCRLF = buffer.indexOf("\r\n\r\n");
        const headerSepLF = buffer.indexOf("\n\n");
        const headerSep = headerSepCRLF === -1
          ? headerSepLF
          : headerSepLF === -1
          ? headerSepCRLF
          : Math.min(headerSepCRLF, headerSepLF);

        if (headerSep === -1) {
          return;
        }

        const headerEndLen = headerSep === headerSepCRLF ? 4 : 2;
        const headerText = buffer.slice(0, headerSep);
        partHeaders = parseMultipartHeaders(headerText);
        buffer = buffer.slice(headerSep + headerEndLen);
        state = "READ_BODY";
        continue;
      }

      // READ_BODY
      const nextBoundary = findNextBoundaryLineStart(buffer, boundary, 0);
      if (nextBoundary === -1) {
        if (!final) {
          return;
        }

        const bodyText = buffer.trim();
        buffer = "";
        state = "SEARCH_BOUNDARY";
        if (bodyText.length === 0) {
          return;
        }

        if (
          partHeaders["content-type"]?.startsWith("application/json")
          || partHeaders["content-type"]?.startsWith(
            "application/graphql-response+json",
          )
          || partHeaders["content-type"] == null
        ) {
          onPayload(JSON.parse(bodyText));
        }
        return;
      }

      const partBody = buffer.slice(0, nextBoundary).trim();
      buffer = buffer.slice(nextBoundary);
      state = "SEARCH_BOUNDARY";

      if (partBody.length === 0) {
        continue;
      }

      if (
        partHeaders["content-type"]?.startsWith("application/json")
        || partHeaders["content-type"]?.startsWith(
          "application/graphql-response+json",
        )
        || partHeaders["content-type"] == null
      ) {
        onPayload(JSON.parse(partBody));
      }
    }
  };

  while (!done) {
    const {value, done: readerDone} = await reader.read();
    if (value) {
      buffer += decoder.decode(value, {stream: true});
      parseAvailable(false);
    }
    if (readerDone) {
      buffer += decoder.decode();
      parseAvailable(true);
      break;
    }
  }
}

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

    const headers = typeof config.headers === "function"
      ? await config.headers(request)
      : config.headers ?? multipart
      // Enable preflight header
      ? {"graphql-preflight": "1"}
      : {};

    let resp: Response;

    const retry = request.operationKind !== "mutation"
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

              return error;
            },
            ...(config.beforeError ?? []),
          ]
          : config.beforeError ?? [],
        beforeRequest: config.beforeRequest ?? [],
        afterResponse: config.afterResponse ?? [],
      },
    };

    if (multipart) {
      resp = await postMultipart(url, options, request, variablesClone, files);
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

      const emit = onPayload ?? (() => {});
      await streamMultipartMixed(resp, boundary, emit);
      return;
    } else if (
      contentType.startsWith("application/graphql-response+json")
      || (contentType.startsWith("application/json")
        && allowApplicationJsonContentType)
    ) {
      const result: GraphQLResponse = await resp.json();

      // TODO: validate response
      // https://spec.graphql.org/June2018/#sec-Errors
      if (onPayload) {
        onPayload(result);
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
    if (ex instanceof HTTPError) {
      const contentType = ex.response.headers.get("content-type");

      if (contentType == null) {
        const text = await ex.response.text();
        if (!ex.response.ok) {
          throw new ServerError(ex.response.status, ex.response.statusText, text);
        }
        throw new ServerError(undefined, `Missing content-type on response`);
      } else if (contentType.startsWith("multipart/mixed")) {
        const text = await ex.response.text();
        throw new ServerError(ex.response.status, ex.response.statusText, text);
      } else if (contentType === "text/plain") {
        throw new ServerError(undefined, await ex.response.text());
      } else if (
        contentType.startsWith("application/graphql-response+json")
        || (contentType.startsWith("application/json")
          && allowApplicationJsonContentType)
      ) {
        // We got a well formed graphql response
        const payload: GraphQLResponse = await ex.response.json();
        if (!allowApplicationJsonContentType) {
          if (onPayload) {
            onPayload(payload);
            return;
          }
          throw new Error(JSON.stringify(payload));
        }
        throw new Error(JSON.stringify(payload));
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
