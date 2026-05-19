import { describe, expect, it } from 'vitest'

import {
    AI_SDK_CITATIONS_FLOW,
    AI_SDK_HAPPY_PATH,
    AI_SDK_STREAM_ERROR_FLOW,
    AI_SDK_TOOL_ERROR_FLOW,
    AI_SDK_TOOL_FLOW,
} from '../../fixtures/ai-sdk-wire.js'
import type { MaestroEvent } from '../protocol.js'
import { aiSdkTransport } from './ai-sdk.js'
import { sseStream } from './test-utils.js'

function mockFetch(
    frames: ReadonlyArray<{ data: string }>,
    status = 200,
): typeof fetch {
    return (async () =>
        new Response(sseStream(frames), {
            status,
            headers: { 'content-type': 'text/event-stream' },
        })) as unknown as typeof fetch
}

async function run(
    frames: ReadonlyArray<{ data: string }>,
): Promise<MaestroEvent[]> {
    const transport = aiSdkTransport({
        url: 'https://api/x',
        fetch: mockFetch(frames),
    })
    const out: MaestroEvent[] = []
    for await (const e of transport.send({
        messages: [],
        signal: new AbortController().signal,
    })) {
        out.push(e)
    }
    return out
}

describe('aiSdkTransport — happy path', () => {
    it('translates text-delta chunks into MaestroEvents', async () => {
        const out = await run(AI_SDK_HAPPY_PATH)
        expect(out).toEqual([
            { type: 'text-delta', delta: 'Hello ' },
            { type: 'text-delta', delta: 'world' },
            { type: 'done', metadata: undefined },
        ])
    })

    it('skips start, text-start, text-end, start-step, finish-step', async () => {
        const out = await run(AI_SDK_HAPPY_PATH)
        // start/text-start/text-end/start-step/finish-step never surface
        expect(out.find(e => e.type === 'text-delta' && e.delta === '')).toBeUndefined()
        expect(out.filter(e => e.type === 'text-delta')).toHaveLength(2)
    })
})

describe('aiSdkTransport — tool flow', () => {
    it('tool-input-available → tool-call, tool-output-available → tool-result', async () => {
        const out = await run(AI_SDK_TOOL_FLOW)
        expect(out).toEqual([
            {
                type: 'tool-call',
                callId: 'call_42',
                name: 'searchBookings',
                input: { q: 'tomorrow' },
            },
            {
                type: 'tool-result',
                callId: 'call_42',
                result: { count: 3, ids: ['b1', 'b2', 'b3'] },
            },
            { type: 'text-delta', delta: 'Found 3 bookings.' },
            { type: 'done', metadata: undefined },
        ])
    })

    it('tool-output-error becomes a tool-result with error payload', async () => {
        const out = await run(AI_SDK_TOOL_ERROR_FLOW)
        const result = out.find(e => e.type === 'tool-result')
        expect(result).toMatchObject({
            type: 'tool-result',
            callId: 'call_99',
            error: { code: 'TOOL_OUTPUT_ERROR', message: 'booking not found' },
        })
    })
})

describe('aiSdkTransport — data + citations fan-out', () => {
    it('data-citations becomes N citation events', async () => {
        const out = await run(AI_SDK_CITATIONS_FLOW)
        const citations = out.filter(e => e.type === 'citation')
        expect(citations).toHaveLength(2)
        expect(citations[0]).toMatchObject({
            type: 'citation',
            source: { id: 'doc_1', url: 'https://example.com/a', title: 'A' },
        })
    })

    it('other data-* chunks pass through as data events', async () => {
        const out = await run(AI_SDK_CITATIONS_FLOW)
        const data = out.find(e => e.type === 'data')
        expect(data).toEqual({
            type: 'data',
            key: 'quota',
            value: { remaining: 7, limit: 100 },
        })
    })

    it('custom dataNameMapping overrides default behaviour', async () => {
        const transport = aiSdkTransport({
            url: 'https://api/x',
            fetch: mockFetch([
                {
                    data: JSON.stringify({
                        type: 'data-quota',
                        data: { remaining: 1 },
                    }),
                },
                { data: JSON.stringify({ type: 'finish' }) },
            ]),
            dataNameMapping: {
                quota: data => [
                    {
                        type: 'error',
                        code: 'QUOTA',
                        message: `${(data as { remaining: number }).remaining} left`,
                    },
                ],
            },
        })
        const out: MaestroEvent[] = []
        for await (const e of transport.send({
            messages: [],
            signal: new AbortController().signal,
        })) {
            out.push(e)
        }
        // Error is terminal, so finish never lands
        expect(out).toEqual([
            { type: 'error', code: 'QUOTA', message: '1 left' },
        ])
    })
})

