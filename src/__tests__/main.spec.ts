import {graphql, http, HttpResponse} from "msw";
import {setupServer} from "msw/node";
import {Network} from "relay-runtime";
import type {RequestParameters} from "relay-runtime";
import {afterAll, beforeAll, beforeEach, describe, expect, test, vi} from "vitest";

import {createFetchQuery} from "../main";

function fail(message: string): never {
  throw new Error(message);
}

const GRAPHQL_JSON = "application/graphql-response+json";

function makeRequest(overrides: Record<string, unknown> = {}): RequestParameters {
  // RequestParameters is a union (persisted vs. text), so build loosely and cast.
  return {
    id: null,
    cacheID: "",
    name: "MyQuery",
    operationKind: "query",
    text: "query MyQuery { name }",
    metadata: {},
    ...overrides,
  } as RequestParameters;
}

/** Execute a request to completion, collecting every emitted payload. */
function collect(
  config: Parameters<typeof createFetchQuery>[0],
  request: RequestParameters,
  variables: Record<string, unknown> = {},
): Promise<any[]> {
  const network = Network.create(createFetchQuery(config));
  const results: any[] = [];
  return new Promise((resolve, reject) => {
    network.execute(request, variables, {}, null).subscribe({
      next: (value) => results.push(value),
      error: reject,
      complete: () => resolve(results),
    });
  });
}

const graphqlHandlers = [
  graphql.query("MyQuery", () =>
    HttpResponse.json({data: {name: "Name"}}, {
      headers: {"Content-Type": GRAPHQL_JSON},
    })),

  graphql.query(
    "DeferQuery",
    (() => {
      const boundary = "-";
      const part1 = {
        data: {products: [{id: "UHJvZHVjdAppNw=="}, {id: "UHJvZHVjdAppMjE="}]},
        hasNext: true,
      };
      const part2 = {
        incremental: [
          {
            data: {exportName: "Kolomela 63.5%, 8mm Fine Ore"},
            label: "test",
            path: ["products", 1],
          },
        ],
        hasNext: false,
      };

      const multipartBody = [
        `--${boundary}\r\n`
        + "Content-Type: application/json; charset=utf-8\r\n\r\n"
        + `${JSON.stringify(part1)}\r\n`,
        `--${boundary}\r\n`
        + "Content-Type: application/json; charset=utf-8\r\n\r\n"
        + `${JSON.stringify(part2)}\r\n`,
        `--${boundary}--\r\n`,
      ].join("");

      const encoder = new TextEncoder();
      const chunks = [
        multipartBody.slice(0, 25),
        multipartBody.slice(25, 80),
        multipartBody.slice(80),
      ];

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      return new HttpResponse(stream as any, {
        headers: {"Content-Type": `multipart/mixed; boundary="${boundary}"`},
      }) as any;
    }) as any,
  ),

  graphql.query("NetworkError", () => HttpResponse.error() as any),

  graphql.query("UserCredentialsExpired", () =>
    HttpResponse.json({data: null}, {
      status: 403,
      headers: {"Content-Type": "text/plain"},
    })),

  graphql.query("QueryWithBadContentType", () =>
    HttpResponse.json({data: {name: "Name"}}, {
      status: 200,
      headers: {"Content-Type": "text/plain"},
    })),
];

const server = setupServer(...graphqlHandlers);

beforeAll(() => server.listen({onUnhandledRequest: "error"}));
afterAll(() => server.close());
beforeEach(() => server.resetHandlers());

