import type {GraphQLResponse} from "relay-runtime";

type Headers = Record<string, string | undefined>;

export class MultipartMixedError extends Error {
  constructor(public status?: number, message?: string, public response?: string) {
    super(message);
  }
}

export function extractBoundary(contentType: string): string | null {
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

/**
 * Relay Runtime (17.x) expects incremental patches as individual payloads with
 * top-level `label` + `path`.
 *
 * Some GraphQL servers return incremental delivery as a single payload with an
 * `incremental: [...]` array.
 *
 * This normalizes that server shape into Relay-compatible payloads.
 */
export function emitRelayCompatiblePayload(
  payload: GraphQLResponse,
  onPayload: (payload: GraphQLResponse) => void,
): void {
  const {incremental} = payload as any;
  if (!Array.isArray(incremental)) {
    onPayload(payload);
    return;
  }

  const hasBaseData = (payload as any).data != null || (payload as any).errors != null;
  if (hasBaseData) {
    const {incremental: _incremental, ...rest} = payload as any;
    onPayload(rest as GraphQLResponse);
  }

  for (const item of incremental) {
    if (!item) {
      continue;
    }

    const patch: any = {
      data: item.data,
      errors: item.errors,
      extensions: item.extensions,
      label: item.label,
      path: item.path,
    };

    if (patch.data == null && patch.errors == null) {
      continue;
    }

    onPayload(patch as GraphQLResponse);
  }
}

export async function streamMultipartMixed(
  response: Response,
  boundary: string,
  onPayload: (payload: GraphQLResponse) => void,
  onError?: (error: Error) => void,
): Promise<void> {
  if (!response.body) {
    const text = await response.text();
    const error = new MultipartMixedError(response.status, "Missing response body", text);
    if (onError) {
      onError(error);
      return;
    }
    throw error;
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
