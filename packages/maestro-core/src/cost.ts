/**
 * LLM pricing table + cost estimator.
 *
 * Per-million-token USD rates. Numbers track the Anthropic and OpenAI
 * public pricing pages; update when the providers publish a new
 * default alias.
 *
 * Hosts that need custom rates (private deployments, enterprise
 * negotiated pricing, additional providers) pass an override map
 * through the second argument of `estimateCost` — it merges over the
 * built-in table without mutating it.
 *
 * IMPORTANT: model ids from OpenAI may include date suffixes at
 * runtime (e.g. `gpt-4o-mini-2024-07-18`). `estimateCost` falls
 * through to the blended rate for unknown ids — intentional, so an
 * unrecognised model never crashes the cost call. Add the suffixed id
 * to the table when the provider publishes one.
 */
export interface PricingRow {
    /** Per-million input tokens, USD. */
    input: number
    /** Per-million output tokens, USD. */
    output: number
    /** Per-million cache-read tokens, USD. Anthropic: ~10% of input. OpenAI: 50%. */
    cacheRead: number
    /** Per-million cache-write tokens, USD. Anthropic: ~1.25× input. OpenAI: no extra. */
    cacheWrite: number
}

/**
 * Default model pricing snapshot. Sourced from:
 * - Anthropic: https://www.anthropic.com/pricing (2026 baseline)
 * - OpenAI:    https://openai.com/api/pricing
 */
export const MODEL_PRICING: Record<string, PricingRow> = {
    // ── Anthropic ─────────────────────────────────────────────────
    'claude-haiku-4-5-20251001': {
        input: 1.0,
        output: 5.0,
        cacheRead: 0.1,
        cacheWrite: 1.25,
    },
    'claude-sonnet-4-6': {
        input: 3.0,
        output: 15.0,
        cacheRead: 0.3,
        cacheWrite: 3.75,
    },

    // ── OpenAI (fallback provider) ────────────────────────────────
    'gpt-4o-mini': {
        input: 0.15,
        output: 0.6,
        cacheRead: 0.075, // 50% of input rate
        cacheWrite: 0.15, // no extra charge; matches input
    },
    'gpt-4o': {
        input: 2.5,
        output: 10.0,
        cacheRead: 1.25, // 50% of input
        cacheWrite: 2.5, // matches input
    },
}

/**
 * Blended fallback used when the model id is unknown (date-suffixed
 * OpenAI variants, custom deployments, missing telemetry). Skews
 * Haiku-heavy because the default router lands on fast, but biases up
 * slightly so dashboards never under-report cost.
 *
 * Hosts that surface this on a UI should label it as approximate.
 */
export const BLENDED_PRICING: PricingRow = {
    input: 1.5,
    output: 7.5,
    cacheRead: 0.15,
    cacheWrite: 1.875,
}

export interface TokenUsage {
    /**
     * Input tokens billed at the FULL input rate — i.e. NOT served from the
     * prompt cache. This is the distinction the pricing table draws, so a
     * caller holding a provider usage block must split it first; see
     * {@link usageFromProvider}.
     */
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
}

/**
 * Convert a provider usage block into {@link TokenUsage}.
 *
 * The AI SDK reports `inputTokens` as the TOTAL prompt size, with
 * `cachedInputTokens` a subset of it — not a sibling. Passing both through
 * unchanged bills every cached token twice: once at the full input rate and
 * again at the cache-read rate.
 *
 * On a heavily-cached turn that is not a rounding error. A measured
 * production turn (128k prompt, 99.6% cache hit, Haiku 4.5) reported
 * $0.1414 when the true cost was $0.0138 — 10x over, and the error grows
 * with the cache hit ratio, so the better the caching the worse the number.
 *
 * Clamped at zero: a provider that ever reports `cachedInputTokens` above
 * `inputTokens` must not produce a negative charge.
 */
export function usageFromProvider(usage: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens?: number
    cacheWriteTokens?: number
}): TokenUsage {
    const cacheRead = usage.cachedInputTokens ?? 0
    return {
        input: Math.max(0, usage.inputTokens - cacheRead),
        output: usage.outputTokens,
        cacheRead,
        cacheWrite: usage.cacheWriteTokens ?? 0,
    }
}

/**
 * Estimate USD cost for a token-usage block. When `modelId` matches
 * a known model in `MODEL_PRICING` (or in the optional `customPricing`
 * override map) the exact rate applies; otherwise `BLENDED_PRICING`
 * is used.
 *
 * `customPricing` is shallow-merged on top of the default table — host
 * entries override built-ins when the ids collide.
 */
export function estimateCost(
    usage: TokenUsage,
    modelId?: string | null,
    customPricing?: Record<string, PricingRow>
): number {
    const merged = customPricing
        ? { ...MODEL_PRICING, ...customPricing }
        : MODEL_PRICING
    const price = (modelId && merged[modelId]) || BLENDED_PRICING
    return (
        (usage.input * price.input +
            usage.output * price.output +
            usage.cacheRead * price.cacheRead +
            usage.cacheWrite * price.cacheWrite) /
        1_000_000
    )
}
