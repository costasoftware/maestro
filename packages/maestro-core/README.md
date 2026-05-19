# maestro-core

In-process tool-calling agent runtime for SaaS products. Model-agnostic, transport-agnostic, framework-agnostic kernel with port-based governance — powers user-support chat with shared quota, cost, audit, memory, and prompt-cache machinery without a remote gateway hop.

## What ships

### `1.1.0` (current)

- **`runChatTurn`** — one call replaces ~300 LoC of stream orchestration. Pre-call quota gate, model selection, AI SDK tool building, prompt-cache breakpoints, memory injection, turn-row persistence, post-call accounting, SSE response. Lives at `maestro-core/runtime`.
- **`runOneShotTurn`** — single-shot `generateText` counterpart for non-streaming channels (WhatsApp, SMS, email, batch eval). Same ports, same trap-guards, returns a typed `RunOneShotTurnResult` instead of a `Response`. Lives at `maestro-core/runtime`.
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

## Single-shot turns (`runOneShotTurn`)

`runChatTurn` returns an SSE stream. Some channels can't consume one:

- **WhatsApp / SMS bots** — the provider expects one POST body per outbound message.
- **Email auto-responders** — the body is finalised before send; nothing to stream into.
- **Batch evals / cron summarisers** — there is no user UI; the harness wants the full text + tool history at once.

For these, `runOneShotTurn` is the same kernel call wrapped around `generateText` instead of `streamText`. Same ports, same trap-guards, same model selection / quota / memory / cache / turn-row / telemetry machinery — different shape on the way out:

```ts
import { runOneShotTurn, AiQuotaDeniedError } from 'maestro-core/runtime'

const result = await runOneShotTurn({
    threadId,
    ctx, // BaseToolContext — same shape as runChatTurn
    messages, // UIMessage[] from your transport's history
    tools: [lookupTool /* ... */],
    systemPrompt: {
        static: 'You are a helpful WhatsApp assistant.',
        dynamic: undefined,
    },
    models: {
        fast: 'claude-haiku-4-5-20251001',
        smart: 'claude-sonnet-4-6',
    },
    // Bound output length — keep SMS / WhatsApp turns short.
    maxOutputTokens: 600,
    // Same recovery semantics as runChatTurn; enforce mode fires a
    // second generateText call when triggered (no writer to inject into).
    emptyRecoveryMode: 'enforce',
    emptyRecoveryFallback: 'Desculpe, tive um problema. Pode tentar de novo?',
    ports: {
        turnStore: myTurnStore,
        keyProvider: myKeyProvider,
        auditStore: myAuditStore,
        memoryStore: myMemoryStore, // optional
        quotaStore: myQuotaStore, // optional but recommended
        telemetry: myTelemetrySink, // defaults to Noop
    },
})

// Deliver however the channel wants:
await sendWhatsAppMessage({ to: from, body: result.text })

// result.toolCalls — one-row-per-call summary (joined with toolResults).
// result.usage — combined totals (primary + synthesis, if enforce fired).
// result.emptyRecovery — { triggered, attempted, mode } for dashboards.
// result.finishReason — 'stop' | 'length' | 'tool-calls' | ...
```

### Differences from `runChatTurn`

| Aspect | `runChatTurn` | `runOneShotTurn` |
| --- | --- | --- |
| Driver | `streamText` | `generateText` |
| Return | `Response \| undefined` (or merge into a `writer`) | `RunOneShotTurnResult` (typed) |
| Delivery | Caller forwards the SSE / merges into a host stream | Caller delivers `result.text` over the channel's transport |
| Empty-recovery enforce | Second `streamText`, merged into writer | Second `generateText`, text appended to `result.text` |
| `writer` arg | Yes — for hosts wrapping in `createUIMessageStream` | No — there is no stream to merge into |
| `maxOutputTokens` | Not exposed at the kernel surface | Yes — for bounded-length channels |

Everything else is intentionally identical: the same `AiQuotaDeniedError` throws, the same `pending → completed / failed / aborted` turn-row lifecycle, the same prompt-cache split, the same trap-guards (system at top level, `stopWhen` set, empty-registry warn). The `antiToolNarrationRule()` helper applies the same way — compose it into `systemPrompt.static` if your prompt is short.

### Forcing tool use with `toolChoice`

`runOneShotTurn` forwards an optional `toolChoice` arg to `generateText` (default `'auto'` — model decides, identical to the AI SDK default, so existing callers see zero behaviour change). Set `'required'` when the host has detected a stall and wants to force a tool invocation on the retry; set `'none'` for forced text-only summarisation passes.

The motivating use case is the WhatsApp stall-retry pattern. When Claude emits a stub like "Let me check on that for you" with no tool call while tools were available, the host re-runs the turn with `toolChoice: 'required'` to force the model down the tool-use path:

```ts
const first = await runOneShotTurn({
    threadId,
    ctx,
    messages,
    tools,
    systemPrompt,
    models,
    ports,
})

// Host-side stall detection: tools were available, model emitted text but
// no tool call, and the text matches a known stall regex.
const looksLikeStall =
    first.toolCalls.length === 0 &&
    tools.length > 0 &&
    /\b(let me check|i'?ll look|one moment|hold on)\b/i.test(first.text)

if (looksLikeStall) {
    const retry = await runOneShotTurn({
        threadId,
        ctx,
        messages,
        tools,
        systemPrompt,
        models,
        ports,
        toolChoice: 'required', // force a tool invocation this pass
    })
    await sendWhatsAppMessage({ to: from, body: retry.text })
} else {
    await sendWhatsAppMessage({ to: from, body: first.text })
}
```

The internal empty-recovery synthesis call (when `emptyRecoveryMode: 'enforce'` triggers) always uses `'none'` regardless of this arg — its job is to extract pure text from already-fired tool output, so allowing further tool calls would defeat the recovery.

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

**Fix:** add an explicit anti-narration rule to the system prompt. `maestro-core/runtime` exports this as a constant and a function helper:

```ts
import { runChatTurn, antiToolNarrationRule } from 'maestro-core/runtime'

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
