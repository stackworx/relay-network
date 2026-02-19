/* eslint-disable @typescript-eslint/no-empty-function */
import {graphql, HttpResponse} from "msw";
import {setupServer} from "msw/node";
import {Network} from "relay-runtime";
import {afterAll, beforeAll, beforeEach, expect, test, vi} from "vitest";

import {fail} from "assert";
import {createFetchQuery} from "../main";

const graphqlHandlers = [
  graphql.query("MyQuery", () => {
    return HttpResponse.json(
      {data: {name: "Name"}},
      {
        headers: {
          "Content-Type": "application/graphql-response+json",
        },
      },
    );
  }),

  graphql.query("NetworkError", () => {
    // MSW uses "Response.error()" semantics to simulate a network error.
    // It doesn't carry MSW's strict body typing, so we intentionally cast.
    return HttpResponse.error() as any;
  }),

  graphql.query("UserCredentialsExpired", () => {
    return HttpResponse.json(
      {data: null},
      {
        status: 403,
        headers: {
          "Content-Type": "text/plain",
        },
      },
    );
  }),

  graphql.query("QueryWithBadContentType", () => {
    return HttpResponse.json(
      {data: {name: "Name"}},
      {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
        },
      },
    );
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
  const network = Network.create(
    createFetchQuery({
      url: `http://localhost/graphql`,
      async handleLogout() {},
      allowApplicationJsonContentType: true,
    }),
  );

  const result = await network
    .execute(
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
    )
    .toPromise();
  expect(result).toMatchObject({
    data: {name: "Name"},
  });
});

test("network error", async () => {
  const network = Network.create(
    createFetchQuery({
      url: `http://localhost/graphql`,
      async handleLogout() {},
    }),
  );

  try {
    await network
      .execute(
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
      )
      .toPromise();
    fail("exception not thrown");
  } catch (ex) {
    if (ex instanceof Error) {
      expect(ex.message).toMatch(/Failed to fetch|fetch failed/i);
    } else {
      throw ex;
    }
  }
});

test("network error", async () => {
  const network = Network.create(
    createFetchQuery({
      url: `http://localhost/graphql`,
      async handleLogout() {},
    }),
  );

  try {
    await network
      .execute(
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
      )
      .toPromise();
    fail("exception not thrown");
  } catch (ex) {
    if (ex instanceof Error) {
      expect(ex.message).toMatch("Unhandled content-type text/plain on");
    } else {
      throw ex;
    }
  }
});

test("user expired", async () => {
  const handleLogoutMock = vi.fn();
  const network = Network.create(
    createFetchQuery({
      url: `http://localhost/graphql`,
      handleLogout: handleLogoutMock,
    }),
  );

  try {
    await network
      .execute(
        {
          id: null,
          cacheID: "",
          name: "myquery",
          operationKind: "query",
          text: "query UserCredentialsExpired { name }",
          metadata: {},
        },
        {},
        {},
        null,
      )
      .toPromise();
    fail("exception not thrown");
  } catch (ex) {
    if (ex instanceof Error) {
      expect(handleLogoutMock).toHaveBeenCalledTimes(1);
    } else {
      throw ex;
    }
  }
});
