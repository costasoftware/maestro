import { describe, expect, it } from 'vitest'

import { BLENDED_PRICING, estimateCost, MODEL_PRICING } from './cost.js'

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
