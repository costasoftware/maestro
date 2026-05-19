import { createAnthropic } from '@ai-sdk/anthropic'
import {
    convertToModelMessages,
    generateText,
    stepCountIs,
    type UIMessage,
} from 'ai'

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
import type { ToolExceptionHandler } from '../safe-tool.js'
import type { AgentToolDefinition } from '../tool.js'

import { decideEmptyRecovery, type EmptyRecoveryMode } from './empty-recovery.js'
import { loadMemoryBlock } from './memory.js'
import { AiQuotaDeniedError, checkAndEnforce } from './quota.js'

/**
 * Single-shot turn entry point — the non-streaming sibling of
 * `runChatTurn`. Same ports, same context, same trap-guards, same
 * model / quota / memory / cache / turn / telemetry machinery, but
 * driven by `generateText` instead of `streamText` and returning a
 * typed result the caller delivers however it wants.
 *
 * Use this for channels that deliver ONE message at a time:
 *   - WhatsApp / SMS bots — post one text per turn
 *   - Email auto-responders — one body per request
 *   - Batch evaluations — programmatic harness scoring tool output
 *   - Cron / job-driven summarisations — no UI to stream into
 *
 * Use `runChatTurn` instead when:
 *   - You're returning an SSE stream to a browser (`@ai-sdk/react`)
 *   - You want mid-stream data chips (`writer.write({ type, data })`)
 *   - The user benefits from token-by-token rendering
 *
 * Differences from `runChatTurn`:
 *   - No `writer` argument — there is no stream to merge into.
 *   - Returns `RunOneShotTurnResult` instead of `Response | undefined`.
 *   - Empty-recovery `'enforce'` mode fires a second `generateText`
 *     call when triggered (no writer to inject into) and the
 *     synthesised text is appended to `result.text`. Token usage and
 *     cost from both calls are combined.
 *   - No `onAbort` callback — `generateText` rejects with
 *     `AbortError` on aborted signals, caught by the surrounding
 *     try/catch and routed to `turnStore.markAborted`.
 *
 * Same as `runChatTurn`:
 *   - Pre-call quota gate (throws `AiQuotaDeniedError` on deny;
 *     fail-open on port errors by default).
 *   - Two-tier model selection via `selectChatModel`. The selected
 *     `tier` and the selector's `reason` string are surfaced on the
 *     returned `RunOneShotTurnResult` so callers can log them on the
 *     same line as their channel-specific telemetry.
 *   - Provider key via `ModelKeyProvider`.
 *   - Tool building via `buildAiSdkTools` with per-call audit and an
 *     optional `onError` observability hook for thrown exceptions.
 *   - Memory load + cache-control split (memory + dynamic land in
 *     the uncached system segment to preserve prompt-cache reuse).
 *   - Turn-store upsert (`pending` → `completed` | `failed` |
 *     `aborted`).
 *   - Post-call quota record (fire-and-forget).
 *   - `turn.finalized` telemetry emit.
 *   - All 4 traps closed: `system` at top level, `stopWhen` set,
 *     empty-registry warn, `antiToolNarrationRule()` available for
 *     callers to compose into `systemPrompt.static`.
 */
export interface RunOneShotTurnPorts {
    turnStore: TurnStore
    keyProvider: ModelKeyProvider
    auditStore?: AuditStore
    quotaStore?: QuotaStore
    memoryStore?: MemoryStore
    telemetry?: TelemetrySink
    clock?: Clock
    logger?: Logger
}

