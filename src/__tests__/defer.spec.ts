import {describe, expect, test} from "vitest";

import {emitRelayCompatiblePayload, extractBoundary, MultipartMixedError, streamMultipartMixed} from "../defer";

describe("extractBoundary", () => {
  test("parses a quoted boundary", () => {
    expect(extractBoundary(`multipart/mixed; boundary="gc0p4Jq0M2Yt08j"`)).toBe(
      "gc0p4Jq0M2Yt08j",
    );
  });

  test("parses an unquoted boundary", () => {
    expect(extractBoundary("multipart/mixed; boundary=-")).toBe("-");
  });

  test("parses a boundary regardless of parameter order", () => {
    expect(
      extractBoundary(`multipart/mixed; deferSpec=20220824; boundary="abc"`),
    ).toBe("abc");
  });

  test("returns null when no boundary is present", () => {
    expect(extractBoundary("multipart/mixed")).toBeNull();
  });
});

describe("emitRelayCompatiblePayload", () => {
  test("passes through a payload without an incremental array", () => {
    const payloads: unknown[] = [];
    const payload = {data: {name: "Name"}, hasNext: false};

    emitRelayCompatiblePayload(payload as any, (p) => payloads.push(p));

    expect(payloads).toEqual([payload]);
  });

  test("splits a combined incremental payload into base + patches", () => {
    const payloads: any[] = [];

    emitRelayCompatiblePayload(
      {
        data: {products: [{id: "1"}]},
        hasNext: true,
        incremental: [
          {data: {name: "Deferred"}, label: "test", path: ["products", 0]},
        ],
      } as any,
      (p) => payloads.push(p),
    );

    expect(payloads).toHaveLength(2);
    // Base payload is emitted without the incremental array.
    expect(payloads[0]).toEqual({data: {products: [{id: "1"}]}, hasNext: true});
    expect(payloads[0]).not.toHaveProperty("incremental");
    // Each incremental item becomes its own Relay-shaped patch.
    expect(payloads[1]).toMatchObject({
      data: {name: "Deferred"},
      label: "test",
      path: ["products", 0],
    });
  });

  test("emits incremental items carrying only errors", () => {
    const payloads: any[] = [];

    emitRelayCompatiblePayload(
      {
        incremental: [{errors: [{message: "boom"}], label: "e", path: ["x"]}],
      } as any,
      (p) => payloads.push(p),
    );

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({errors: [{message: "boom"}], path: ["x"]});
  });

  test("skips null items and items without data or errors", () => {
    const payloads: any[] = [];

    emitRelayCompatiblePayload(
      {
        incremental: [null, {label: "empty", path: ["y"]}],
      } as any,
      (p) => payloads.push(p),
    );

    expect(payloads).toHaveLength(0);
  });
});

describe("streamMultipartMixed", () => {
  function multipartResponse(parts: object[], boundary: string, chunkSize = 32) {
    const body = parts
      .map(
        (part) =>
          `--${boundary}\r\n`
          + "Content-Type: application/json; charset=utf-8\r\n\r\n"
          + `${JSON.stringify(part)}\r\n`,
      )
      .join("")
      + `--${boundary}--\r\n`;

    const encoder = new TextEncoder();
    const bytes = encoder.encode(body);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.slice(i, i + chunkSize));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {"Content-Type": `multipart/mixed; boundary="${boundary}"`},
    });
  }

  test("parses each part across chunk boundaries", async () => {
    const payloads: any[] = [];
    await streamMultipartMixed(
      multipartResponse(
        [{data: {a: 1}, hasNext: true}, {data: {b: 2}, hasNext: false}],
        "boundary",
        16,
      ),
      "boundary",
      (p) => payloads.push(p),
    );

    expect(payloads).toEqual([
      {data: {a: 1}, hasNext: true},
      {data: {b: 2}, hasNext: false},
    ]);
  });

  test("handles a single part delivered in one chunk", async () => {
    const payloads: any[] = [];
    await streamMultipartMixed(
      multipartResponse([{data: {only: true}}], "-", 4096),
      "-",
      (p) => payloads.push(p),
    );

    expect(payloads).toEqual([{data: {only: true}}]);
  });

  test("throws MultipartMixedError when the response has no body", async () => {
    await expect(
      streamMultipartMixed(new Response(null), "boundary", () => {}),
    ).rejects.toBeInstanceOf(MultipartMixedError);
  });

  test("routes a missing body to onError when provided", async () => {
    let captured: Error | undefined;
    await streamMultipartMixed(
      new Response(null),
      "boundary",
      () => {},
      (error) => {
        captured = error;
      },
    );

    expect(captured).toBeInstanceOf(MultipartMixedError);
  });
});
