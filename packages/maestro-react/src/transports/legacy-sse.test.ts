import { describe, expect, it, vi } from 'vitest'

import {
    TRADING_RAG_AGENT_FLOW,
    TRADING_RAG_CHART_FLOW,
    type TradingRagDataMap,
    tradingRagEventMap,
} from '../../fixtures/trading-rag-wire.js'
import type { MaestroEvent } from '../protocol.js'
import { legacySseTransport } from './legacy-sse.js'
import { sseStream, type SsePayload } from './test-utils.js'

function mockFetch(frames: ReadonlyArray<SsePayload>): typeof fetch {
    return (async () =>
        new Response(sseStream(frames), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        })) as unknown as typeof fetch
}

async function runTradingRag(
    frames: ReadonlyArray<SsePayload>,
): Promise<MaestroEvent[]> {
    const transport = legacySseTransport<TradingRagDataMap>({
        url: 'https://api/x',
        fetch: mockFetch(frames),
        eventMap: tradingRagEventMap,
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

describe('legacySseTransport — trading-rag fixtures', () => {
    it('agent flow synthesises one tool-call + N progress + one tool-result', async () => {
        const out = await runTradingRag(TRADING_RAG_AGENT_FLOW)

        const calls = out.filter(e => e.type === 'tool-call')
        const progress = out.filter(e => e.type === 'tool-progress')
        const results = out.filter(e => e.type === 'tool-result')
        const tokens = out.filter(e => e.type === 'text-delta')
        const cites = out.filter(e => e.type === 'citation')
        const datas = out.filter(e => e.type === 'data')
        const dones = out.filter(e => e.type === 'done')

        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({
            type: 'tool-call',
            name: 'agent',
            input: { asset: 'BTC/USDT', timeframe: '1h' },
        })
        // Three agent_step frames → 3 tool-progress events.
        expect(progress).toHaveLength(3)
        expect(results).toHaveLength(1)
        expect(tokens.map(t => (t as { delta: string }).delta).join('')).toBe(
            'BTC is showing a bullish flag pattern.',
        )
        // sources array → 2 citation events.
        expect(cites).toHaveLength(2)
        expect(cites[0]).toMatchObject({
            type: 'citation',
            source: { id: 'c1', title: 'patterns.pdf' },
        })
        // agent_step also fans out as typed data.
        expect(datas).toHaveLength(3)
        expect(datas[0]).toMatchObject({
            type: 'data',
            key: 'rag.agent_step',
        })
        expect(dones).toHaveLength(1)
    })

    it('chart flow opens a second synthetic call with name "chart-analysis"', async () => {
        const out = await runTradingRag(TRADING_RAG_CHART_FLOW)
        const calls = out.filter(e => e.type === 'tool-call')
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({
            type: 'tool-call',
            name: 'chart-analysis',
        })
        // chart_description streams as text-delta — UIs without chart
        // support still render the description inline.
        const text = out
            .filter(e => e.type === 'text-delta')
            .map(t => (t as { delta: string }).delta)
            .join('')
        expect(text).toBe('Daily BTC with bullish engulfing.\n\n')
        const data = out.filter(e => e.type === 'data')
        expect(data[0]).toMatchObject({
            type: 'data',
            key: 'rag.chart_matches',
        })
    })
})

describe('legacySseTransport — metadata forwarding', () => {
    it('exposes metadata to bodyBuilder via args.metadata', async () => {
        const seen: unknown[] = []
        const fetchImpl = (async () =>
            new Response(
                sseStream([{ event: 'done', data: '{}' }]),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            )) as unknown as typeof fetch

        const transport = legacySseTransport({
            url: 'https://api/x',
            fetch: fetchImpl,
            eventMap: {
                done: () => ({ type: 'done' }),
            },
            bodyBuilder: args => {
                seen.push(args.metadata)
                return { messages: args.messages, m: args.metadata }
            },
        })
        for await (const _ of transport.send({
            messages: [],
            signal: new AbortController().signal,
            metadata: { conversationId: 'c-7' },
        })) {
            // drain
        }
        expect(seen).toEqual([{ conversationId: 'c-7' }])
    })

    it('default body folds metadata in when no bodyBuilder is provided', async () => {
        const calls: { url: string; init: RequestInit }[] = []
        const fetchImpl = (async (url: string, init: RequestInit) => {
            calls.push({ url, init })
            return new Response(
                sseStream([{ event: 'done', data: '{}' }]),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            )
        }) as unknown as typeof fetch

        const transport = legacySseTransport({
            url: 'https://api/x',
            fetch: fetchImpl,
            eventMap: {
                done: () => ({ type: 'done' }),
            },
        })
        for await (const _ of transport.send({
            messages: [],
            signal: new AbortController().signal,
            metadata: { conversationId: 'c-9' },
        })) {
            // drain
        }
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
            messages: [],
            metadata: { conversationId: 'c-9' },
        })
    })
})

describe('legacySseTransport — attachments forwarding (v0.2)', () => {
    it('exposes attachments to bodyBuilder via args.attachments', async () => {
        const seen: unknown[] = []
        const fetchImpl = (async () =>
            new Response(
                sseStream([{ event: 'done', data: '{}' }]),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            )) as unknown as typeof fetch

        const transport = legacySseTransport({
            url: 'https://api/x',
            fetch: fetchImpl,
            eventMap: {
                done: () => ({ type: 'done' }),
            },
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
            attachments: [{ kind: 'image', url: 'https://cdn/a.png' }],
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
                sseStream([{ event: 'done', data: '{}' }]),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            )
        }) as unknown as typeof fetch

        const transport = legacySseTransport({
            url: 'https://api/x',
            fetch: fetchImpl,
            eventMap: {
                done: () => ({ type: 'done' }),
            },
        })
        for await (const _ of transport.send({
            messages: [],
            signal: new AbortController().signal,
            metadata: { conversationId: 'c-9' },
            attachments: [
                { kind: 'audio', url: 'https://cdn/a.mp3', size: 2048 },
            ],
        })) {
            // drain
        }
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
            messages: [],
            metadata: { conversationId: 'c-9' },
            attachments: [
                { kind: 'audio', url: 'https://cdn/a.mp3', size: 2048 },
            ],
        })
    })
})

