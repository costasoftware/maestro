import { describe, expect, it } from 'vitest'

import { readProviderUsage, readResultUsage } from './usage.js'

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
