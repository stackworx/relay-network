import ky, {HTTPError} from "ky";
import {CacheConfig, FetchFunction, GraphQLResponse, RequestParameters, UploadableMap, Variables} from "relay-runtime";
// @ts-expect-error https://github.com/jaydenseric/extract-files/issues/28
import extractFiles, {ExtractableFile} from "extract-files/extractFiles.mjs";
// @ts-expect-error https://github.com/jaydenseric/extract-files/issues/28
import isExtractableFile from "extract-files/isExtractableFile.mjs";

type Headers = Record<string, string | undefined>;

interface Configuration {
  url: string | (() => Promise<string>);
  headers?: Headers | ((request: RequestParameters) => Promise<Headers>);
}

export class ServerError extends Error {}

// TODO: config
// retries

export function createFetchQuery(config: Configuration): FetchFunction {
  return async function fetchQuery(
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

    // TODO: make url configurable

    // TODO: headers
    try {
      const {files, clone: variablesClone} = extractFiles(
        {
          ...variables,
        },
        isExtractableFile,
      );

      let resp: Response;

      if (files.size > 0) {
        resp = await postMultipart(
          url,
          request,
          variablesClone,
          headers,
          files,
        );
      } else {
        resp = await postJson(url, request, variables, headers);
      }

      const contentType = resp.headers.get("content-type");

      if (contentType == null) {
        throw new ServerError(`Missing content-type on response`);
      } else if (contentType.startsWith("application/json")) {
        // TODO: handle failure
        // TODO: inspect header type
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
      } else {
        // TODO
        throw ex;
      }
    }
  };
}

async function postJson(
  url: string,
  request: RequestParameters,
  variables: Variables,
  headers: Headers,
): Promise<Response> {
  return ky.post(url, {
    json: {
      query: request.text,
      operationName: request.name,
      variables,
      // extensions
    },
    method: "POST",
    headers,
  });
}

async function postMultipart(
  url: string,
  request: RequestParameters,
  variables: Variables,
  headers: Headers,
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
        // extensions
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
    body,
    method: "POST",
    headers,
  });
}