describe('aiSdkTransport — metadata forwarding', () => {
    it('exposes metadata to bodyBuilder via args.metadata', async () => {
        const seen: unknown[] = []
        const fetchImpl = (async () =>
            new Response(
                sseStream([{ data: JSON.stringify({ type: 'finish' }) }]),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            )) as unknown as typeof fetch

        const transport = aiSdkTransport({
            url: 'https://api/x',
            fetch: fetchImpl,
            bodyBuilder: args => {
                seen.push(args.metadata)
                return { messages: args.messages, meta: args.metadata }
            },
        })
        for await (const _ of transport.send({
            messages: [],
            signal: new AbortController().signal,
            metadata: { surface: 'customer', traceId: 'xyz' },
        })) {
            // drain
        }
        expect(seen).toEqual([{ surface: 'customer', traceId: 'xyz' }])
    })

    it('default body folds metadata in when no bodyBuilder is provided', async () => {
        const calls: { url: string; init: RequestInit }[] = []
        const fetchImpl = (async (url: string, init: RequestInit) => {
            calls.push({ url, init })
            return new Response(
                sseStream([{ data: JSON.stringify({ type: 'finish' }) }]),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            )
        }) as unknown as typeof fetch

        const transport = aiSdkTransport({
            url: 'https://api/x',
            fetch: fetchImpl,
        })
        for await (const _ of transport.send({
            messages: [],
            signal: new AbortController().signal,
            metadata: { idempotencyKey: 'k1' },
        })) {
            // drain
        }
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
            messages: [],
            metadata: { idempotencyKey: 'k1' },
        })
    })
})

describe('aiSdkTransport — attachments forwarding (v0.2)', () => {
    it('exposes attachments to bodyBuilder via args.attachments', async () => {
        const seen: unknown[] = []
        const fetchImpl = (async () =>
            new Response(
                sseStream([{ data: JSON.stringify({ type: 'finish' }) }]),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            )) as unknown as typeof fetch

        const transport = aiSdkTransport({
            url: 'https://api/x',
            fetch: fetchImpl,
            bodyBuilder: args => {
                seen.push(args.attachments)
                return {
                    messages: args.messages,
                    attachments: args.attachments,
                }
            },
        })
        for await (const _ of transport.send({
            messages: [],
            signal: new AbortController().signal,
            attachments: [
                { kind: 'image', url: 'https://cdn/a.png' },
            ],
        })) {
            // drain
        }
        expect(seen).toEqual([
            [{ kind: 'image', url: 'https://cdn/a.png' }],
        ])
    })

    it('default body folds attachments in when no bodyBuilder is provided', async () => {
        const calls: { url: string; init: RequestInit }[] = []
        const fetchImpl = (async (url: string, init: RequestInit) => {
            calls.push({ url, init })
            return new Response(
                sseStream([{ data: JSON.stringify({ type: 'finish' }) }]),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            )
        }) as unknown as typeof fetch

        const transport = aiSdkTransport({
            url: 'https://api/x',
            fetch: fetchImpl,
        })
        for await (const _ of transport.send({
            messages: [],
            signal: new AbortController().signal,
            attachments: [
                { kind: 'file', url: 'https://cdn/spec.pdf', name: 'spec.pdf' },
            ],
        })) {
            // drain
        }
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
            messages: [],
            attachments: [
                { kind: 'file', url: 'https://cdn/spec.pdf', name: 'spec.pdf' },
            ],
        })
    })

    it('default body folds metadata + attachments together', async () => {
        const calls: { url: string; init: RequestInit }[] = []
        const fetchImpl = (async (url: string, init: RequestInit) => {
            calls.push({ url, init })
            return new Response(
                sseStream([{ data: JSON.stringify({ type: 'finish' }) }]),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            )
        }) as unknown as typeof fetch

        const transport = aiSdkTransport({
            url: 'https://api/x',
            fetch: fetchImpl,
        })
        for await (const _ of transport.send({
            messages: [],
            signal: new AbortController().signal,
            metadata: { idempotencyKey: 'k1' },
            attachments: [{ kind: 'image', url: 'https://cdn/a.png' }],
        })) {
            // drain
        }
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
            messages: [],
            metadata: { idempotencyKey: 'k1' },
            attachments: [{ kind: 'image', url: 'https://cdn/a.png' }],
        })
    })
})

describe('aiSdkTransport — stream-level errors', () => {
    it('error chunk emits a MaestroEvent error and closes', async () => {
        const out = await run(AI_SDK_STREAM_ERROR_FLOW)
        expect(out).toEqual([
            { type: 'error', message: 'rate limit hit' },
        ])
    })

    it('non-2xx fetch becomes an HTTP_* error event', async () => {
        const transport = aiSdkTransport({
            url: 'https://api/x',
            fetch: mockFetch([], 500),
        })
        const out: MaestroEvent[] = []
        for await (const e of transport.send({
            messages: [],
            signal: new AbortController().signal,
        })) {
            out.push(e)
        }
        expect(out[0]).toMatchObject({ type: 'error', code: 'HTTP_500' })
    })
})