describe("responses", () => {
  test("parses an application/graphql-response+json query", async () => {
    const results = await collect(
      {url: "http://localhost/graphql", allowApplicationJsonContentType: true},
      makeRequest(),
    );

    expect(results).toEqual([{data: {name: "Name"}}]);
  });

  test("streams incremental defer payloads from multipart/mixed", async () => {
    const results = await collect(
      {url: "http://localhost/graphql", allowApplicationJsonContentType: true},
      makeRequest({name: "DeferQuery", text: "query DeferQuery { products { id } }"}),
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      data: {products: [{id: "UHJvZHVjdAppNw=="}, {id: "UHJvZHVjdAppMjE="}]},
      hasNext: true,
    });
    expect(results[1]).toMatchObject({
      data: {exportName: "Kolomela 63.5%, 8mm Fine Ore"},
      label: "test",
      path: ["products", 1],
    });
  });

  test("resolves the url from a function", async () => {
    server.use(
      http.get("http://localhost/from-fn", () =>
        HttpResponse.json({data: {name: "FromFn"}}, {
          headers: {"Content-Type": GRAPHQL_JSON},
        })),
    );

    const results = await collect(
      {url: async () => "http://localhost/from-fn", allowApplicationJsonContentType: true},
      makeRequest(),
    );

    expect(results).toEqual([{data: {name: "FromFn"}}]);
  });

  test("sends a query as a GET request carrying the operation in search params", async () => {
    let method: string | undefined;
    let params: URLSearchParams | undefined;
    server.use(
      http.get("http://localhost/wire", ({request}) => {
        method = request.method;
        params = new URL(request.url).searchParams;
        return HttpResponse.json({data: {name: "ok"}}, {
          headers: {"Content-Type": GRAPHQL_JSON},
        });
      }),
    );

    await collect({url: "http://localhost/wire"}, makeRequest());

    expect(method).toBe("GET");
    expect(params?.get("query")).toBe("query MyQuery { name }");
    expect(params?.get("operationName")).toBe("MyQuery");
    expect(params?.get("variables")).toBe("{}");
  });

  test("sends a mutation as a JSON POST body", async () => {
    let method: string | undefined;
    let body: any;
    server.use(
      http.post("http://localhost/mutate", async ({request}) => {
        method = request.method;
        body = await request.json();
        return HttpResponse.json({data: {ok: true}}, {
          headers: {"Content-Type": GRAPHQL_JSON},
        });
      }),
    );

    await collect(
      {url: "http://localhost/mutate"},
      makeRequest({text: "mutation Go { ok }", operationKind: "mutation"}),
    );

    expect(method).toBe("POST");
    expect(body).toMatchObject({query: "mutation Go { ok }", variables: {}});
  });
});

describe("headers", () => {
  test("applies headers produced by a function", async () => {
    let authHeader: string | null = null;
    server.use(
      http.get("http://localhost/auth", ({request}) => {
        authHeader = request.headers.get("authorization");
        return HttpResponse.json({data: {name: "ok"}}, {
          headers: {"Content-Type": GRAPHQL_JSON},
        });
      }),
    );

    await collect(
      {
        url: "http://localhost/auth",
        headers: async () => ({authorization: "Bearer token"}),
      },
      makeRequest(),
    );

    expect(authHeader).toBe("Bearer token");
  });
});

describe("content-type handling", () => {
  test("rejects application/json unless explicitly allowed", async () => {
    server.use(
      http.get("http://localhost/json", () => HttpResponse.json({data: {name: "Name"}})),
    );

    await expect(collect({url: "http://localhost/json"}, makeRequest())).rejects
      .toThrow(/Unhandled content-type application\/json/);
  });

  test("accepts application/json when allowApplicationJsonContentType is set", async () => {
    server.use(
      http.get("http://localhost/json", () => HttpResponse.json({data: {name: "Name"}})),
    );

    const results = await collect(
      {url: "http://localhost/json", allowApplicationJsonContentType: true},
      makeRequest(),
    );

    expect(results).toEqual([{data: {name: "Name"}}]);
  });

  test("throws ServerError on a 200 with an unhandled content-type", async () => {
    await expect(
      collect(
        {url: "http://localhost/graphql"},
        makeRequest({
          name: "QueryWithBadContentType",
          text: "query QueryWithBadContentType { name }",
        }),
      ),
    ).rejects.toThrow(/Unhandled content-type text\/plain/);
  });

  test("throws ServerError when a 200 has no content-type", async () => {
    server.use(
      http.get("http://localhost/empty", () => new HttpResponse(null, {status: 200})),
    );

    await expect(collect({url: "http://localhost/empty"}, makeRequest())).rejects
      .toThrow(/Missing content-type/);
  });
});

describe("deleteDataIfError", () => {
  test("drops data when a payload carries both data and errors", async () => {
    server.use(
      http.get("http://localhost/partial", () =>
        HttpResponse.json(
          {data: {name: "Name"}, errors: [{message: "bad"}]},
          {headers: {"Content-Type": GRAPHQL_JSON}},
        )),
    );

    const results = await collect({url: "http://localhost/partial"}, makeRequest());

    expect(results).toHaveLength(1);
    expect(results[0]).not.toHaveProperty("data");
    expect(results[0]).toMatchObject({errors: [{message: "bad"}]});
  });
});

