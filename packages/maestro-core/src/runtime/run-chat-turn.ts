import { createAnthropic } from '@ai-sdk/anthropic'
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from 'ai'

import { buildAiSdkTools } from '../adapters/ai-sdk.js'
import { applyCacheBreakpoints } from '../cache-control.js'
import type { BaseToolContext } from '../context.js'
import { estimateCost } from '../cost.js'
import { selectChatModel, type ModelTier } from '../models.js'
import type { AuditStore } from '../ports/audit-store.js'
import { type Clock, SystemClock } from '../ports/clock.js'
import type { ModelKeyProvider } from '../ports/key-provider.js'
import { type Logger, SilentLogger } from '../ports/logger.js'
import type { MemoryStore } from '../ports/memory-store.js'
import type { QuotaStore } from '../ports/quota-store.js'
import { NoopTelemetrySink, type TelemetrySink } from '../ports/telemetry-sink.js'
import type { TurnRecord, TurnStore } from '../ports/turn-store.js'
import type { AgentToolDefinition } from '../tool.js'

import { loadMemoryBlock } from './memory.js'
import { AiQuotaDeniedError, checkAndEnforce } from './quota.js'

/**
 * Public chat-turn entry point. One call replaces the ~300 LoC of stream
 * orchestration a host route would otherwise write by hand
 * (build tools, call streamText, persist turn, emit telemetry, handle
 * errors, return SSE response).
 *
 * Current scope (slice 4):
 *   ✓ Model selection via `selectChatModel`
 *   ✓ Provider key resolution via `ModelKeyProvider` port
 *   ✓ AI SDK tool building via the `buildAiSdkTools` adapter
 *   ✓ Turn persistence via `TurnStore` port (pending → completed | failed | aborted)
 *   ✓ Telemetry emit via `TelemetrySink` port (default Noop)
 *   ✓ Cost estimate via `estimateCost`
 *   ✓ SSE Response ready to return from a Next.js route
 *   ✓ Pre-call quota gate via `QuotaStore.check` (throws `AiQuotaDeniedError` on deny)
 *   ✓ Post-call quota record via `QuotaStore.record` (fire-and-forget)
 *   ✓ Memory load via `MemoryStore.load` (formatted into dynamic system segment)
 *   ✓ Anthropic prompt-cache breakpoints via `applyCacheBreakpoints`
 *
 * Deferred to later slices / releases:
 *   ☐ Empty-recovery classifier — exposed as a helper in slice 5;
 *     calling routes decide what to do with the signal.
 *   ☐ OpenAI fallback retry wrapper inside runChatTurn — slice 5
 *     ships the helper primitives (`shouldFallback`, `mapModelToOpenAI`)
 *     so hosts can compose the retry themselves. Built-in retry
 *     wrapper deferred to 0.2.1 — mid-stream switching is invasive.
 */
export interface RunChatTurnPorts {
    turnStore: TurnStore
    keyProvider: ModelKeyProvider
    auditStore?: AuditStore
    /** Reserved for slice 3. Currently unused — pass when ready. */
    quotaStore?: QuotaStore
    /** Reserved for slice 4. Currently unused — pass when ready. */
    memoryStore?: MemoryStore
    telemetry?: TelemetrySink
    clock?: Clock
    logger?: Logger
}

