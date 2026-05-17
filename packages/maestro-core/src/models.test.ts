import { describe, expect, it } from 'vitest'

import { selectChatModel } from './models.js'

const MODELS = { fast: 'fast-id', smart: 'smart-id' }

describe('selectChatModel', () => {
    it('routes empty messages to fast', () => {
        const r = selectChatModel({ userMessage: '   ', models: MODELS })
        expect(r.tier).toBe('fast')
        expect(r.modelId).toBe('fast-id')
        expect(r.reason).toBe('empty')
    })

    it('routes short lookups to fast by default', () => {
        const r = selectChatModel({ userMessage: 'how many bookings today?', models: MODELS })
        expect(r.tier).toBe('fast')
        expect(r.reason).toBe('default-fast')
    })

    it('routes long messages to smart', () => {
        const long = 'a'.repeat(250)
        const r = selectChatModel({ userMessage: long, models: MODELS })
        expect(r.tier).toBe('smart')
        expect(r.modelId).toBe('smart-id')
        expect(r.reason).toBe('long-message')
    })

    it('routes deep-thread turns to smart', () => {
        const r = selectChatModel({ userMessage: 'hi', turnIndex: 5, models: MODELS })
        expect(r.tier).toBe('smart')
        expect(r.reason).toBe('deep-thread')
    })

    it('routes PT mutation keywords to smart', () => {
        const r = selectChatModel({
            userMessage: 'agendar corte com joão amanhã às 10',
            models: MODELS,
        })
        expect(r.tier).toBe('smart')
        expect(r.reason).toMatch(/^keyword:/)
    })

    it('routes EN mutation keywords to smart', () => {
        const r = selectChatModel({
            userMessage: 'cancel my appointment please',
            models: MODELS,
        })
        expect(r.tier).toBe('smart')
        expect(r.reason).toMatch(/^keyword:/)
    })

    it('forceTier=smart overrides heuristics', () => {
        const r = selectChatModel({
            userMessage: 'hi',
            forceTier: 'smart',
            models: MODELS,
        })
        expect(r.tier).toBe('smart')
        expect(r.reason).toBe('forced')
    })

    it('forceTier=fast overrides heuristics even with a long message', () => {
        const r = selectChatModel({
            userMessage: 'a'.repeat(500),
            forceTier: 'fast',
            models: MODELS,
        })
        expect(r.tier).toBe('fast')
        expect(r.reason).toBe('forced')
    })

    it('models.force short-circuits to a literal model id', () => {
        const r = selectChatModel({
            userMessage: 'agendar corte', // would normally be smart
            models: { ...MODELS, force: 'canary-model' },
        })
        expect(r.modelId).toBe('canary-model')
        expect(r.reason).toBe('force-override')
    })

    it('respects custom smartKeywords (replacing defaults)', () => {
        const r = selectChatModel({
            userMessage: 'agendar corte', // matches default but not custom
            models: MODELS,
            smartKeywords: ['totally-different-trigger'],
        })
        expect(r.tier).toBe('fast')
    })

    it('respects custom smartLengthThreshold', () => {
        const r = selectChatModel({
            userMessage: 'a'.repeat(50),
            models: MODELS,
            smartLengthThreshold: 30,
        })
        expect(r.tier).toBe('smart')
        expect(r.reason).toBe('long-message')
    })

    it('respects custom smartTurnThreshold', () => {
        const r = selectChatModel({
            userMessage: 'hi',
            turnIndex: 2,
            models: MODELS,
            smartTurnThreshold: 2,
        })
        expect(r.tier).toBe('smart')
        expect(r.reason).toBe('deep-thread')
    })

    it('an empty smartKeywords array disables keyword routing', () => {
        const r = selectChatModel({
            userMessage: 'cancel my appointment', // default would match
            models: MODELS,
            smartKeywords: [],
        })
        expect(r.tier).toBe('fast')
    })
})