describe("file uploads", () => {
  test("sends a graphql-multipart request with a preflight header", async () => {
    let operations: string | null = null;
    let map: string | null = null;
    let fileText: string | null = null;
    let preflight: string | null = null;

    server.use(
      http.post("http://localhost/upload", async ({request}) => {
        preflight = request.headers.get("graphql-preflight");
        const form = await request.formData();
        operations = form.get("operations") as string;
        map = form.get("map") as string;
        const file = form.get("1");
        fileText = file instanceof File ? await file.text() : null;
        return HttpResponse.json({data: {ok: true}}, {
          headers: {"Content-Type": GRAPHQL_JSON},
        });
      }),
    );

    const results = await collect(
      {url: "http://localhost/upload"},
      makeRequest({text: "mutation Upload { ok }", operationKind: "mutation"}),
      {file: new File(["hello"], "hello.txt", {type: "text/plain"})},
    );

    expect(preflight).toBe("1");
    expect(JSON.parse(operations!)).toMatchObject({query: "mutation Upload { ok }"});
    expect(JSON.parse(map!)).toEqual({"1": ["variables.file"]});
    expect(fileText).toBe("hello");
    expect(results).toEqual([{data: {ok: true}}]);
  });
});

describe("retry", () => {
  test("retries a retriable request until it succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get("http://localhost/retry", () => {
        attempts += 1;
        if (attempts < 2) {
          return new HttpResponse("unavailable", {
            status: 503,
            headers: {"Content-Type": "text/plain"},
          });
        }
        return HttpResponse.json({data: {name: "ok"}}, {
          headers: {"Content-Type": GRAPHQL_JSON},
        });
      }),
    );

    const results = await collect(
      {
        url: "http://localhost/retry",
        // Queries are sent as GET, so "get" is the retriable method.
        retry: {limit: 3, methods: ["get"], statusCodes: [503], delay: () => 0},
      },
      makeRequest(),
    );

    expect(attempts).toBe(2);
    expect(results).toEqual([{data: {name: "ok"}}]);
  });

  test("never retries mutations", async () => {
    let attempts = 0;
    server.use(
      http.post("http://localhost/no-retry", () => {
        attempts += 1;
        return new HttpResponse("unavailable", {
          status: 503,
          headers: {"Content-Type": "text/plain"},
        });
      }),
    );

    await expect(
      collect(
        {
          url: "http://localhost/no-retry",
          retry: {limit: 3, methods: ["post"], statusCodes: [503], delay: () => 0},
        },
        makeRequest({text: "mutation Upload { ok }", operationKind: "mutation"}),
      ),
    ).rejects.toThrow();

    expect(attempts).toBe(1);
  });
});

describe("logout handling", () => {
  test("calls handleLogout on the default 403 check", async () => {
    const handleLogout = vi.fn();

    await expect(
      collect(
        {url: "http://localhost/graphql", handleLogout},
        makeRequest({
          name: "UserCredentialsExpired",
          text: "query UserCredentialsExpired { name }",
        }),
      ),
    ).rejects.toThrow();

    expect(handleLogout).toHaveBeenCalledTimes(1);
  });

  test("honours a custom logoutCheck", async () => {
    const handleLogout = vi.fn();
    server.use(
      http.get("http://localhost/teapot", () =>
        new HttpResponse("nope", {
          status: 418,
          headers: {"Content-Type": "text/plain"},
        })),
    );

    await expect(
      collect(
        {
          url: "http://localhost/teapot",
          handleLogout,
          logoutCheck: (response) => response.status === 418,
        },
        makeRequest(),
      ),
    ).rejects.toThrow();

    expect(handleLogout).toHaveBeenCalledTimes(1);
  });

  test("does not call handleLogout for unrelated error statuses", async () => {
    const handleLogout = vi.fn();
    server.use(
      http.get("http://localhost/bad-request", () =>
        new HttpResponse("bad", {
          status: 400,
          headers: {"Content-Type": "text/plain"},
        })),
    );

    await expect(
      collect({url: "http://localhost/bad-request", handleLogout}, makeRequest()),
    ).rejects.toThrow();

    expect(handleLogout).not.toHaveBeenCalled();
  });
});

describe("errors", () => {
  test("wraps fetch network failures", async () => {
    try {
      await collect(
        {url: "http://localhost/graphql"},
        makeRequest({name: "NetworkError", text: "query NetworkError { name }"}),
      );
      fail("exception not thrown");
    } catch (ex) {
      // ky v2 wraps fetch network failures in its own NetworkError.
      expect((ex as Error).message).toMatch(/network error/i);
    }
  });

  test("rejects persisted queries (missing request text)", async () => {
    await expect(
      collect({url: "http://localhost/graphql"}, makeRequest({text: null})),
    ).rejects.toThrow(/Persisted Queries are not supported/);
  });
});
