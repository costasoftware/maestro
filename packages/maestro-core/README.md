# @maestro/core

In-process tool-calling agent runtime for SaaS products. Model-agnostic, transport-agnostic, framework-agnostic kernel with port-based governance — powers user-support chat with shared quota, cost, audit, memory, and prompt-cache machinery without a remote gateway hop.

## What ships

### `0.2.0` (current)

- **`runChatTurn`** — one call replaces ~300 LoC of stream orchestration. Pre-call quota gate, model selection, AI SDK tool building, prompt-cache breakpoints, memory injection, turn-row persistence, post-call accounting, SSE response. Lives at `@maestro/core/runtime`.
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
- AI SDK adapter (`@maestro/core/adapters/ai-sdk`) — wraps registry into `ToolSet` with audit + cache breakpoint
- MCP server adapter (`@maestro/core/adapters/mcp-server`) — registers the same registry on an MCP server

## Install

```bash
pnpm add @maestro/core zod
# for the runtime + AI SDK adapter:
pnpm add ai @ai-sdk/anthropic
# for the MCP server adapter:
pnpm add @modelcontextprotocol/sdk
```

## Quickstart — defining a tool

```ts
import { ok, err, defineAgentTool, type BaseToolContext } from '@maestro/core'
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

### Heterogeneous tool registry — let TypeScript infer

When you assemble a registry of tools with different `inputSchema` shapes, do NOT pin the array as `AnyAgentToolDefinition<MyCtx>[]`. That type is invariant on `TInput` (it sets `TInput = ZodTypeAny`); each concrete tool's `ZodObject<{...}>` is a sub-type of `ZodTypeAny` but isn't assignable in the wildcard slot:

```ts
// WRONG — TS2322 on every entry; the wildcard isn't bivariant
const registry: AnyAgentToolDefinition<MyCtx>[] = [lookupTool, createTool, deleteTool]

// RIGHT — let inference take the union
const registry = [lookupTool, createTool, deleteTool] as const
// or just:
const registry = [lookupTool, createTool, deleteTool]
```

`runChatTurn`, `buildAiSdkTools`, and `registerMcpTools` all accept the inferred union as-is.

## Quickstart — running a chat turn

```ts
import { runChatTurn, AiQuotaDeniedError } from '@maestro/core/runtime'

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

## Anthropic tool-calling traps

When Anthropic Claude outputs raw `<function_calls><invoke name="...">` XML in its prose response instead of structured tool-use blocks, the model has fallen back to its pre-tool-use training format because something upstream prevented the request from engaging Anthropic's tool-use API path. There are four independent failure modes that all surface as the same symptom. Each one is individually invisible to type checks. All four must be right before shipping.

### Trap 1 — `system` mixed into `messages`

**Symptom:** model emits `<function_calls>` XML in prose; tool blocks never execute.

**Cause:** `@ai-sdk/anthropic` only routes through Anthropic's tool-use API when the system prompt is supplied via the top-level `system:` argument. Pre-pending system entries onto the `messages` array trips a different code path that silently disables tool-use.

**Fix:**

```ts
// WRONG — model outputs <function_calls> in prose
streamText({
    messages: [...systemMessages, ...userMessages],
    tools,
})

// RIGHT — tool-use protocol engages
streamText({
    system: systemMessages,
    messages: userMessages,
    tools,
})
```

Cache-control `providerOptions` markers on system entries are preserved either way; only the routing changes.

### Trap 2 — `stopWhen` left at the default

**Symptom:** the assistant bubble ends immediately after a tool call with no answer rendered. Tool blocks do execute, but the user never sees the follow-up text.

**Cause:** without `stopWhen`, the AI SDK defaults to `stepCountIs(1)` — the SDK stops after the first model response. The follow-up step that re-prompts with tool results never runs.

**Fix:**

```ts
import { streamText, stepCountIs } from 'ai'

streamText({
    system,
    messages,
    tools,
    stopWhen: stepCountIs(5),
})
```

A value of `5` is safe for most agents. Tune up for chains that legitimately need more than one tool round-trip.

### Trap 3 — model narrates calls anyway

**Symptom:** structured `tool_use` blocks execute correctly AND the model also emits the XML inline in its text output. The user sees both the real answer and the leaked markup.

**Cause:** Anthropic models are trained on both the legacy `<function_calls>` format and the new structured format. Even when tools fire correctly, the model sometimes echoes the call in prose. Short system prompts re-surface this bias; long prompts often suppress it accidentally.

**Fix:** add an explicit anti-narration rule to the system prompt. `@maestro/core/runtime` exports this as a constant and a function helper:

```ts
import { runChatTurn, antiToolNarrationRule } from '@maestro/core/runtime'

await runChatTurn({
    // ...
    systemPrompt: {
        static: `${persona}\n\n${antiToolNarrationRule()}\n\n${corpus}`,
    },
})
```

`ANTI_TOOL_NARRATION_RULE` is also exported as a bare constant for inline template-literal use.

### Trap 4 — tool registry resolves empty

**Symptom:** `<function_calls>` XML in prose alongside placeholder text like `[waiting for system response]`. Latency and token counts look normal, the turn row persists, but no tool ever ran.

**Cause:** the host's tool filter — surface/transport mapping, `isAvailable` predicates, or a role gate — returned no tools. The AI SDK then sends `tools: {}` to Anthropic. With nothing to call, the model falls back to narrating from its pre-tool-use training corpus.

A common variant: passing a `HelpSurface`-style audience value (`'admin' | 'customer' | ...`) where a `ToolTransport` is expected (`'chat' | 'guest-chat' | 'whatsapp' | 'mcp'`). No tool advertises `'admin'` in its `transports` array, so the filter returns empty. The bug is hidden if the call site uses `transport: surface as never`.

**Fix:** translate audience to transport explicitly, never cast:

```ts
const transport: ToolTransport =
    surface === 'admin' || surface === 'customer' ? 'chat' : 'guest-chat'
```

**Smoking-gun signal:** on the first turn of a fresh session, `cache_write_tokens: 0` AND `cache_read_tokens: 0` means the tool block was never submitted to Anthropic (a populated tool registry writes the cache on cold and reads it on hot, given the ephemeral `cacheControl` markers `runChatTurn` sets). Combined with `<function_calls>` XML in the answer prose, that is empty-registry.

### Smoke-test checklist

For any prompt that should invoke at least one tool, assert all of the following — each guards a different trap and none is covered by type checks:

- `event.toolCalls?.length > 0` — guards Trap 4 (empty registry) and Trap 1 (no tool-use routing).
- final text contains no `<function_calls>` substring — guards Trap 3 (narration leak).
- final text contains no `<invoke>` substring — same guard, complementary token.
- final text is non-empty after a tool call — guards Trap 2 (`stopWhen` default).
- on a cold first turn, telemetry shows `cache_write_tokens > 0` — guards Trap 4 (registry actually shipped).

## Provider fallback

`shouldFallback` + `mapModelIdToOpenAI` give you composable retry against OpenAI when Anthropic hits a transient failure:

```ts
import { runChatTurn, shouldFallback, mapModelIdToOpenAI } from '@maestro/core/runtime'

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