export interface RunChatTurnArgs<TCtx extends BaseToolContext> {
    /** Stable id grouping this turn into a conversation. */
    threadId: string
    /** Per-request context. */
    ctx: TCtx
    /** UI messages from the client (`@ai-sdk/react` shape). */
    messages: UIMessage[]
    /** Eligible tool registry — host pre-filters for surface/availability. */
    tools: readonly AgentToolDefinition<any, any, TCtx>[]
    /**
     * Split system prompt for Anthropic prompt-cache hits.
     *
     *   `static`  — tenant-invariant content. Hashed for the cache key.
     *               MUST NOT contain per-tenant interpolated strings;
     *               numbers / IDs are fine if they live in `dynamic`
     *               instead.
     *   `dynamic` — tenant-specific content (timezone label, business
     *               name in prose, current time, memory facts). Rendered
     *               after the cache breakpoint so it never influences
     *               the cache key. Optional — omit if there's nothing
     *               tenant-specific to inject.
     *
     * Memory facts loaded via the `MemoryStore` port are auto-appended
     * to `dynamic` before the cache split — hosts don't need to format
     * them in by hand.
     */
    systemPrompt: { static: string; dynamic?: string }
    /** Per-tier model ids. Host resolves from its env layer. */
    models: { fast: string; smart: string; force?: string | null }
    /** Optional hint that bypasses the model heuristic for this turn. */
    modelHint?: { tier?: ModelTier }
    /** Forwarded to streamText for client-side cancellation. */
    abortSignal?: AbortSignal
    /** Required ports + optional advanced ports. */
    ports: RunChatTurnPorts
    /** Side-effect hook after the assistant turn row is finalised. */
    onTurnFinalized?: (turn: TurnRecord) => void | Promise<void>
    /**
     * When true (default) and `ports.quotaStore` is supplied, a thrown
     * error from the port's `check` method is logged at warn and the
     * call proceeds anyway. Matches the barbeiro convention — never
     * block paying customers on a transient Redis blip. Pre-call
     * `AiQuotaDeniedError` throws (which are intentional) propagate
     * regardless of this flag.
     *
     * Set to false in environments where the deny path must be
     * strictly authoritative (compliance, internal-test fixtures).
     */
    failOpenOnQuotaError?: boolean
    /**
     * Optional namespace passed to `MemoryStore.load` so a host that
     * partitions facts (e.g. `'preferences'` vs `'facts'`) can scope
     * the load. Omit for the default unscoped lookup. Has no effect
     * when `ports.memoryStore` is not supplied.
     */
    memoryNamespace?: string
    /**
     * Optional host-supplied turn id. When provided, the kernel uses
     * it verbatim for the assistant `TurnRecord.id`. When omitted, the
     * kernel generates one via the existing
     * `turn_<epoch>_<requestId?>_<rand>` shape.
     *
     * Hosts whose persistence layer uses a different id space
     * (incrementing integers, externally-supplied UUIDs) pass their
     * id here so the port impl can update the row by its real key
     * instead of maintaining a `kernelTurnId → hostRowId` mapping. The
     * port impl is responsible for parsing the id back to its native
     * shape (e.g. `Number(turn.id)` for integer primary keys).
     *
     * Added in 0.2.1; pre-existing callers continue to get
     * kernel-generated ids unchanged.
     */
    turnId?: string
    /**
     * Max steps in the tool-use loop. Default `5` — leaves headroom for
     * a few tool round-trips per turn without runaway loops. AI SDK
     * counts each model response as a step; without this hint, the
     * SDK stops after the FIRST response, meaning tool results never
     * feed back to the model (the user sees the empty bubble after a
     * tool call). Set higher for agents that do deep multi-step work.
     */
    maxSteps?: number
}

