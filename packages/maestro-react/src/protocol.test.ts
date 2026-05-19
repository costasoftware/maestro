import { describe, expect, it } from 'vitest'

import {
    assertNever,
    type CitationEvent,
    type DataEvent,
    type DoneEvent,
    type ErrorEvent,
    MAESTRO_EVENT_TYPES,
    MAESTRO_PROTOCOL_VERSION,
    type MaestroAttachment,
    type MaestroEvent,
    type MaestroEventType,
    type TextDeltaEvent,
    type ToolCallEvent,
    type ToolProgressEvent,
    type ToolResultEvent,
} from './protocol.js'

describe('MaestroChatProtocol — shape', () => {
    it('text-delta accepts a delta string', () => {
        const e: TextDeltaEvent = { type: 'text-delta', delta: 'hello' }
        expect(e.delta).toBe('hello')
    })

    it('tool-call requires callId, name, input', () => {
        const e: ToolCallEvent = {
            type: 'tool-call',
            callId: 'call_1',
            name: 'searchBookings',
            input: { q: 'tomorrow' },
        }
        expect(e.callId).toBe('call_1')
        expect(e.name).toBe('searchBookings')
    })

    it('tool-progress is optional in both message and data', () => {
        const bare: ToolProgressEvent = {
            type: 'tool-progress',
            callId: 'call_1',
        }
        const full: ToolProgressEvent = {
            type: 'tool-progress',
            callId: 'call_1',
            message: 'fetching page 2',
            data: { page: 2 },
        }
        expect(bare.callId).toBe(full.callId)
    })

    it('tool-result success carries result; failure carries error', () => {
        const ok: ToolResultEvent = {
            type: 'tool-result',
            callId: 'call_1',
            result: { count: 3 },
        }
        const ko: ToolResultEvent = {
            type: 'tool-result',
            callId: 'call_1',
            error: { code: 'TIMEOUT', message: 'gateway timed out' },
        }
        expect(ok.result).toEqual({ count: 3 })
        expect(ko.error?.code).toBe('TIMEOUT')
    })

    it('citation source fields are all optional', () => {
        const minimal: CitationEvent = {
            type: 'citation',
            source: {},
        }
        const full: CitationEvent = {
            type: 'citation',
            callId: 'call_2',
            source: {
                id: 'doc_42',
                url: 'https://example.com/a',
                title: 'A',
                snippet: 's',
            },
        }
        expect(minimal.source).toEqual({})
        expect(full.source.id).toBe('doc_42')
    })

    it('data event requires a key + value', () => {
        const e: DataEvent = {
            type: 'data',
            key: 'rag.quota_warning',
            value: { remaining: 3 },
        }
        expect(e.key).toBe('rag.quota_warning')
    })

    it('error event allows optional code', () => {
        const e: ErrorEvent = { type: 'error', message: 'upstream down' }
        expect(e.code).toBeUndefined()
    })

    it('done allows optional text + metadata', () => {
        const e: DoneEvent = {
            type: 'done',
            text: 'hello',
            metadata: { usage: { in: 100, out: 50 } },
        }
        expect(e.text).toBe('hello')
    })
})

describe('MaestroChatProtocol — discriminator + exhaustiveness', () => {
    /**
     * Reducer that handles every event type. The `default: assertNever`
     * is a compile-time guarantee: if a new event type is added to
     * `MaestroEvent`, this file will fail to type-check until updated.
     * That breakage IS the test — runtime assertions below are just
     * smoke checks.
     */
    function summarise(event: MaestroEvent): string {
        switch (event.type) {
            case 'text-delta':
                return `text:${event.delta.length}`
            case 'tool-call':
                return `call:${event.name}:${event.callId}`
            case 'tool-progress':
                return `progress:${event.callId}`
            case 'tool-result':
                return event.error
                    ? `result-err:${event.callId}:${event.error.code}`
                    : `result-ok:${event.callId}`
            case 'citation':
                return `cite:${event.source.id ?? event.source.url ?? 'anon'}`
            case 'data':
                return `data:${event.key}`
            case 'error':
                return `error:${event.code ?? 'unknown'}`
            case 'done':
                return `done:${event.text?.length ?? 0}`
            default:
                return assertNever(event)
        }
    }

    it('summarises every event variant', () => {
        const events: readonly MaestroEvent[] = [
            { type: 'text-delta', delta: 'abc' },
            {
                type: 'tool-call',
                callId: 'c1',
                name: 'search',
                input: {},
            },
            { type: 'tool-progress', callId: 'c1' },
            { type: 'tool-result', callId: 'c1', result: {} },
            {
                type: 'tool-result',
                callId: 'c2',
                error: { code: 'X', message: 'y' },
            },
            { type: 'citation', source: { id: 'd1' } },
            { type: 'data', key: 'rag.thing', value: 1 },
            { type: 'error', message: 'boom' },
            { type: 'done' },
        ]
        const out = events.map(summarise)
        expect(out).toEqual([
            'text:3',
            'call:search:c1',
            'progress:c1',
            'result-ok:c1',
            'result-err:c2:X',
            'cite:d1',
            'data:rag.thing',
            'error:unknown',
            'done:0',
        ])
    })

    it('MAESTRO_EVENT_TYPES covers the entire union', () => {
        const fromUnion: ReadonlySet<MaestroEventType> = new Set(
            MAESTRO_EVENT_TYPES,
        )
        // Adding a new event type without updating MAESTRO_EVENT_TYPES
        // will fail this size check AND fail the `satisfies` clause
        // on the constant declaration itself.
        expect(fromUnion.size).toBe(8)
    })

    it('assertNever throws at runtime when called with a bad value', () => {
        // Cast through unknown — purely a runtime guard test.
        expect(() => assertNever('rogue' as unknown as never)).toThrow(
            /unhandled event type/,
        )
    })

    it('exposes a version constant', () => {
        expect(MAESTRO_PROTOCOL_VERSION).toBe('0.2.0-beta')
    })
})

describe('MaestroChatProtocol — attachments (v0.2)', () => {
    it('minimal attachment requires kind + url', () => {
        const a: MaestroAttachment = {
            kind: 'image',
            url: 'https://cdn.example.com/u/abc.png',
        }
        expect(a.kind).toBe('image')
        expect(a.url).toBe('https://cdn.example.com/u/abc.png')
        // Optional fields are absent on a minimal attachment.
        expect(a.mime).toBeUndefined()
        expect(a.name).toBeUndefined()
        expect(a.size).toBeUndefined()
    })

    it('full attachment carries mime, name, size', () => {
        const a: MaestroAttachment = {
            kind: 'file',
            url: 'https://cdn.example.com/u/spec.pdf',
            mime: 'application/pdf',
            name: 'spec.pdf',
            size: 18_432,
        }
        expect(a.mime).toBe('application/pdf')
        expect(a.name).toBe('spec.pdf')
        expect(a.size).toBe(18_432)
    })

    it('kind is an open string — common values pass type-check', () => {
        const values: MaestroAttachment['kind'][] = [
            'image',
            'file',
            'video',
            'audio',
            'application/x-custom',
        ]
        // Smoke check — the assertion below exists only so the loop is
        // observed at runtime. Type-checking is the real test.
        expect(values).toHaveLength(5)
    })

    it('survives JSON round-trip with no field loss', () => {
        const original: MaestroAttachment = {
            kind: 'image',
            url: 'https://cdn.example.com/u/abc.png',
            mime: 'image/png',
            name: 'screenshot.png',
            size: 4096,
        }
        const round = JSON.parse(JSON.stringify(original)) as MaestroAttachment
        expect(round).toEqual(original)
    })
})
