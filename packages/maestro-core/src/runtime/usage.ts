/**
 * One reader for a provider usage block.
 *
 * ## Why this exists
 *
 * Three call sites inside the runtime narrowed the AI SDK usage shape by
 * hand — `runChatTurn`'s `onFinish`, its synthesis `onFinish`, and
 * `runOneShotTurn`'s `readUsage` — and all three agreed on the same two
 * mistakes:
 *
 *   1. They read `usage.cachedInputTokens`, which the SDK marks
 *      `@deprecated` in favour of `inputTokenDetails.cacheReadTokens`.
 *   2. They hardcoded `const cacheWriteTokens = 0` under a comment saying
 *      the field was "not exposed by v6 usage today". It is:
 *      `inputTokenDetails.cacheWriteTokens`, standard across providers.
 *
 * The second one is not cosmetic. `inputTokens` is the provider's TOTAL
 * prompt size — for Anthropic, `noCache + cacheWrite + cacheRead` — so a
 * cache-write token that never gets reported as such is still inside
 * `inputTokens` and gets billed at the FULL input rate. Anthropic bills a
 * 5m write at ≈1.25× and a 1h write at ≈2×, so the estimate was low, and
 * it goes further off exactly when a host adopts the longer TTL.
 *
 * That is the same defect class as the `cachedInputTokens` double-count
 * fixed in `usageFromProvider` — one field of the split going unread —
 * which is the argument for one reader instead of three narrowings.
 *
 * ## Contract
 *
 * `inputTokens` is returned AS THE PROVIDER REPORTS IT: a total that
 * already contains both cache figures. Splitting it for pricing is
 * `usageFromProvider`'s job and must not be duplicated here.
 */

import { estimateRequestsCost, usageFromProvider } from '../cost.js'

/**
 * The subset of the AI SDK's `LanguageModelUsage` this kernel prices on.
 * Every field is optional: a provider that reports nothing yields zeros
 * rather than `NaN` propagating into a cost.
 */
export interface ProviderUsageLike {
    inputTokens?: number
    outputTokens?: number
    inputTokenDetails?: {
        noCacheTokens?: number
        cacheReadTokens?: number
        cacheWriteTokens?: number
    }
    /** @deprecated by the SDK — read as a fallback for older providers. */
    cachedInputTokens?: number
}

export interface TurnUsage {
    /** Provider TOTAL prompt size — includes both cache figures. */
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
}

const ZERO: TurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
}

/**
 * Narrow one provider usage block into {@link TurnUsage}.
 *
 * Prefers `inputTokenDetails`, falls back to the deprecated
 * `cachedInputTokens` for the read figure so a host on an older provider
 * keeps the accounting it had. There is no fallback for the write figure:
 * a provider that does not report it has none to bill.
 */
export function readProviderUsage(usage: unknown): TurnUsage {
    if (usage === null || typeof usage !== 'object') return { ...ZERO }
    const u = usage as ProviderUsageLike
    const details = u.inputTokenDetails
    return {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadTokens: details?.cacheReadTokens ?? u.cachedInputTokens ?? 0,
        cacheWriteTokens: details?.cacheWriteTokens ?? 0,
    }
}

/**
 * Same narrowing for a `generateText` result, which carries both a
 * per-step `usage` and a cross-step `totalUsage`.
 *
 * `totalUsage` wins when present: a multi-step tool loop rolls every step
 * into it, and pricing the last step alone under-reports the turn.
 */
export function readResultUsage(result: {
    usage?: unknown
    totalUsage?: unknown
}): TurnUsage {
    return readProviderUsage(result.totalUsage ?? result.usage ?? null)
}

/**
 * One {@link TurnUsage} per provider request of a `generateText` result or
 * a `streamText` `onFinish` event — one per tool-loop step.
 *
 * Pricing needs the requests apart: a model priced by prompt size picks
 * its card per request (see `estimateCost`), and a sum of five steps is
 * not a five-times-larger prompt. It also stops reading the wrong total:
 * the SDK's `usage` is the LAST step only, so a stream's `onFinish` that
 * priced `event.usage` dropped every earlier step of the loop.
 *
 * Falls back to the result's own usage when it carries no steps (a mock,
 * an older SDK) so the turn is never priced at zero.
 */
export function readRequestUsages(result: {
    steps?: unknown
    usage?: unknown
    totalUsage?: unknown
}): TurnUsage[] {
    const steps = Array.isArray(result.steps) ? (result.steps as unknown[]) : []
    const fromSteps = steps.map((step) =>
        readProviderUsage(
            step !== null && typeof step === 'object' ? (step as { usage?: unknown }).usage : null
        )
    )
    if (fromSteps.some((u) => u.inputTokens > 0 || u.outputTokens > 0)) return fromSteps
    return [readResultUsage(result)]
}

/** Sum of the per-request usages — the turn totals persisted on the row. */
export function sumTurnUsage(requests: readonly TurnUsage[]): TurnUsage {
    return requests.reduce<TurnUsage>(
        (total, u) => ({
            inputTokens: total.inputTokens + u.inputTokens,
            outputTokens: total.outputTokens + u.outputTokens,
            cacheReadTokens: total.cacheReadTokens + u.cacheReadTokens,
            cacheWriteTokens: total.cacheWriteTokens + u.cacheWriteTokens,
        }),
        { ...ZERO }
    )
}

/**
 * USD cost of a turn's requests, each split by `usageFromProvider` and
 * priced on its own card.
 */
export function estimateTurnCost(
    requests: readonly TurnUsage[],
    modelId: string | null | undefined,
    cacheWriteTtl?: '5m' | '1h'
): number {
    return estimateRequestsCost(
        requests.map((u) =>
            usageFromProvider({
                inputTokens: u.inputTokens,
                outputTokens: u.outputTokens,
                cachedInputTokens: u.cacheReadTokens,
                cacheWriteTokens: u.cacheWriteTokens,
                cacheWriteTtl,
            })
        ),
        modelId
    )
}
