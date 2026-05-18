# @maestro/react

React surface for the [Maestro](https://github.com/costasoftware/maestro) agent runtime.

## Status

`0.0.0` — pre-release. P1 of a 6-phase rollout extracting React chat surfaces shared across multiple SaaS products with different backends (AI SDK v6, custom Node SSE, custom FastAPI SSE).

This first release ships **only** the `MaestroChatProtocol` — a wire-format-neutral event vocabulary that every backend either implements natively or adapts via a transport. Hooks, components, and AI-SDK transport land in later phases:

| Phase | Ships |
| --- | --- |
| **P1 (this PR)** | `MaestroChatProtocol` types + `MAESTRO_CHAT_PROTOCOL.md` spec |
| P2 | AI-SDK v6 transport adapter (barbeiro consumer) |
| P3 | `useMaestroChat()` hook + headless message-state machine |
| P4 | Trading-rag native (FastAPI) adoption — validates the protocol against a non-TS implementation |
| P5 | Shared UI primitives (tool cards, citation chips, progress affordances) |
| P6 | Custom Node SSE transport (numenion consumer) |

## What's in 0.0.0

```ts
import {
    type MaestroEvent,
    MAESTRO_PROTOCOL_VERSION,
    assertNever,
} from '@maestro/react'
```

The TS union in [`src/protocol.ts`](./src/protocol.ts) IS the spec for TS consumers. Decision rationale lives next to each event.

For backends NOT written in TS, see the language-neutral spec at the repo root: [`MAESTRO_CHAT_PROTOCOL.md`](../../MAESTRO_CHAT_PROTOCOL.md). It includes a Python reference helper using `sse_starlette` + Pydantic.

## Protocol version

`0.1.0-beta` — the shape is locked only after P4 (trading-rag native adoption) validates it against a non-TS implementation. Additive event-type additions ship as minor bumps; renames/removals are major.

## Install

```bash
pnpm add @maestro/react
```

No runtime dependencies in 0.0.0. React is an OPTIONAL peer for forward compatibility with later phases.

## License

Apache-2.0
