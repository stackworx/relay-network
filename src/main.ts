import ky, {HTTPError, Options} from "ky";
import {
  CacheConfig,
  FetchFunction,
  GraphQLResponse,
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
  // Handle 403
  handleLogout(): Promise<void>;
}

export class ServerError extends Error {}

export function createFetchQuery(config: Configuration): FetchFunction {
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
        const res = doFetch(
          config,
          signal,
          request,
          variables,
          cacheConfig,
          uploadables,
        );

        res
          .then((value) => {
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
          // TODO: is this needed?
          closed: false,
        };
      },
    };
  };
}

const defaultRetry: Options["retry"] = {
  limit: 2,
  methods: ["get"],
  // TODO: add more?
  statusCodes: [503],
};

async function doFetch(
  config: Configuration,
  signal: AbortSignal,
  request: RequestParameters,
  variables: Variables,
  _cacheConfig: CacheConfig,
  _uploadables?: UploadableMap | null,
): Promise<GraphQLResponse> {
  if (!request.text) {
    throw new Error("Persisted Queries are not supported");
  }

  const url = typeof config.url === "function" ? await config.url() : config.url;
  const headers = typeof config.headers === "function"
    ? await config.headers(request)
    : config.headers ?? {};

  try {
    const {files, clone: variablesClone} = extractFiles(
      {
        ...variables,
      },
      isExtractableFile,
    );

    let resp: Response;

    const options: Options = {
      timeout: config.timeout,
      retry: config.retry ?? defaultRetry,
      headers,
      signal,
      method: request.operationKind == "query" ? "get" : "post",
      hooks: {
        beforeError: [
          async (error) => {
            const {response} = error;
            if (response.status === 401) {
              await config.handleLogout();
            }

            return error;
          },
        ],
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
      contentType.startsWith("application/json")
      || contentType.startsWith("application/graphql-response+json")
    ) {
      const result: GraphQLResponse = await resp.json();

      // TODO: validate response
      return result;
    } else {
      throw new ServerError(
        `Unhandled content-type ${contentType} on response`,
      );
    }
  } catch (ex) {
    if (ex instanceof HTTPError) {
      const contentType = ex.response.headers.get("content-type");

      switch (contentType) {
        case null:
          throw new ServerError(`Missing content-type on response`);
        case "text/plain":
          throw new ServerError(await ex.response.text());
        case "application/json":
          throw new Error(JSON.stringify(await ex.response.json()));
        default:
          throw new ServerError(
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
      extensions: undefined, // TODO
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
        extensions: undefined, // TODO
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