describe('legacySseTransport — error paths', () => {
    it('unknown event names invoke onUnknownEvent and are skipped', async () => {
        const onUnknownEvent = vi.fn()
        const transport = legacySseTransport({
            url: 'https://api/x',
            fetch: mockFetch([
                { event: 'mystery', data: '{}' },
                { event: 'done', data: '{}' },
            ]),
            eventMap: {
                done: () => ({ type: 'done' }),
            },
            onUnknownEvent,
        })
        const out: MaestroEvent[] = []
        for await (const e of transport.send({
            messages: [],
            signal: new AbortController().signal,
        })) {
            out.push(e)
        }
        expect(out).toEqual([{ type: 'done' }])
        expect(onUnknownEvent).toHaveBeenCalledWith('mystery', '{}')
    })

    it('mapper returning null is treated as "no events"', async () => {
        const transport = legacySseTransport({
            url: 'https://api/x',
            fetch: mockFetch([
                { event: 'noop', data: '{}' },
                { event: 'done', data: '{}' },
            ]),
            eventMap: {
                noop: () => null,
                done: () => ({ type: 'done' }),
            },
        })
        const out: MaestroEvent[] = []
        for await (const e of transport.send({
            messages: [],
            signal: new AbortController().signal,
        })) {
            out.push(e)
        }
        expect(out).toEqual([{ type: 'done' }])
    })

    it('passes raw text to mapper when JSON parse fails', async () => {
        const seen: unknown[] = []
        const transport = legacySseTransport({
            url: 'https://api/x',
            fetch: mockFetch([
                { event: 'raw', data: 'not-json' },
                { event: 'done', data: '{}' },
            ]),
            eventMap: {
                raw: data => {
                    seen.push(data)
                    return null
                },
                done: () => ({ type: 'done' }),
            },
            onParseError: () => undefined,
        })
        for await (const _ of transport.send({
            messages: [],
            signal: new AbortController().signal,
        })) {
            // drain
        }
        expect(seen).toEqual(['not-json'])
    })
})