export async function runChatTurn<TCtx extends BaseToolContext>(
    args: RunChatTurnArgs<TCtx>
): Promise<Response> {
    const clock = args.ports.clock ?? new SystemClock()
    const logger = args.ports.logger ?? new SilentLogger()
    const telemetry = args.ports.telemetry ?? new NoopTelemetrySink()
    const failOpenOnQuotaError = args.failOpenOnQuotaError ?? true

    // ── 0. Quota pre-call gate ──────────────────────────────────────
    // Runs before any LLM/key/storage work so a denied tenant pays
    // zero side-effects. `AiQuotaDeniedError` is the only error this
    // block intentionally surfaces; everything else is fail-open by
    // default so a Redis/Postgres hiccup never blocks paying tenants.
    if (args.ports.quotaStore) {
        try {
            await checkAndEnforce({
                quotaStore: args.ports.quotaStore,
                tenantId: args.ctx.tenantId,
                surface: args.ctx.transport,
            })
        } catch (e) {
            if (e instanceof AiQuotaDeniedError) {
                // Fire-and-forget telemetry for the deny — it landed
                // in the audit log via the host's own `record` call
                // when the over-cap call originally went through;
                // this just surfaces the deny event for dashboards.
                void telemetry.emit([
                    {
                        type: 'quota.consumed',
                        tenantId: args.ctx.tenantId,
                        surface: args.ctx.transport,
                        window: 'day',
                        used: e.payload.current,
                        ceiling: e.payload.ceiling,
                        denied: true,
                        occurredAt: clock.now(),
                    },
                ])
                throw e
            }
            if (failOpenOnQuotaError) {
                logger.warn('runChatTurn quotaStore.check failed; failing open', {
                    tenantId: args.ctx.tenantId,
                    surface: args.ctx.transport,
                    error: e instanceof Error ? e.message : String(e),
                })
            } else {
                throw e
            }
        }
    }

    // ── 1. Model selection ──────────────────────────────────────────
    const lastUserMessage = [...args.messages].reverse().find((m) => m.role === 'user')
    const lastUserText = extractText(lastUserMessage)
    const turnIndex = args.messages.filter((m) => m.role === 'user').length
    const selection = selectChatModel({
        userMessage: lastUserText,
        turnIndex,
        forceTier: args.modelHint?.tier,
        models: args.models,
    })

    // ── 2. Provider key + model instance ────────────────────────────
    const apiKey = await args.ports.keyProvider.getKey('anthropic', args.ctx.tenantId)
    const anthropic = createAnthropic({ apiKey })
    const model = anthropic(selection.modelId)

    // ── 3. Tools (adapter handles per-call audit) ───────────────────
    const rawTools = buildAiSdkTools<TCtx>({
        registry: args.tools,
        ctx: args.ctx,
        audit: args.ports.auditStore,
        clock,
    })

    // ── 3b. Memory pull (optional) ──────────────────────────────────
    // Load + format memory facts BEFORE the cache split so the facts
    // land in the dynamic (uncached) segment. Memory varies per
    // principal — caching it would split the prompt cache by user and
    // kill cross-tenant reuse.
    let memoryBlock = ''
    if (args.ports.memoryStore && args.ctx.principal) {
        try {
            memoryBlock = await loadMemoryBlock({
                memoryStore: args.ports.memoryStore,
                scope: {
                    tenantId: args.ctx.tenantId,
                    principalId: args.ctx.principal.id,
                    namespace: args.memoryNamespace,
                },
            })
        } catch (e) {
            // Fail-open — memory is a UX enhancement, not a correctness
            // requirement. Log and proceed without it.
            logger.warn('runChatTurn memoryStore.load failed; proceeding without memory', {
                tenantId: args.ctx.tenantId,
                error: e instanceof Error ? e.message : String(e),
            })
        }
    }

    // ── 3c. Cache split ─────────────────────────────────────────────
    // applyCacheBreakpoints renders `system` as a two-element array:
    //   [0] static  — cached (cacheControl ephemeral marker)
    //   [1] dynamic — uncached (tenant context + memory + now)
    // The last tool in the registry also gets the cache marker so the
    // tool schema block is served from cache on hot turns.
    const dynamicLines = [args.systemPrompt.dynamic ?? '', memoryBlock]
        .filter((s) => s.length > 0)
        .join('\n\n')
    const nowAtCacheSplit = clock.now()
    const cached = applyCacheBreakpoints({
        static: {
            intro: args.systemPrompt.static,
            corpus: '',
            tools: rawTools,
        },
        dynamic: {
            tenant: {
                id: args.ctx.tenantId,
                timezone: args.ctx.timezone,
            },
            principal: args.ctx.principal ? { id: args.ctx.principal.id } : undefined,
            nowIso: nowAtCacheSplit.toISOString(),
        },
    })
    // Append the host-supplied dynamic + memory content to the
    // generated dynamic system segment so it lands AFTER the
    // breakpoint. The structured tenant context that
    // applyCacheBreakpoints synthesises is the first dynamic line;
    // anything host-supplied follows it.
    const dynamicMsg = cached.system[1]
    if (dynamicMsg && dynamicLines.length > 0) {
        dynamicMsg.content = `${dynamicMsg.content}\n${dynamicLines}`
    }

    // ── 4. Reserve assistant turn row ───────────────────────────────
    const startedAt = clock.now()
    // Host-supplied turnId wins when present so the port impl can
    // address rows it pre-created (typical pattern: route inserts
    // a row, takes its primary key, passes it here as a string).
    const turnId = args.turnId ?? makeTurnId(startedAt, args.ctx.requestId)
    await args.ports.turnStore.upsert({
        id: turnId,
        threadId: args.threadId,
        tenantId: args.ctx.tenantId,
        role: 'assistant',
        content: null,
        status: 'pending',
        modelId: selection.modelId,
        createdAt: startedAt,
        updatedAt: startedAt,
    })

    // ── 5. Stream ───────────────────────────────────────────────────
    // System messages MUST be passed via the top-level `system`
    // parameter (not mixed into `messages`). Anthropic's tool-use API
    // only enables tool_use blocks when system is supplied at the
    // top level; messages-mixed system trips a different code path
    // in @ai-sdk/anthropic and the model falls back to emitting
    // <function_calls> XML in prose instead of structured tool calls.
    // Confirmed bug in 0.2.2 — symptom: tool names visible as plain
    // text in the chat, tools never execute. Cache breakpoint markers
    // on the system entries carry through unchanged.
    const userMessages = await convertToModelMessages(args.messages)
    const stream = streamText({
        model,
        system: cached.system,
        messages: userMessages,
        tools: cached.tools,
        // Without `stopWhen`, AI SDK defaults to `stepCountIs(1)` —
        // the SDK stops after the FIRST model response, so even if
        // the model emits real tool-use blocks, the follow-up step
        // that re-prompts with tool results never runs. The user
        // sees the assistant bubble end immediately after the tool
        // call with no answer.
        stopWhen: stepCountIs(args.maxSteps ?? 5),
        abortSignal: args.abortSignal,
        onFinish: async (event) => {
            const finishedAt = clock.now()
            const durationMs = finishedAt.getTime() - startedAt.getTime()

            // AI SDK v6 surfaces usage as `event.usage` with the
            // shape { inputTokens, outputTokens, totalTokens } and
            // optionally cachedInputTokens for providers that support
            // prompt caching. Fall back to 0 to keep the cost
            // arithmetic safe when fields are missing.
            const usage = (event.usage ?? null) as {
                inputTokens?: number
                outputTokens?: number
                cachedInputTokens?: number
                cachedOutputTokens?: number
            } | null
            const tokensIn = usage?.inputTokens ?? 0
            const tokensOut = usage?.outputTokens ?? 0
            const cacheReadTokens = usage?.cachedInputTokens ?? 0
            // Cache-write token count isn't exposed in the v6 usage
            // object today. Tracked separately in cache-control.ts
            // bookkeeping once slice 4 lands.
            const cacheWriteTokens = 0

            const costUsd = estimateCost(
                {
                    input: tokensIn,
                    output: tokensOut,
                    cacheRead: cacheReadTokens,
                    cacheWrite: cacheWriteTokens,
                },
                selection.modelId
            )
            const costUsdMicro = Math.max(0, Math.round(costUsd * 1_000_000))

            const finalTurn: TurnRecord = {
                id: turnId,
                threadId: args.threadId,
                tenantId: args.ctx.tenantId,
                role: 'assistant',
                content: event.text,
                status: 'completed',
                modelId: selection.modelId,
                tokensIn,
                tokensOut,
                cacheReadTokens,
                cacheWriteTokens,
                costUsdMicro,
                durationMs,
                createdAt: startedAt,
                updatedAt: finishedAt,
            }

            try {
                await args.ports.turnStore.upsert(finalTurn)
            } catch (e) {
                logger.error('runChatTurn turnStore.upsert failed', {
                    turnId,
                    error: e instanceof Error ? e.message : String(e),
                })
            }

            // Post-call quota accounting. Fire-and-forget — a slow
            // ledger write must not stall the SSE finalisation. The
            // tool-calls count comes from the AI SDK toolCalls list
            // (may be absent if the turn didn't invoke any tools).
            if (args.ports.quotaStore) {
                const toolCallsCount = Array.isArray(
                    (event as { toolCalls?: unknown }).toolCalls
                )
                    ? ((event as { toolCalls: unknown[] }).toolCalls.length)
                    : 0
                args.ports.quotaStore
                    .record({
                        tenantId: args.ctx.tenantId,
                        surface: args.ctx.transport,
                        tokensIn,
                        tokensOut,
                        cacheReadTokens,
                        cacheWriteTokens,
                        toolCalls: toolCallsCount,
                        costUsdMicro,
                        modelId: selection.modelId,
                        occurredAt: finishedAt,
                    })
                    .catch((e: unknown) => {
                        logger.warn('runChatTurn quotaStore.record failed', {
                            turnId,
                            error: e instanceof Error ? e.message : String(e),
                        })
                    })
            }

            // Telemetry is fire-and-forget; emit failures are swallowed
            // inside the sink and never block the stream finalisation.
            void telemetry.emit([
                {
                    type: 'turn.finalized',
                    turnId,
                    threadId: args.threadId,
                    tenantId: args.ctx.tenantId,
                    modelId: selection.modelId,
                    tier: selection.tier,
                    tokensIn,
                    tokensOut,
                    cacheReadTokens,
                    cacheWriteTokens,
                    costUsdMicro,
                    durationMs,
                    occurredAt: finishedAt,
                },
            ])

            if (args.onTurnFinalized) {
                try {
                    await args.onTurnFinalized(finalTurn)
                } catch (e) {
                    logger.error('runChatTurn onTurnFinalized hook threw', {
                        turnId,
                        error: e instanceof Error ? e.message : String(e),
                    })
                }
            }
        },
        onError: async ({ error }) => {
            const message = error instanceof Error ? error.message : String(error)
            logger.error('runChatTurn streamText error', { turnId, message })
            try {
                await args.ports.turnStore.markFailed(turnId, {
                    code: 'stream_error',
                    message,
                })
            } catch (e) {
                logger.error('runChatTurn turnStore.markFailed failed', {
                    turnId,
                    error: e instanceof Error ? e.message : String(e),
                })
            }
        },
        onAbort: async () => {
            try {
                await args.ports.turnStore.markAborted(turnId, 'client-abort')
            } catch (e) {
                logger.error('runChatTurn turnStore.markAborted failed', {
                    turnId,
                    error: e instanceof Error ? e.message : String(e),
                })
            }
        },
    })

    return stream.toUIMessageStreamResponse()
}

/**
 * Compose a turn id. Includes the request id when present so the
 * persisted row can be cross-referenced against tracing without an
 * extra join. Random suffix breaks ties on rapid same-ms turns.
 */
function makeTurnId(startedAt: Date, requestId?: string): string {
    const epochMs = startedAt.getTime()
    const rand = Math.random().toString(36).slice(2, 8)
    return requestId ? `turn_${epochMs}_${requestId}_${rand}` : `turn_${epochMs}_${rand}`
}

function extractText(message: UIMessage | undefined): string {
    if (!message) return ''
    return message.parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('')
        .trim()
}
