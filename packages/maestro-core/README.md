# maestro-core

Runtime kernel for the Maestro agent platform. In-process tool-calling runtime with port-based governance — model-agnostic, transport-agnostic, framework-agnostic kernel that powers user-support chat and tool calling for SaaS products.

`0.1.0` ships:

- `ToolEnvelope<T>` — uniform success/failure shape every tool returns
- `defineAgentTool<TInput, TOutput, TCtx>` — tool definition factory with generic context extension
- `BaseToolContext` — extensible per-request context
- 8 port interfaces: `TurnStore`, `AuditStore`, `MemoryStore`, `QuotaStore`, `ModelKeyProvider`, `TelemetrySink`, `Clock`, `Logger`
- `applyCacheBreakpoints` — Anthropic ephemeral prompt-cache helper
- `captureToolException` — observability hook for tool execute exceptions
- AI SDK adapter (`maestro-core/adapters/ai-sdk`) — wraps registry into `ToolSet` with audit + cache breakpoint
- MCP server adapter (`maestro-core/adapters/mcp-server`) — registers the same registry on an MCP server

`runChatTurn` (the full streaming orchestrator) lands in `0.2.0`.

## Install

```bash
pnpm add maestro-core zod
# optional, for the AI SDK adapter:
pnpm add ai
# optional, for the MCP server adapter:
pnpm add @modelcontextprotocol/sdk
```

## Quickstart

```ts
import { ok, err, defineAgentTool, type BaseToolContext } from 'maestro-core'
import { z } from 'zod'

type MyCtx = BaseToolContext & { role: 'admin' | 'guest' }

export const lookupTool = defineAgentTool<z.ZodObject<{ id: z.ZodNumber }>, { name: string }, MyCtx>({
    name: 'lookup',
    description: 'Look up a record by id. Admin only.',
    transports: ['chat'],
    inputSchema: z.object({ id: z.number() }),
    isAvailable: (ctx) => ctx.role === 'admin',
    execute: async (input, ctx) => {
        if (input.id === 0) return err('NOT_FOUND', 'no such record')
        return ok({ name: `record-${input.id}` })
    },
})
```

## Design

See [DESIGN.md](https://github.com/costasoftware/maestro/blob/main/DESIGN.md) for the architecture, port interfaces, and migration roadmap.

## License

Apache-2.0
