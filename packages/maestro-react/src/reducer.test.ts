import { describe, expect, it } from 'vitest'

import type { MaestroMessage } from './message.js'
import type { MaestroEvent } from './protocol.js'
import {
    abortMessage,
    applyEvent,
    createAssistantMessage,
    createUserMessage,
    failMessage,
} from './reducer.js'

type DataMap = Record<string, unknown>

function fresh(): MaestroMessage<DataMap> {
    return createAssistantMessage<DataMap>({ id: 'a1', createdAt: 1 })
}

function apply(
    events: ReadonlyArray<MaestroEvent>,
    seed: MaestroMessage<DataMap> = fresh(),
): MaestroMessage<DataMap> {
    return events.reduce(applyEvent, seed)
}

describe('reducer — constructors', () => {
    it('creates a pending assistant message', () => {
        const msg = createAssistantMessage<DataMap>({ id: 'a1', createdAt: 5 })
        expect(msg).toMatchObject({
            id: 'a1',
            role: 'assistant',
            text: '',
            status: 'pending',
            createdAt: 5,
        })
        expect(msg.toolCalls).toHaveLength(0)
        expect(msg.citations).toHaveLength(0)
        expect(msg.data).toHaveLength(0)
    })

    it('creates a complete user message', () => {
        const msg = createUserMessage<DataMap>({
            id: 'u1',
            text: 'hello',
            createdAt: 7,
        })
        expect(msg).toMatchObject({
            id: 'u1',
            role: 'user',
            text: 'hello',
            status: 'complete',
            createdAt: 7,
            completedAt: 7,
        })
    })
})

describe('reducer — text-delta', () => {
    it('accumulates text and flips to streaming', () => {
        const out = apply([
            { type: 'text-delta', delta: 'foo ' },
            { type: 'text-delta', delta: 'bar' },
        ])
        expect(out.text).toBe('foo bar')
        expect(out.status).toBe('streaming')
    })
})

describe('reducer — tool lifecycle', () => {
    it('tool-call adds a pending call', () => {
        const out = apply([
            { type: 'tool-call', callId: 'c1', name: 'x', input: { a: 1 } },
        ])
        expect(out.toolCalls).toHaveLength(1)
        expect(out.toolCalls[0]).toMatchObject({
            callId: 'c1',
            name: 'x',
            input: { a: 1 },
            status: 'pending',
        })
    })

    it('duplicate tool-call is idempotent (keeps first)', () => {
        const out = apply([
            { type: 'tool-call', callId: 'c1', name: 'x', input: 1 },
            { type: 'tool-call', callId: 'c1', name: 'y', input: 2 },
        ])
        expect(out.toolCalls).toHaveLength(1)
        expect(out.toolCalls[0]?.name).toBe('x')
    })

    it('tool-progress promotes call to running and appends progress', () => {
        const out = apply([
            { type: 'tool-call', callId: 'c1', name: 'x', input: 1 },
            {
                type: 'tool-progress',
                callId: 'c1',
                message: 'step 1',
                data: { p: 1 },
            },
            { type: 'tool-progress', callId: 'c1', message: 'step 2' },
        ])
        expect(out.toolCalls[0]?.status).toBe('running')
        expect(out.toolCalls[0]?.progress).toHaveLength(2)
        expect(out.toolCalls[0]?.progress[0]).toEqual({
            message: 'step 1',
            data: { p: 1 },
        })
    })

    it('tool-progress for unknown callId is dropped silently', () => {
        const out = apply([
            { type: 'tool-progress', callId: 'rogue', message: 'x' },
        ])
        expect(out.toolCalls).toHaveLength(0)
        expect(out.status).toBe('streaming')
    })

    it('tool-result success closes the call', () => {
        const out = apply([
            { type: 'tool-call', callId: 'c1', name: 'x', input: 1 },
            { type: 'tool-result', callId: 'c1', result: { ok: true } },
        ])
        expect(out.toolCalls[0]?.status).toBe('success')
        expect(out.toolCalls[0]?.result).toEqual({ ok: true })
    })

    it('tool-result error flips the call to errored', () => {
        const out = apply([
            { type: 'tool-call', callId: 'c1', name: 'x', input: 1 },
            {
                type: 'tool-result',
                callId: 'c1',
                error: { code: 'X', message: 'y' },
            },
        ])
        expect(out.toolCalls[0]?.status).toBe('errored')
        expect(out.toolCalls[0]?.error?.code).toBe('X')
    })

    it('tool-result without preceding call synthesises a placeholder', () => {
        const out = apply([
            { type: 'tool-result', callId: 'orphan', result: 42 },
        ])
        expect(out.toolCalls).toHaveLength(1)
        expect(out.toolCalls[0]).toMatchObject({
            callId: 'orphan',
            name: '(unknown)',
            status: 'success',
            result: 42,
        })
    })
})

