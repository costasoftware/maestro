import { describe, expect, it } from 'vitest'

import { BLENDED_PRICING, estimateCost, MODEL_PRICING, usageFromProvider } from './cost.js'

describe('estimateCost', () => {
    it('uses the exact rate for a known model id', () => {
        // 1M Haiku input tokens = $1.00 exactly.
        const cost = estimateCost(
            { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
            'claude-haiku-4-5-20251001'
        )
        expect(cost).toBeCloseTo(1.0, 6)
    })

    it('falls back to BLENDED_PRICING for unknown model ids', () => {
        const cost = estimateCost(
            { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
            'gpt-4o-mini-2024-07-18-some-unknown-suffix'
        )
        expect(cost).toBeCloseTo(BLENDED_PRICING.input, 6)
    })

    it('falls back to BLENDED_PRICING when modelId is null', () => {
        const cost = estimateCost(
            { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
            null
        )
        expect(cost).toBeCloseTo(BLENDED_PRICING.input, 6)
    })

    it('combines all four token classes correctly', () => {
        // Haiku: input=$1, output=$5, cacheRead=$0.10, cacheWrite=$1.25 per M.
        const cost = estimateCost(
            {
                input: 500_000,
                output: 200_000,
                cacheRead: 100_000,
                cacheWrite: 50_000,
            },
            'claude-haiku-4-5-20251001'
        )
        // = 0.5*1 + 0.2*5 + 0.1*0.10 + 0.05*1.25 = 0.5 + 1 + 0.01 + 0.0625 = 1.5725
        expect(cost).toBeCloseTo(1.5725, 4)
    })

    it('honours customPricing overrides over built-in table', () => {
        const customPricing = {
            'claude-haiku-4-5-20251001': {
                input: 10,
                output: 10,
                cacheRead: 10,
                cacheWrite: 10,
            },
        }
        const cost = estimateCost(
            { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
            'claude-haiku-4-5-20251001',
            customPricing
        )
        expect(cost).toBeCloseTo(10, 6)
    })

    it('does not mutate MODEL_PRICING when customPricing supplied', () => {
        const before = MODEL_PRICING['claude-haiku-4-5-20251001']!.input
        estimateCost(
            { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
            'claude-haiku-4-5-20251001',
            { 'claude-haiku-4-5-20251001': { input: 99, output: 0, cacheRead: 0, cacheWrite: 0 } }
        )
        expect(MODEL_PRICING['claude-haiku-4-5-20251001']!.input).toBe(before)
    })

    it('returns 0 for empty usage', () => {
        expect(
            estimateCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-sonnet-4-6')
        ).toBe(0)
    })
})

describe('usageFromProvider', () => {
    it('subtracts cached tokens from the provider total instead of double-billing them', () => {
        // The AI SDK reports `inputTokens` as the TOTAL prompt, with
        // `cachedInputTokens` a subset. Reproduces a measured production turn:
        // 128k prompt, 99.6% cache hit, Haiku 4.5.
        const usage = usageFromProvider({
            inputTokens: 127_983,
            outputTokens: 124,
            cachedInputTokens: 127_536,
        })

        expect(usage.input).toBe(447)
        expect(usage.cacheRead).toBe(127_536)

        const cost = estimateCost(usage, 'claude-haiku-4-5-20251001')
        expect(cost).toBeCloseTo(0.0138, 4)

        // What the un-split shape produced, and why it mattered: 10x over.
        const doubleCounted = estimateCost(
            { input: 127_983, output: 124, cacheRead: 127_536, cacheWrite: 0 },
            'claude-haiku-4-5-20251001'
        )
        expect(doubleCounted).toBeCloseTo(0.1414, 4)
        expect(doubleCounted / cost).toBeGreaterThan(10)
    })

    it('treats a turn with no cache as pure input', () => {
        const usage = usageFromProvider({ inputTokens: 1_000, outputTokens: 10 })
        expect(usage).toEqual({ input: 1_000, output: 10, cacheRead: 0, cacheWrite: 0 })
    })

    it('never bills a negative input when a provider over-reports the cache', () => {
        const usage = usageFromProvider({
            inputTokens: 100,
            outputTokens: 0,
            cachedInputTokens: 250,
        })
        expect(usage.input).toBe(0)
    })

    it('subtracts the cache-WRITE leg from billable input', () => {
        // Anthropic reports inputTokens = noCache + cacheWrite + cacheRead.
        // Leaving the write leg inside `input` bills it at 1.0x when the
        // real rate is 1.25x (5m) or 2x (1h) — silently under-reporting.
        const usage = usageFromProvider({
            inputTokens: 10_000,
            outputTokens: 100,
            cachedInputTokens: 6_000,
            cacheWriteTokens: 3_000,
        })

        expect(usage).toEqual({
            input: 1_000,
            output: 100,
            cacheRead: 6_000,
            cacheWrite: 3_000,
        })
    })

    it('never bills a negative input when both cache legs overflow the total', () => {
        const usage = usageFromProvider({
            inputTokens: 100,
            outputTokens: 0,
            cachedInputTokens: 80,
            cacheWriteTokens: 90,
        })
        expect(usage.input).toBe(0)
    })

    it('carries cacheWriteTtl through, and omits it when unset', () => {
        expect(
            usageFromProvider({
                inputTokens: 10,
                outputTokens: 0,
                cacheWriteTokens: 5,
                cacheWriteTtl: '1h',
            }).cacheWriteTtl
        ).toBe('1h')

        expect(
            usageFromProvider({ inputTokens: 10, outputTokens: 0 })
        ).not.toHaveProperty('cacheWriteTtl')
    })
})

describe('estimateCost cache-write TTL rates', () => {
    it('prices a 1h write above a 5m one on the same tokens', () => {
        // Haiku 4.5: input $1/M, so 5m write $1.25/M and 1h write $2.00/M.
        const base = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }

        expect(estimateCost(base, 'claude-haiku-4-5-20251001')).toBeCloseTo(1.25, 6)
        expect(
            estimateCost({ ...base, cacheWriteTtl: '1h' }, 'claude-haiku-4-5-20251001')
        ).toBeCloseTo(2.0, 6)
    })

    it("treats an absent ttl as 5m, so an un-migrated caller prices unchanged", () => {
        const base = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }

        expect(estimateCost(base, 'claude-sonnet-4-6')).toBe(
            estimateCost({ ...base, cacheWriteTtl: '5m' }, 'claude-sonnet-4-6')
        )
    })

    it('falls back to the 5m rate for a custom row that predates cacheWrite1h', () => {
        // A host's existing customPricing map has no `cacheWrite1h`. It must
        // keep pricing rather than resolve to undefined and yield NaN.
        const cost = estimateCost(
            { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWriteTtl: '1h' },
            'custom-model',
            { 'custom-model': { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 } }
        )

        expect(cost).toBeCloseTo(12.5, 6)
    })

    it('prices an unknown model id off the blended row, 1h included', () => {
        expect(
            estimateCost(
                { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWriteTtl: '1h' },
                'who-knows'
            )
        ).toBeCloseTo(BLENDED_PRICING.cacheWrite1h ?? 0, 6)
    })
})
