# Relay Network

[![CI](https://github.com/stackworx/relay-network/actions/workflows/ci.yml/badge.svg)](https://github.com/stackworx/relay-network/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@stackworx.io/relay-network.svg)](https://www.npmjs.com/package/@stackworx.io/relay-network)
[![license](https://img.shields.io/npm/l/@stackworx.io/relay-network.svg)](./LICENSE)

A [Relay](https://relay.dev) Network layer built on [ky](https://github.com/sindresorhus/ky).

Features:

- Queries over `GET`, mutations over `POST`
- File uploads via the [GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec)
- Incremental delivery (`@defer` / `@stream`) over `multipart/mixed`, normalized to Relay-compatible payloads
- Configurable retries, timeouts, and logout handling
- Request/response/error hooks passed through to `ky`

## Installation

```bash
npm add @stackworx.io/relay-network ky relay-runtime
```

`ky` and `relay-runtime` are peer dependencies.

## Usage

```ts
import {Network} from "relay-runtime";
import {createFetchQuery} from "@stackworx.io/relay-network";

const network = Network.create(
  createFetchQuery({
    url: "http://localhost/graphql",

    // Optional
    timeout: 10000,

    // Optional. Queries are retried; mutations never are.
    retry: {
      statusCodes: [503],
      methods: ["get"],
      limit: 2,
    },

    // Optional. Return true when the response means the user should be logged
    // out. Default: response.status === 403
    logoutCheck(response) {
      return response.status === 403;
    },

    // Optional. React to expired credentials, e.g. clear the store or tokens.
    async handleLogout() {
      // ...
    },
  }),
);
```

### Configuration

| Option                            | Type                                                                 | Description                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                             | `string \| (() => Promise<string>)`                                  | GraphQL endpoint, or a function resolving to one.                                                                                                  |
| `headers`                         | `Record<string, string \| undefined> \| ((request) => Promise<...>)` | Static headers, or a function producing them per request.                                                                                          |
| `timeout`                         | `ky` timeout                                                         | Request timeout.                                                                                                                                    |
| `retry`                           | `ky` retry                                                          | Retry config. Applied to queries only, never mutations.                                                                                            |
| `logoutCheck`                     | `(response: Response) => boolean`                                    | Decide whether a response means the user should be logged out. Default: `status === 403`.                                                          |
| `handleLogout`                    | `() => Promise<void> \| void`                                       | Called when `logoutCheck` returns true.                                                                                                            |
| `deleteDataIfError`               | `boolean`                                                           | When a payload has both `data` and `errors`, drop `data` so Relay routes it to `onError`. Useful for servers that return `{}` on failed mutations. |
| `allowApplicationJsonContentType` | `boolean`                                                           | Accept `application/json` responses in addition to `application/graphql-response+json`.                                                            |
| `hooks`                           | `ky` `Hooks`                                                        | ky lifecycle hooks (`beforeRequest`, `afterResponse`, `beforeError`, ...). Merged ahead of the built-in logout `beforeError` hook.                 |

## Incremental delivery (`@defer` / `@stream`)

Some GraphQL servers send incremental delivery payloads in the RFC-style shape:

```json
{
  "incremental": [
    {
      "data": {"exportName": "Kolomela 63.5%, 8mm Fine Ore"},
      "label": "test",
      "path": ["products", 1]
    }
  ],
  "hasNext": false
}
```

Relay Runtime (17.x) treats a payload as an incremental *patch* only if it has
top-level `label` and `path`. If the RFC-style payload is forwarded as-is, Relay
can warn that there was "No data returned" (because there is no top-level
`data`).

This library normalizes the RFC-style payload into Relay-compatible patch
payloads before calling `sink.next(...)`:

```json
{
  "data": {"exportName": "Kolomela 63.5%, 8mm Fine Ore"},
  "label": "test",
  "path": ["products", 1]
}
```

## Using with MSW

When mocking `multipart/mixed` responses with [MSW](https://mswjs.io/), see
https://github.com/mswjs/msw/issues/1388#issuecomment-1344382071.

## References

- [GraphQL spec](https://spec.graphql.org/June2018/)
- [GraphQL over HTTP](https://graphql.github.io/graphql-over-http/draft/)
- [GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec) (unofficial)
- [Incremental Delivery RFC](https://github.com/graphql/graphql-over-http/blob/main/rfcs/IncrementalDelivery.md)

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © Stackworx