export interface RunOneShotTurnArgs<TCtx extends BaseToolContext<string>> {
    /**
     * Optional host-supplied turn id. When omitted the kernel
     * generates one via the same `turn_<epoch>_<requestId?>_<rand>`
     * shape `runChatTurn` uses.
     */
    turnId?: string
    /** Conversation grouping. */
    threadId: string
    /** Per-request context. */
    ctx: TCtx
    /** UI messages from the client. */
    messages: UIMessage[]
    /** Eligible tool registry — host pre-filters for surface / availability. */
    tools: readonly AgentToolDefinition<any, any, TCtx>[]
    /**
     * Split system prompt for Anthropic prompt-cache hits. Same
     * semantics as `runChatTurn`: `static` is hashed for the cache
     * key (must NOT contain per-tenant interpolated strings);
     * `dynamic` lands in the uncached segment after the breakpoint.
     * Memory facts auto-append to `dynamic`.
     */
    systemPrompt: { static: string; dynamic?: string }
    /** Per-tier model ids. Host resolves from its env layer. */
    models: { fast: string; smart: string; force?: string | null }
    /** Optional hint that bypasses the model heuristic for this turn. */
    modelHint?: { tier?: ModelTier }
    /** Propagated to `generateText` for client-side cancellation. */
    abortSignal?: AbortSignal
    /** Required ports + optional advanced ports. */
    ports: RunOneShotTurnPorts
    /** Side-effect hook after the assistant turn row is finalised. */
    onTurnFinalized?: (turn: TurnRecord) => void | Promise<void>
    /**
     * Match `runChatTurn`: when true (default) and `ports.quotaStore`
     * is supplied, a thrown error from the port's `check` method is
     * logged at warn and the call proceeds anyway. Pre-call
     * `AiQuotaDeniedError` throws propagate regardless of this flag.
     */
    failOpenOnQuotaError?: boolean
    /** Optional namespace passed to `MemoryStore.load`. */
    memoryNamespace?: string
    /**
     * Max steps in the tool-use loop. Default `5` — same as
     * `runChatTurn`. Without `stopWhen`, AI SDK defaults to
     * `stepCountIs(1)` and tool results never feed back to the model.
     */
    maxSteps?: number
    /**
     * Empty-recovery classifier mode. Default `'log_only'` — detect
     * the tool-loop-no-text case and emit telemetry + warn log, but
     * do NOT modify the persisted content.
     *
     * `'enforce'` mode fires a SECOND `generateText` call with the
     * same cached system + tools (to preserve Anthropic prompt-cache
     * reuse), `toolChoice: 'none'` (no further tool round-trips),
     * and `stepCountIs(1)`. The synthesised text is appended to
     * `result.text` and tokens / cost from the second call are
     * combined into the totals and persisted on the turn row.
     *
     * `'off'` disables the classifier entirely.
     */
    emptyRecoveryMode?: EmptyRecoveryMode
    /**
     * Locale + surface-appropriate fallback string. In `'enforce'`
     * mode it is used as the synthesis instruction's safety-net text.
     * In `'log_only'` it is surfaced via telemetry only.
     */
    emptyRecoveryFallback?: string
    /**
     * Optional max output tokens for the single `generateText` call.
     * Defaults to no cap. Set this for SMS / WhatsApp where you want
     * bounded output length.
     */
    maxOutputTokens?: number
    /**
     * Forwarded to `generateText`. Defaults to `'auto'` (model decides).
     *
     *   - `'auto'` — model decides whether to call a tool (default).
     *   - `'required'` — model MUST call at least one tool. Useful for
     *     retry paths that detected a stall (model emitted a "I'll
     *     check on that" stub without actually invoking the tool).
     *   - `'none'` — model MUST NOT call any tool. Useful for forced
     *     text-only summarisation passes.
     *
     * The internal empty-recovery synthesis call (when
     * `emptyRecoveryMode: 'enforce'` triggers) ALWAYS uses `'none'`
     * regardless of this arg, since its purpose is to extract pure
     * text from already-fired tool output.
     */
    toolChoice?: 'auto' | 'required' | 'none'
    /**
     * Optional observability hook invoked whenever a tool's `execute`
     * throws an unhandled exception. Forwarded as-is to
     * `buildAiSdkTools` for the primary AND the empty-recovery
     * synthesis call so both tool sets emit the same breadcrumbs.
     *
     * Hosts typically wire this to Sentry / Datadog (e.g.
     * `Sentry.captureException(error, { tags })`). The kernel still
     * rethrows after capture so the AI SDK marks the tool result as
     * `error` and the model sees the failure — `onError` is purely for
     * out-of-band telemetry and is never on the user-facing path.
     */
    onError?: ToolExceptionHandler
}

/**
 * Per-tool-call summary the caller can persist alongside the
 * assistant turn. Shape stays minimal so it is provider-agnostic;
 * structural extraction from AI SDK's `TypedToolCall` union covers
 * both static and dynamic tools without leaking the typed-tool
 * generic parameter into the kernel result.
 */
