# maestro-core

In-process tool-calling agent runtime for SaaS products. Model-agnostic, transport-agnostic, framework-agnostic kernel with port-based governance — powers user-support chat with shared quota, cost, audit, memory, and prompt-cache machinery without a remote gateway hop.

## What ships

### `0.2.0` (current)

- **`runChatTurn`** — one call replaces ~300 LoC of stream orchestration. Pre-call quota gate, model selection, AI SDK tool building, prompt-cache breakpoints, memory injection, turn-row persistence, post-call accounting, SSE response. Lives at `maestro-core/runtime`.
- Quota gate: `AiQuotaDeniedError`, `enforceQuotaOrThrow`, `checkAndEnforce`
- Memory load + format: `loadMemoryBlock`, `formatMemoryBlock`
- Empty-recovery decision: `decideEmptyRecovery`
- Provider fallback helpers: `shouldFallback`, `mapModelIdToOpenAI`
- Window-math helpers for `QuotaStore` impls: `dailyTokensWindow`, `hourlyToolCallsWindow`, etc.
- Model router: `selectChatModel` (fast/smart heuristic, configurable thresholds)
- Cost estimator: `estimateCost` with built-in Anthropic + OpenAI pricing

### `0.1.x` (carried forward)

- `ToolEnvelope<T>` — uniform success/failure shape every tool returns
- `defineAgentTool<TInput, TOutput, TCtx>` — tool definition factory with generic context extension
- `BaseToolContext` — extensible per-request context
- 8 port interfaces: `TurnStore`, `AuditStore`, `MemoryStore`, `QuotaStore`, `ModelKeyProvider`, `TelemetrySink`, `Clock`, `Logger`
- `applyCacheBreakpoints` — Anthropic ephemeral prompt-cache helper
- `captureToolException` — observability hook for tool execute exceptions
- AI SDK adapter (`maestro-core/adapters/ai-sdk`) — wraps registry into `ToolSet` with audit + cache breakpoint
- MCP server adapter (`maestro-core/adapters/mcp-server`) — registers the same registry on an MCP server

## Install

```bash
pnpm add maestro-core zod
# for the runtime + AI SDK adapter:
pnpm add ai @ai-sdk/anthropic
# for the MCP server adapter:
pnpm add @modelcontextprotocol/sdk
```

## Quickstart — defining a tool

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

## Quickstart — running a chat turn

```ts
import { runChatTurn, AiQuotaDeniedError } from 'maestro-core/runtime'

export async function POST(req: Request) {
    const { messages } = await req.json()
    const ctx: MyCtx = { /* tenantId, principal, transport, locale, timezone, requestId, role */ }

    try {
        return await runChatTurn({
            threadId,
            ctx,
            messages,
            tools: [lookupTool /* ... */],
            systemPrompt: {
                static: 'You are a helpful assistant for record lookups.',
                dynamic: undefined, // optional per-tenant prose; memory facts auto-append
            },
            models: {
                fast: 'claude-haiku-4-5-20251001',
                smart: 'claude-sonnet-4-6',
            },
            ports: {
                turnStore: myTurnStore,
                keyProvider: myKeyProvider,
                auditStore: myAuditStore,
                memoryStore: myMemoryStore, // optional
                quotaStore: myQuotaStore,   // optional but recommended
                telemetry: myTelemetrySink, // defaults to Noop
            },
        })
    } catch (e) {
        if (e instanceof AiQuotaDeniedError) {
            return Response.json(
                { error: 'quota_exceeded', payload: e.payload },
                { status: 429 }
            )
        }
        throw e
    }
}
```

## Provider fallback

`shouldFallback` + `mapModelIdToOpenAI` give you composable retry against OpenAI when Anthropic hits a transient failure:

```ts
import { runChatTurn, shouldFallback, mapModelIdToOpenAI } from 'maestro-core/runtime'

try {
    return await runChatTurn({ ..., models: anthropicModels })
} catch (e) {
    if (shouldFallback(e)) {
        return runChatTurn({
            ...,
            models: {
                fast: mapModelIdToOpenAI(anthropicModels.fast),
                smart: mapModelIdToOpenAI(anthropicModels.smart),
            },
        })
    }
    throw e
}
```

Built-in retry wrapper inside `runChatTurn` is tracked for `0.2.1`.

## Design

See [DESIGN.md](https://github.com/costasoftware/maestro/blob/main/DESIGN.md) for the architecture, port interfaces, migration roadmap, and what's explicitly deferred.

## License

Apache-2.0
