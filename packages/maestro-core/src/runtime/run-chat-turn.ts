import { createAnthropic } from '@ai-sdk/anthropic'
import { convertToModelMessages, streamText, type UIMessage } from 'ai'

import { buildAiSdkTools } from '../adapters/ai-sdk.js'
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

import { AiQuotaDeniedError, checkAndEnforce } from './quota.js'

/**
 * Public chat-turn entry point. One call replaces the ~300 LoC of stream
 * orchestration a host route would otherwise write by hand
 * (build tools, call streamText, persist turn, emit telemetry, handle
 * errors, return SSE response).
 *
 * Current scope (slice 3):
 *   ✓ Model selection via `selectChatModel`
 *   ✓ Provider key resolution via `ModelKeyProvider` port
 *   ✓ AI SDK tool building via the `buildAiSdkTools` adapter
 *   ✓ Turn persistence via `TurnStore` port (pending → completed | failed | aborted)
 *   ✓ Telemetry emit via `TelemetrySink` port (default Noop)
 *   ✓ Cost estimate via `estimateCost`
 *   ✓ SSE Response ready to return from a Next.js route
 *   ✓ Pre-call quota gate via `QuotaStore.check` (throws `AiQuotaDeniedError` on deny)
 *   ✓ Post-call quota record via `QuotaStore.record` (fire-and-forget)
 *
 * Deferred to later slices:
 *   ☐ Memory load + inject into system prompt — slice 4
 *   ☐ Cache-breakpoint placement on the system prompt — slice 4
 *   ☐ Empty-recovery classifier — slice 5
 *   ☐ OpenAI fallback when Anthropic rate-limits — slice 5
 *
 * Until those slices land, callers that need cache / memory should
 * continue to wire `streamText` directly and gradually adopt sub-features
 * (selectChatModel, buildAiSdkTools, estimateCost) one at a time.
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
    /** System prompt. Plain string for slice 2; cache-aware split lands in slice 4. */
    systemPrompt: string
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
    const tools = buildAiSdkTools<TCtx>({
        registry: args.tools,
        ctx: args.ctx,
        audit: args.ports.auditStore,
        clock,
    })

    // ── 4. Reserve assistant turn row ───────────────────────────────
    const startedAt = clock.now()
    const turnId = makeTurnId(startedAt, args.ctx.requestId)
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
    const stream = streamText({
        model,
        system: args.systemPrompt,
        messages: await convertToModelMessages(args.messages),
        tools,
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