export interface RunOneShotTurnToolCall {
    name: string
    callId: string
    input: unknown
    result?: unknown
    error?: { code: string; message: string }
}

export interface RunOneShotTurnResult {
    /** Final text to deliver. Already includes synthesis if enforce-mode fired. */
    text: string
    toolCalls: RunOneShotTurnToolCall[]
    usage: {
        tokensIn: number
        tokensOut: number
        cacheReadTokens: number
        cacheWriteTokens: number
        costUsdMicro: number
    }
    durationMs: number
    modelId: string
    /**
     * Tier the model selector resolved for this turn (`'fast' | 'smart'`).
     * Mirrors the `tier` field on `turn.finalized` telemetry so callers
     * can record it on their own log lines (WhatsApp adopters, batch
     * eval harnesses) without re-running `selectChatModel`.
     */
    tier: ModelTier
    /**
     * Short reason string from `selectChatModel` describing why the
     * tier was chosen (e.g. `'default-fast'`, `'long-message'`,
     * `'keyword:reschedule'`, `'force-override'`). Useful for
     * dashboards that break down tier escalation rate by reason.
     */
    selectionReason: string
    /** `'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'other'`. */
    finishReason: string
    emptyRecovery: {
        triggered: boolean
        /**
         * `true` if enforce-mode actually ran the second
         * `generateText` call (and its output was appended). `false`
         * if mode was `'log_only'` / `'off'`, or if the classifier
         * didn't trigger.
         */
        attempted: boolean
        mode: EmptyRecoveryMode
    }
}

