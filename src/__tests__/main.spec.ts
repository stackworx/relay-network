import {graphql} from "msw";
import {setupServer} from "msw/node";
import {afterAll, beforeAll, beforeEach, expect, test} from "vitest";

import {fail} from "assert";
import {createFetchQuery} from "../main";

const graphqlHandlers = [
  graphql.query("MyQuery", (_req, res, ctx) => {
    return res(ctx.data({name: "Name"}));
  }),

  graphql.query("NetworkError", (_req, res, _ctx) => {
    return res.networkError("failed to fetch");
  }),

  graphql.query("QueryWithBadContentType", (_req, res, ctx) => {
    // TODO: this does not work
    // return res(
    //   ctx.data({ name: "Name" }),
    //   ctx.set("Content-Type", "text/plain")
    // );
    return res(ctx.set("Content-Type", "text/plain"));
  }),
];

const server = setupServer(...graphqlHandlers);

// Start server before all tests
beforeAll(() =>
  server.listen({
    onUnhandledRequest: "error",
  })
);

//  Close server after all tests
afterAll(() => server.close());

// Reset handlers after each test `important for test isolation`
beforeEach(() => server.resetHandlers());

test("query", async () => {
  const fetchQuery = createFetchQuery({url: `http://localhost/graphql`});

  const result = await fetchQuery(
    {
      id: null,
      cacheID: "",
      name: "myquery",
      operationKind: "query",
      text: "query MyQuery { name }",
      metadata: {},
    },
    {},
    {},
    null,
  );
  expect(result).toMatchObject({
    data: {},
  });
});

test("network error", async () => {
  const fetchQuery = createFetchQuery({url: `http://localhost/graphql`});

  try {
    await fetchQuery(
      {
        id: null,
        cacheID: "",
        name: "myquery",
        operationKind: "query",
        text: "query NetworkError { name }",
        metadata: {},
      },
      {},
      {},
      null,
    );
    fail("exception not thrown");
  } catch (ex) {
    if (ex instanceof Error) {
      expect(ex.message).toMatch("failed to fetch");
    } else {
      throw ex;
    }
  }
});

test("network error", async () => {
  const fetchQuery = createFetchQuery({url: `http://localhost/graphql`});

  try {
    await fetchQuery(
      {
        id: null,
        cacheID: "",
        name: "myquery",
        operationKind: "query",
        text: "query QueryWithBadContentType { name }",
        metadata: {},
      },
      {},
      {},
      null,
    );
    fail("exception not thrown");
  } catch (ex) {
    if (ex instanceof Error) {
      expect(ex.message).toMatch("Unhandled content-type text/plain on");
    } else {
      throw ex;
    }
  }
});
