import { describe, expect, it } from 'vitest'

import { mapModelIdToOpenAI, shouldFallback } from './providers.js'

describe('shouldFallback', () => {
    it('returns false for non-Error values', () => {
        expect(shouldFallback('boom')).toBe(false)
        expect(shouldFallback(null)).toBe(false)
        expect(shouldFallback(undefined)).toBe(false)
        expect(shouldFallback({ message: 'boom' })).toBe(false)
    })

    it('returns false for AiQuotaDeniedError by name (intentional deny)', () => {
        const err = new Error('AI quota exceeded')
        err.name = 'AiQuotaDeniedError'
        expect(shouldFallback(err)).toBe(false)
    })

    it('returns false for AbortError (user cancelled)', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        expect(shouldFallback(err)).toBe(false)
    })

    it('returns false for content-policy errors', () => {
        expect(shouldFallback(new Error('content_policy violation'))).toBe(false)
        expect(shouldFallback(new Error('hit the content policy filter'))).toBe(false)
    })

    it('returns true on network failures', () => {
        expect(shouldFallback(new Error('fetch failed'))).toBe(true)
        expect(shouldFallback(new Error('connect ECONNREFUSED'))).toBe(true)
        expect(shouldFallback(new Error('getaddrinfo ENOTFOUND'))).toBe(true)
        expect(shouldFallback(new Error('socket ETIMEDOUT'))).toBe(true)
    })

    it('returns true on timeouts', () => {
        const err = new Error('took too long')
        err.name = 'TimeoutError'
        expect(shouldFallback(err)).toBe(true)
        expect(shouldFallback(new Error('request timeout'))).toBe(true)
    })

    it('returns true on rate-limit text phrases', () => {
        expect(
            shouldFallback(
                new Error("exceed your organization's rate limit of 30,000 input tokens per minute")
            )
        ).toBe(true)
        expect(shouldFallback(new Error('rate_limit_error from provider'))).toBe(true)
    })

    it('returns true on 5xx status codes parsed from message', () => {
        expect(shouldFallback(new Error('503 Service Unavailable from provider'))).toBe(true)
        expect(shouldFallback(new Error('500 Internal Server Error'))).toBe(true)
    })

    it('returns false on 4xx caller errors', () => {
        expect(shouldFallback(new Error('400 Bad Request'))).toBe(false)
        expect(shouldFallback(new Error('401 Unauthorized'))).toBe(false)
        expect(shouldFallback(new Error('403 Forbidden'))).toBe(false)
    })

    it('returns false on unrecognised messages (conservative default)', () => {
        expect(shouldFallback(new Error('something weird happened'))).toBe(false)
    })
})

describe('mapModelIdToOpenAI', () => {
    it('maps Haiku ids to gpt-4o-mini', () => {
        expect(mapModelIdToOpenAI('claude-haiku-4-5-20251001')).toBe('gpt-4o-mini')
        expect(mapModelIdToOpenAI('claude-haiku-3-5')).toBe('gpt-4o-mini')
    })

    it('maps Sonnet ids to gpt-4o', () => {
        expect(mapModelIdToOpenAI('claude-sonnet-4-6')).toBe('gpt-4o')
        expect(mapModelIdToOpenAI('claude-sonnet-3-7-20250101')).toBe('gpt-4o')
    })

    it('maps Opus ids to gpt-4o', () => {
        expect(mapModelIdToOpenAI('claude-opus-4-0')).toBe('gpt-4o')
    })

    it('defaults unknown ids to gpt-4o-mini (cheaper)', () => {
        expect(mapModelIdToOpenAI('some-future-model')).toBe('gpt-4o-mini')
        expect(mapModelIdToOpenAI(null)).toBe('gpt-4o-mini')
        expect(mapModelIdToOpenAI(undefined)).toBe('gpt-4o-mini')
    })

    it('is case-insensitive on substring match', () => {
        expect(mapModelIdToOpenAI('Claude-Sonnet-FOO')).toBe('gpt-4o')
    })
})
