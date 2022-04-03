import {
  CacheConfig,
  FetchFunction,
  GraphQLResponse,
  RequestParameters,
  UploadableMap,
  Variables,
} from "relay-runtime";
import ky, { HTTPError } from "ky";

interface Configuration {
  url: string;
}

export class ServerError extends Error {}

export function createFetchQuery({ url }: Configuration): FetchFunction {
  return async function fetchQuery(
    request: RequestParameters,
    variables: Variables,
    _cacheConfig: CacheConfig,
    _uploadables?: UploadableMap | null
  ): Promise<GraphQLResponse> {
    // TODO: make url configurable

    try {
      // TODO: handle form multi-part
      const resp = await ky.post(url, {
        json: {
          query: request.text,
          operationName: request.name,
          variables,
        },
        headers: {
          // Add authentication and other headers here
        },
      });

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
          `Unhandled content-type ${contentType} on response`
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
              `Unhandled content-type ${contentType} on response`
            );
        }
      } else {
        // TODO
        throw ex;
      }
    }
  };
}