export async function runOneShotTurn<TCtx extends BaseToolContext<string>>(
    args: RunOneShotTurnArgs<TCtx>
): Promise<RunOneShotTurnResult> {
    const clock = args.ports.clock ?? new SystemClock()
    const logger = args.ports.logger ?? new SilentLogger()
    const telemetry = args.ports.telemetry ?? new NoopTelemetrySink()
    const failOpenOnQuotaError = args.failOpenOnQuotaError ?? true

    // ── 0. Quota pre-call gate ──────────────────────────────────────
    // Same semantics as runChatTurn: deny errors surface; port errors
    // are fail-open by default so transient Redis / Postgres blips
    // never block paying tenants.
    if (args.ports.quotaStore) {
        try {
            await checkAndEnforce({
                quotaStore: args.ports.quotaStore,
                tenantId: args.ctx.tenantId,
                surface: args.ctx.transport,
            })
        } catch (e) {
            if (e instanceof AiQuotaDeniedError) {
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
                logger.warn(
                    'runOneShotTurn quotaStore.check failed; failing open',
                    {
                        tenantId: args.ctx.tenantId,
                        surface: args.ctx.transport,
                        error: e instanceof Error ? e.message : String(e),
                    }
                )
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
    // Same warn as runChatTurn — an empty registry is almost always
    // a host filter that dropped everything (surface vs transport
    // confusion is the most common root cause). See trap catalog for
    // the full story.
    if (args.tools.length === 0) {
        logger.warn(
            'runOneShotTurn received empty tool registry — Anthropic will receive tools:{} and likely emit <function_calls> XML in prose. Check your eligibility filter (transport/actor/isAvailable) if this is unexpected.',
            {
                tenantId: args.ctx.tenantId,
                transport: args.ctx.transport,
                actor: args.ctx.actor,
            }
        )
    }
    const rawTools = buildAiSdkTools<TCtx>({
        registry: args.tools,
        ctx: args.ctx,
        audit: args.ports.auditStore,
        onError: args.onError,
        clock,
    })

    // ── 3b. Memory pull (optional) ──────────────────────────────────
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
            logger.warn(
                'runOneShotTurn memoryStore.load failed; proceeding without memory',
                {
                    tenantId: args.ctx.tenantId,
                    error: e instanceof Error ? e.message : String(e),
                }
            )
        }
    }

    // ── 3c. Cache split ─────────────────────────────────────────────
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
    const dynamicMsg = cached.system[1]
    if (dynamicMsg && dynamicLines.length > 0) {
        dynamicMsg.content = `${dynamicMsg.content}\n${dynamicLines}`
    }

    // ── 4. Reserve assistant turn row ───────────────────────────────
    const startedAt = clock.now()
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

    // ── 5. Generate ─────────────────────────────────────────────────
    // System at top-level (Trap 1), stopWhen set (Trap 2), populated
    // tools (Trap 4) all converge here. Trap 3 (anti-narration) is
    // composed by the caller into systemPrompt.static via
    // antiToolNarrationRule() — kernel does not auto-inject so hosts
    // with a long bespoke prompt are not double-pinged.
    const userMessages = await convertToModelMessages(args.messages)
    const recoveryMode = args.emptyRecoveryMode ?? 'log_only'

    let primaryResult: Awaited<ReturnType<typeof generateText>>
    try {
        primaryResult = await generateText({
            model,
            system: cached.system,
            messages: userMessages,
            tools: cached.tools,
            toolChoice: args.toolChoice ?? 'auto',
            stopWhen: stepCountIs(args.maxSteps ?? 5),
            abortSignal: args.abortSignal,
            ...(typeof args.maxOutputTokens === 'number'
                ? { maxOutputTokens: args.maxOutputTokens }
                : {}),
        })
    } catch (e) {
        const isAbort =
            (e instanceof Error && (e.name === 'AbortError' || e.name === 'AbortSignal')) ||
            args.abortSignal?.aborted === true
        const message = e instanceof Error ? e.message : String(e)
        if (isAbort) {
            try {
                await args.ports.turnStore.markAborted(turnId, 'client-abort')
            } catch (markErr) {
                logger.error('runOneShotTurn turnStore.markAborted failed', {
                    turnId,
                    error: markErr instanceof Error ? markErr.message : String(markErr),
                })
            }
        } else {
            logger.error('runOneShotTurn generateText error', { turnId, message })
            try {
                await args.ports.turnStore.markFailed(turnId, {
                    code: 'generate_error',
                    message,
                })
            } catch (markErr) {
                logger.error('runOneShotTurn turnStore.markFailed failed', {
                    turnId,
                    error: markErr instanceof Error ? markErr.message : String(markErr),
                })
            }
        }
        throw e
    }

    // ── 6. Token + cost accounting (primary call) ───────────────────
    // generateText returns LanguageModelUsage on `.usage` and the
    // cross-step sum on `.totalUsage`. For tool-loop multi-step calls
    // we want the rolled-up totals so the persisted row reflects the
    // full cost, not just the last step.
    const primaryUsage = readUsage(primaryResult)
    let tokensIn = primaryUsage.inputTokens
    let tokensOut = primaryUsage.outputTokens
    let cacheReadTokens = primaryUsage.cachedInputTokens
    const cacheWriteTokens = 0 // not exposed by v6 usage today; see run-chat-turn comment

    let costUsd = estimateCost(
        {
            input: tokensIn,
            output: tokensOut,
            cacheRead: cacheReadTokens,
            cacheWrite: cacheWriteTokens,
        },
        selection.modelId
    )
    let costUsdMicro = Math.max(0, Math.round(costUsd * 1_000_000))

    // ── 7. Empty-recovery classifier ────────────────────────────────
    const primaryText = typeof primaryResult.text === 'string' ? primaryResult.text : ''
    const primaryToolCalls = Array.isArray(primaryResult.toolCalls)
        ? primaryResult.toolCalls
        : []
    const isToolLoopNoText = primaryText.trim().length === 0 && primaryToolCalls.length > 0
    const recoveryDecision = decideEmptyRecovery({
        mode: recoveryMode,
        isToolLoopNoText,
        fallbackText: args.emptyRecoveryFallback ?? '',
    })

    // ── 7b. Enforce-mode synthesis call ─────────────────────────────
    // No writer to inject into — the synthesised text is concatenated
    // onto `result.text` and the second-call usage rolls into the
    // combined totals. Same Anthropic-cache-friendly arg shape as
    // runChatTurn's stream injection: re-use the cached system +
    // tools object identity, toolChoice 'none', stepCountIs(1).
    let synthesisAttempted = false
    let synthesisText = ''
    let synthFinishedAt: Date | null = null
    if (recoveryDecision.triggered && recoveryDecision.mode === 'enforce') {
        synthesisAttempted = true
        try {
            const responseMessages = Array.isArray(primaryResult.response?.messages)
                ? primaryResult.response.messages
                : []
            const synthesisInstruction =
                recoveryDecision.fallbackText && recoveryDecision.fallbackText.length > 0
                    ? `The previous assistant turn invoked one or more tools and received valid results, but produced zero user-visible text. Summarise the tool output for the user in one short paragraph (1-3 sentences). If you cannot, reply with exactly: ${recoveryDecision.fallbackText}`
                    : 'The previous assistant turn invoked one or more tools and received valid results, but produced zero user-visible text. Summarise the tool output for the user in one short paragraph (1-3 sentences).'

            const synthesisResult = await generateText({
                model,
                system: cached.system,
                messages: [
                    ...userMessages,
                    ...responseMessages,
                    { role: 'user', content: synthesisInstruction },
                ],
                tools: cached.tools,
                toolChoice: 'none',
                stopWhen: stepCountIs(1),
                abortSignal: args.abortSignal,
                ...(typeof args.maxOutputTokens === 'number'
                    ? { maxOutputTokens: args.maxOutputTokens }
                    : {}),
            })

            const synthText = typeof synthesisResult.text === 'string' ? synthesisResult.text : ''
            synthesisText =
                synthText.trim().length > 0
                    ? synthText
                    : recoveryDecision.fallbackText ?? ''
            const synthUsage = readUsage(synthesisResult)
            tokensIn += synthUsage.inputTokens
            tokensOut += synthUsage.outputTokens
            cacheReadTokens += synthUsage.cachedInputTokens

            costUsd = estimateCost(
                {
                    input: tokensIn,
                    output: tokensOut,
                    cacheRead: cacheReadTokens,
                    cacheWrite: cacheWriteTokens,
                },
                selection.modelId
            )
            costUsdMicro = Math.max(0, Math.round(costUsd * 1_000_000))
            synthFinishedAt = clock.now()
        } catch (e) {
            // Synthesis failed — fall back to the locale fallback if
            // we have one, otherwise leave the primary empty text
            // alone. We DO NOT throw: the primary turn succeeded;
            // synthesis is best-effort recovery on top.
            logger.error('runOneShotTurn enforce-mode synthesis call failed', {
                turnId,
                error: e instanceof Error ? e.message : String(e),
            })
            synthesisText = recoveryDecision.fallbackText ?? ''
        }
    }

    // ── 8. Compose final text + tool-call summary ───────────────────
    const finalText =
        synthesisText.length > 0
            ? primaryText.length > 0
                ? `${primaryText}\n\n${synthesisText}`
                : synthesisText
            : primaryText
    const toolCallSummary = summariseToolCalls(primaryResult)

    // ── 9. Persist completed turn row ───────────────────────────────
    const finishedAt = synthFinishedAt ?? clock.now()
    const durationMs = finishedAt.getTime() - startedAt.getTime()
    const finalTurn: TurnRecord = {
        id: turnId,
        threadId: args.threadId,
        tenantId: args.ctx.tenantId,
        role: 'assistant',
        content: finalText,
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
    if (recoveryDecision.triggered && recoveryDecision.persistedErrorCode) {
        finalTurn.metadata = {
            ...(finalTurn.metadata ?? {}),
            empty_recovery_code: recoveryDecision.persistedErrorCode,
        }
    }
    try {
        await args.ports.turnStore.upsert(finalTurn)
    } catch (e) {
        logger.error('runOneShotTurn turnStore.upsert failed', {
            turnId,
            error: e instanceof Error ? e.message : String(e),
        })
    }

    // ── 10. Empty-recovery telemetry + warn ─────────────────────────
    if (recoveryDecision.triggered) {
        logger.warn('runOneShotTurn empty-recovery classifier triggered', {
            turnId,
            threadId: args.threadId,
            tenantId: args.ctx.tenantId,
            mode: recoveryDecision.mode,
            persistedErrorCode: recoveryDecision.persistedErrorCode,
        })
        void telemetry.emit([
            {
                type: 'turn.empty_recovery',
                turnId,
                threadId: args.threadId,
                tenantId: args.ctx.tenantId,
                decision: recoveryDecision,
                occurredAt: finishedAt,
            },
        ])
    }

    // ── 11. Post-call quota record ──────────────────────────────────
    if (args.ports.quotaStore) {
        args.ports.quotaStore
            .record({
                tenantId: args.ctx.tenantId,
                surface: args.ctx.transport,
                tokensIn,
                tokensOut,
                cacheReadTokens,
                cacheWriteTokens,
                toolCalls: primaryToolCalls.length,
                costUsdMicro,
                modelId: selection.modelId,
                occurredAt: finishedAt,
            })
            .catch((e: unknown) => {
                logger.warn('runOneShotTurn quotaStore.record failed', {
                    turnId,
                    error: e instanceof Error ? e.message : String(e),
                })
            })
    }

    // ── 12. turn.finalized telemetry ────────────────────────────────
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
            logger.error('runOneShotTurn onTurnFinalized hook threw', {
                turnId,
                error: e instanceof Error ? e.message : String(e),
            })
        }
    }

    return {
        text: finalText,
        toolCalls: toolCallSummary,
        usage: {
            tokensIn,
            tokensOut,
            cacheReadTokens,
            cacheWriteTokens,
            costUsdMicro,
        },
        durationMs,
        modelId: selection.modelId,
        tier: selection.tier,
        selectionReason: selection.reason,
        finishReason: typeof primaryResult.finishReason === 'string'
            ? primaryResult.finishReason
            : 'other',
        emptyRecovery: {
            triggered: recoveryDecision.triggered,
            attempted: synthesisAttempted,
            mode: recoveryDecision.mode,
        },
    }
}

