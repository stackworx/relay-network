# Contributing

Thanks for your interest in contributing!

## Development

```bash
npm ci
```

Useful scripts:

| Script               | Description                       |
| -------------------- | --------------------------------- |
| `npm test`           | Run tests in watch mode (vitest). |
| `npm test -- --run`  | Run tests once.                   |
| `npm run coverage`   | Run tests with coverage.          |
| `npm run typecheck`  | Type-check with `tsc`.            |
| `npm run lint`       | Lint with ESLint.                 |
| `npm run fmt`        | Format with dprint.               |
| `npm run fmt:check`  | Check formatting.                 |
| `npm run build`      | Build with tsdown.                |

## Pull requests

1. Fork the repo and create a branch off `main`.
2. Make your change, adding tests where it makes sense.
3. Ensure `npm run fmt:check`, `npm run typecheck`, `npm run lint`, and
   `npm run test -- --run` all pass (this is what CI runs).
4. Open a pull request describing the change.

## Releasing

Releases are published to npm by the `Release` GitHub Actions workflow when a
GitHub Release is published. Bump the version in `package.json`, tag the
release, and publish it — CI handles `npm publish`.

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC), so there is no `NPM_TOKEN` secret. The package's trusted publisher on
npmjs.com must point at this repo and the `Release` workflow. Provenance is
generated automatically.