describe('reducer — citations + data', () => {
    it('citation flattens source fields', () => {
        const out = apply([
            {
                type: 'citation',
                callId: 'c1',
                source: {
                    id: 'd1',
                    url: 'https://e',
                    title: 'T',
                    snippet: 's',
                },
            },
        ])
        expect(out.citations[0]).toEqual({
            id: 'd1',
            url: 'https://e',
            title: 'T',
            snippet: 's',
            callId: 'c1',
        })
    })

    it('data event appends key/value/callId entry', () => {
        const out = apply([
            { type: 'data', key: 'rag.quota', value: { left: 3 } },
        ])
        expect(out.data[0]).toEqual({
            key: 'rag.quota',
            value: { left: 3 },
            callId: undefined,
        })
    })
})

describe('reducer — terminal events', () => {
    it('done flips status to complete', () => {
        const out = apply([
            { type: 'text-delta', delta: 'hi' },
            { type: 'done', metadata: { usage: 1 } },
        ])
        expect(out.status).toBe('complete')
        expect(out.metadata).toEqual({ usage: 1 })
        expect(out.completedAt).toBeTypeOf('number')
    })

    it('done.text is adopted ONLY when no text-delta was seen (D4)', () => {
        const fromDeltas = apply([
            { type: 'text-delta', delta: 'streamed' },
            { type: 'done', text: 'restated-IGNORED' },
        ])
        expect(fromDeltas.text).toBe('streamed')

        const restated = apply([{ type: 'done', text: 'restated-USED' }])
        expect(restated.text).toBe('restated-USED')
    })

    it('error flips status to errored and captures the error', () => {
        const out = apply([
            { type: 'error', code: 'X', message: 'boom' },
        ])
        expect(out.status).toBe('errored')
        expect(out.error).toEqual({ code: 'X', message: 'boom' })
    })

    it('events after terminal status are dropped', () => {
        const errored = apply([
            { type: 'error', message: 'boom' },
        ])
        const noChange = apply([{ type: 'text-delta', delta: 'late' }], errored)
        expect(noChange).toBe(errored)
    })
})

describe('reducer — abort + fail helpers', () => {
    it('abortMessage marks pending → aborted', () => {
        const out = abortMessage(fresh(), 99)
        expect(out.status).toBe('aborted')
        expect(out.completedAt).toBe(99)
    })

    it('abortMessage on already-complete is a no-op', () => {
        const done = apply([{ type: 'done' }])
        const out = abortMessage(done)
        expect(out).toBe(done)
    })

    it('failMessage attaches a maestro error', () => {
        const out = failMessage(fresh(), { message: 'boom' }, 11)
        expect(out.status).toBe('errored')
        expect(out.error?.message).toBe('boom')
        expect(out.completedAt).toBe(11)
    })
})

/**
 * Compile-time guarantees for the `TDataMap` generic. These tests
 * never assert runtime behaviour — they exist so the type checker
 * fails CI if the narrowing breaks. The trailing `expect` is a
 * smoke check so vitest counts the test.
 */
describe('reducer — typed data narrowing (compile-time)', () => {
    interface TypedMap {
        'rag.quota': { remaining: number }
        'chart.matches': { count: number }
    }

    it('MaestroData<TMap> narrows `value` by `key` discriminator', () => {
        const msg = createAssistantMessage<TypedMap>({ id: 'a' })
        const withData = applyEvent(msg, {
            type: 'data',
            key: 'rag.quota',
            value: { remaining: 3 },
        })
        // The cast in the reducer is one-way; consumers iterate with
        // a switch and TS narrows correctly:
        for (const entry of withData.data) {
            if (entry.key === 'rag.quota') {
                // entry.value should be { remaining: number }
                const remaining: number = entry.value.remaining
                expect(remaining).toBe(3)
            } else if (entry.key === 'chart.matches') {
                // Compile-time check only.
                const count: number = entry.value.count
                expect(count).toBeTypeOf('number')
            }
        }
    })
})