/** Read usage off a `generateText` result tolerant of partial / missing fields. */
function readUsage(result: { usage?: unknown; totalUsage?: unknown }): {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
} {
    // Prefer `totalUsage` when present (multi-step tool loops roll into it).
    // Fall back to single-step `usage` for v6 implementations that haven't
    // populated totalUsage yet (and for the synthesis call where the two
    // are equivalent because stopWhen=1).
    const raw = (result.totalUsage ?? result.usage ?? null) as {
        inputTokens?: number
        outputTokens?: number
        cachedInputTokens?: number
    } | null
    return {
        inputTokens: raw?.inputTokens ?? 0,
        outputTokens: raw?.outputTokens ?? 0,
        cachedInputTokens: raw?.cachedInputTokens ?? 0,
    }
}

/**
 * Project a `GenerateTextResult.toolCalls + toolResults` pair into
 * the public summary shape. Joins by `toolCallId` so callers see one
 * row per call with the result inline. Errors from `toolResults` are
 * mapped onto the same row so callers can render a unified history.
 */
function summariseToolCalls(result: {
    toolCalls?: unknown
    toolResults?: unknown
}): RunOneShotTurnToolCall[] {
    const calls = Array.isArray(result.toolCalls)
        ? (result.toolCalls as Array<{
              toolName?: string
              toolCallId?: string
              input?: unknown
          }>)
        : []
    const results = Array.isArray(result.toolResults)
        ? (result.toolResults as Array<{
              toolCallId?: string
              output?: unknown
              error?: unknown
          }>)
        : []
    const resultIndex = new Map<string, { output?: unknown; error?: unknown }>()
    for (const r of results) {
        if (typeof r.toolCallId === 'string') {
            resultIndex.set(r.toolCallId, { output: r.output, error: r.error })
        }
    }
    return calls.map((c) => {
        const callId = typeof c.toolCallId === 'string' ? c.toolCallId : ''
        const matched = resultIndex.get(callId)
        const summary: RunOneShotTurnToolCall = {
            name: typeof c.toolName === 'string' ? c.toolName : '',
            callId,
            input: c.input,
        }
        if (matched) {
            if (matched.error !== undefined) {
                const errObj = matched.error as { code?: unknown; message?: unknown } | string
                if (typeof errObj === 'string') {
                    summary.error = { code: 'tool_error', message: errObj }
                } else {
                    summary.error = {
                        code: typeof errObj.code === 'string' ? errObj.code : 'tool_error',
                        message:
                            typeof errObj.message === 'string'
                                ? errObj.message
                                : 'tool error',
                    }
                }
            } else if (matched.output !== undefined) {
                summary.result = matched.output
            }
        }
        return summary
    })
}

/**
 * Compose a turn id. Same shape as runChatTurn so cross-channel
 * analytics can join on a consistent prefix.
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
