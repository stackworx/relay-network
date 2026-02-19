# Relay Network

A Relay Network using [ky](https://github.com/sindresorhus/ky)


## See 

- https://spec.graphql.org/June2018/
- https://graphql.github.io/graphql-over-http/draft/
- https://github.com/jaydenseric/graphql-multipart-request-spec (Unofficial)

### Defer

- https://github.com/graphql/graphql-over-http/blob/main/rfcs/IncrementalDelivery.md

#### Why we normalize incremental payloads

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
top-level `label` and `path`. If you forward the RFC-style payload as-is, Relay
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

# Usage

```bash
npm add @stackworx.io/relay-network
```

```tsx
import {Network} from "relay-runtime";
import {createFetchQuery} from '@stackworx.io/relay-network';


const network = Network.create(
    createFetchQuery({
        url: `http://localhost/graphql`,
        
        // Defaults
        timeout: 10000,

        // Defaults
        retry: {
            statusCodes: [503],
            methods: ["get"],
            limit: 2,
        },
        // Check if we should log the user out
        // Optional
        logoutCheck?(response: Response): {
            // default behaviour
            return response.status === 403;
        },
        // React to user credentials expired. E.g. clear store, delete tokens
        // Optional
        async handleLogout() {
            // ...
        },
    }));
```

## MSW 

https://github.com/mswjs/msw/issues/1388#issuecomment-1344382071