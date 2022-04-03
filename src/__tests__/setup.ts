// Fetch is already available as an experimental feature in Node v17.
import fetch, {
  // Blob,
  // blobFrom,
  // blobFromSync,
  // File,
  // fileFrom,
  // fileFromSync,
  // FormData,
  Headers,
  Request,
  Response,
} from "node-fetch";

if (!globalThis.fetch) {
  // @ts-expect-error polyfill
  globalThis.fetch = fetch;
}

if (!globalThis.Headers) {
  // @ts-expect-error polyfill
  globalThis.Headers = Headers;
}

if (!globalThis.Request) {
  // @ts-expect-error polyfill
  globalThis.Request = Request;
}

if (!globalThis.Response) {
  // @ts-expect-error polyfill
  globalThis.Response = Response;
}
