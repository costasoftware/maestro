# Maestro

In-process tool-calling agent runtime for SaaS products. Powers user-support chat with tool calling, shared governance (quota, cost, audit, memory), and pluggable model routing — without a remote gateway hop.

## Packages

| Package | Status | npm |
| --- | --- | --- |
| [`@costasoftware/maestro-core`](./packages/maestro-core) | `1.0.0` released | [npmjs.com/package/@costasoftware/maestro-core](https://www.npmjs.com/package/@costasoftware/maestro-core) |
| [`@costasoftware/maestro-evals`](./packages/maestro-evals) | `1.0.0` released | [npmjs.com/package/@costasoftware/maestro-evals](https://www.npmjs.com/package/@costasoftware/maestro-evals) |
| `@costasoftware/maestro-react` | in progress (PR #12) | — |
| `maestro-eval` | placeholder reserved | — |
| `maestro-mcp` | placeholder reserved | — |
| `maestro-telemetry` | placeholder reserved | — |
| `create-maestro` | placeholder reserved | — |

## Status

`1.x` — the `@costasoftware/*` family is live. Older unscoped names (`maestro-core`, `maestro-evals`) are deprecated; pin the scoped names. SemVer applies from `1.0.0` onward.

## Quickstart

```bash
pnpm install
pnpm build
pnpm test
```

## Design

See [DESIGN.md](./DESIGN.md) for the full architecture, port interfaces, migration plan, and what v1 explicitly does not solve.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
