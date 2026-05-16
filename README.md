# Maestro

In-process tool-calling agent runtime for SaaS products. Powers user-support chat with tool calling, shared governance (quota, cost, audit, memory), and pluggable model routing — without a remote gateway hop.

## Packages

| Package | Purpose |
| --- | --- |
| `@costasoftware/maestro-core` | Runtime kernel — `defineAgentTool`, `ToolEnvelope`, `BaseToolContext`, AI SDK + MCP adapters, port interfaces. |

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
