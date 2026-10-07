import { describe, expect, it } from 'vitest'

import {
    estimateTurnCost,
    readProviderUsage,
    readRequestUsages,
    readResultUsage,
    sumTurnUsage,
} from './usage.js'

describe('readProviderUsage', () => {
    it('reads both cache legs from inputTokenDetails', () => {
        expect(
            readProviderUsage({
                inputTokens: 1000,
                outputTokens: 50,
                inputTokenDetails: {
                    noCacheTokens: 200,
                    cacheReadTokens: 500,
                    cacheWriteTokens: 300,
                },
            })
        ).toEqual({
            inputTokens: 1000,
            outputTokens: 50,
            cacheReadTokens: 500,
            cacheWriteTokens: 300,
        })
    })

    it('returns inputTokens as the provider TOTAL, never pre-split', () => {
        // The split belongs to usageFromProvider. A reader that subtracted
        // here would make the two subtract twice and under-bill.
        const usage = readProviderUsage({
            inputTokens: 1000,
            outputTokens: 0,
            inputTokenDetails: { cacheReadTokens: 700, cacheWriteTokens: 100 },
        })

        expect(usage.inputTokens).toBe(1000)
    })

    it('falls back to the deprecated cachedInputTokens for the read leg', () => {
        const usage = readProviderUsage({
            inputTokens: 900,
            outputTokens: 10,
            cachedInputTokens: 400,
        })

        expect(usage.cacheReadTokens).toBe(400)
        // No fallback exists for the write leg: a provider that does not
        // report one has none to bill.
        expect(usage.cacheWriteTokens).toBe(0)
    })

    it('prefers inputTokenDetails over the deprecated field when both are present', () => {
        const usage = readProviderUsage({
            inputTokens: 900,
            outputTokens: 10,
            cachedInputTokens: 111,
            inputTokenDetails: { cacheReadTokens: 400 },
        })

        expect(usage.cacheReadTokens).toBe(400)
    })

    it('yields zeros rather than NaN for null / missing usage', () => {
        expect(readProviderUsage(null)).toEqual({
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        })
        expect(readProviderUsage(undefined)).toEqual({
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        })
        expect(readProviderUsage({})).toEqual({
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        })
    })
})

describe('readResultUsage', () => {
    it('prefers totalUsage so a multi-step tool loop is priced whole', () => {
        const usage = readResultUsage({
            usage: {
                inputTokens: 10,
                outputTokens: 1,
                inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
            totalUsage: {
                inputTokens: 5000,
                outputTokens: 200,
                inputTokenDetails: { cacheReadTokens: 4000, cacheWriteTokens: 500 },
            },
        })

        expect(usage.inputTokens).toBe(5000)
        expect(usage.cacheReadTokens).toBe(4000)
        expect(usage.cacheWriteTokens).toBe(500)
    })

    it('falls back to the single-step usage when totalUsage is absent', () => {
        const usage = readResultUsage({
            usage: { inputTokens: 42, outputTokens: 7 },
        })

        expect(usage.inputTokens).toBe(42)
        expect(usage.outputTokens).toBe(7)
    })
})

describe('readRequestUsages', () => {
    const step = (inputTokens: number, outputTokens: number) => ({
        usage: { inputTokens, outputTokens, inputTokenDetails: { cacheReadTokens: 0 } },
    })

    it('returns one usage per step, not the last step alone', () => {
        // The SDK's `usage` is the LAST step; pricing it dropped the rest.
        const requests = readRequestUsages({
            steps: [step(30_000, 100), step(31_000, 120), step(32_000, 80)],
            usage: { inputTokens: 32_000, outputTokens: 80 },
        })

        expect(requests.map((u) => u.inputTokens)).toEqual([30_000, 31_000, 32_000])
        expect(sumTurnUsage(requests)).toEqual({
            inputTokens: 93_000,
            outputTokens: 300,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        })
    })

    it('falls back to the result usage when there are no steps', () => {
        expect(readRequestUsages({ totalUsage: { inputTokens: 10, outputTokens: 2 } })).toEqual([
            { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        ])
    })

    it('falls back when every step reports nothing', () => {
        expect(
            readRequestUsages({ steps: [{}, { usage: null }], usage: { inputTokens: 7, outputTokens: 1 } })
        ).toEqual([{ inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }])
    })
})

describe('estimateTurnCost', () => {
    it('prices a Haiku 5.5 tool loop on the short card even when the sum crosses 100k', () => {
        const requests = readRequestUsages({
            steps: [step(40_000, 0), step(40_000, 0), step(40_000, 0)],
        })
        // 3 x 40k at $0.10/M, not 120k at $0.50/M.
        expect(estimateTurnCost(requests, 'claude-haiku-5-5')).toBeCloseTo(0.012, 9)
    })

    it('splits the cache legs out of each request total before pricing', () => {
        const requests = [
            { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 9_000, cacheWriteTokens: 0 },
        ]
        // 1k uncached at $1/M + 9k read at $0.10/M (Haiku 4.5).
        expect(estimateTurnCost(requests, 'claude-haiku-4-5-20251001')).toBeCloseTo(0.0019, 9)
    })

    function step(inputTokens: number, outputTokens: number) {
        return { usage: { inputTokens, outputTokens } }
    }
})
