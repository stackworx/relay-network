# Relay Network

A Relay Network using [ky](https://github.com/sindresorhus/ky)


## See 

- https://spec.graphql.org/June2018/
- https://graphql.github.io/graphql-over-http/draft/
- https://github.com/jaydenseric/graphql-multipart-request-spec (Unofficial)

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

        // React to user credentials expired. E.g. clear store
        async handleLogout() {
        // ...
        },
    }));

```