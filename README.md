# Maestro

In-process tool-calling agent runtime for SaaS products. Powers user-support chat with tool calling, shared governance (quota, cost, audit, memory), and pluggable model routing — without a remote gateway hop.

## Packages

| Package | Status | npm |
| --- | --- | --- |
| [`maestro-core`](./packages/maestro-core) | `0.1.0` released | [npmjs.com/package/maestro-core](https://www.npmjs.com/package/maestro-core) |
| `maestro-react` | placeholder reserved | — |
| `maestro-eval` | placeholder reserved | — |
| `maestro-mcp` | placeholder reserved | — |
| `maestro-telemetry` | placeholder reserved | — |
| `create-maestro` | placeholder reserved | — |

## Status

`0.x` — pre-release. Breaking changes allowed until `1.0`. Do not depend on this from production code without pinning an exact version.

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
