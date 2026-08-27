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
