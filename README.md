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