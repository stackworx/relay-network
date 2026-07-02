# Changelog

## 2.0.0

A major release covering dependency upgrades, a reworked configuration surface,
and behavioural fixes. **All items below are breaking** — read the migration
notes before upgrading.

### Migration notes (1.x → 2.0.0)

#### 1. Peer dependencies & Node

- `ky` peer bumped from `>=1.0.0` to **`>=2.0.0`**.
- `relay-runtime` peer bumped from `>=15.0.0` to **`>=17.0.0`**.
- ky 2 requires **Node.js >= 22**.

Update your app's dependencies accordingly:

```bash
npm add ky@^2 relay-runtime@^17   # or newer
```

#### 2. Queries are now sent as `GET`

Previously every operation was sent as a `POST`. Queries are now issued as
`GET`, with the operation encoded in the query string (`query`, `operationName`,
`variables`). Mutations remain `POST`, and any operation carrying file variables
is still a `multipart/form-data` `POST`.

**Action required:** ensure your GraphQL server accepts `GET` for queries (per
the GraphQL-over-HTTP spec). Very large queries may approach URL length limits;
switch such operations to persisted queries or mutations if needed.

As a side effect, the default `retry` policy (`methods: ["get"]`) now actually
applies to queries — retries genuinely happen on `503`, which was silently a
no-op in 1.x (everything was `POST`, which was never in the retry method list).

#### 3. Hooks are consolidated into a single `hooks` option

The three separate hook arrays were replaced by one `hooks` object matching
ky's shape.

```diff
 createFetchQuery({
   url,
-  beforeRequest: [myBeforeRequest],
-  afterResponse: [myAfterResponse],
-  beforeError: [myBeforeError],
+  hooks: {
+    beforeRequest: [myBeforeRequest],
+    afterResponse: [myAfterResponse],
+    beforeError: [myBeforeError],
+  },
 });
```

Note that ky 2 also changed hook signatures: hooks now receive a single state
object (e.g. `({request, options}) => …`, `({error}) => …`) instead of
positional arguments. Update any hook implementations accordingly. The built-in
logout `beforeError` hook is still merged ahead of your `hooks.beforeError`.

#### 4. `deleteDataIfError` is now a real config option

In 1.x this was declared on the config but never read — the behaviour was
hardcoded on via an unreachable positional argument. It is now honoured.

- Default is `true` (unchanged behaviour: when a payload has both `data` and
  `errors`, `data` is dropped so Relay routes it through `onError`).
- Set `deleteDataIfError: false` to emit payloads verbatim.

If you were passing this flag before, it now takes effect — verify that `true`
is what you want.

#### 5. Static `headers` objects are now actually sent

A precedence bug meant that passing a plain `headers` object silently discarded
it (replacing it with only the multipart preflight header). The object form now
works, and the `graphql-preflight: 1` header is merged in for multipart uploads
rather than replacing your headers. The function form
(`headers: async (request) => …`) is unchanged.

#### 6. Network-error message changed

Fetch-level network failures now surface as ky's `NetworkError` with the message
`Request failed due to a network error: <METHOD> <URL>` instead of the raw
`Failed to fetch` / `fetch failed`. Update any code that matches on the old
message text.

### Other changes

- `relay-runtime` bumped to 21; `@types/relay-runtime` dropped (relay-runtime
  now ships its own types).
- Test suite expanded (5 → 31 tests) and code-coverage reporting added to the
  GitHub Actions CI workflow.
