import { describe, expect, it, vi } from 'vitest'

import {
    NUMENION_HAPPY_PATH,
    NUMENION_TOOL_ERROR_PATH,
    numenionEventMap,
} from '../../fixtures/numenion-wire.js'
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

async function runNumenion(
    frames: ReadonlyArray<SsePayload>,
): Promise<MaestroEvent[]> {
    const transport = legacySseTransport({
        url: 'https://api/x',
        fetch: mockFetch(frames),
        eventMap: numenionEventMap,
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

describe('legacySseTransport — numenion fixtures', () => {
    it('happy path translates text + tool + done', async () => {
        const out = await runNumenion(NUMENION_HAPPY_PATH)
        expect(out).toEqual([
            { type: 'text-delta', delta: 'Looking up ' },
            { type: 'text-delta', delta: 'your portfolio…' },
            {
                type: 'tool-call',
                callId: 'legacy_1',
                name: 'getPortfolio',
                input: { wallet: '0x7099…79C8' },
            },
            {
                type: 'tool-result',
                callId: 'legacy_1',
                result: { netWorth: 12345, positions: 3 },
            },
            { type: 'text-delta', delta: '\n\nYour net worth is **$12,345**.' },
            {
                type: 'done',
                text: 'Looking up your portfolio…\n\nYour net worth is **$12,345**.',
            },
        ])
    })

    it('tool_result with error:true becomes an errored tool-result + stream error', async () => {
        const out = await runNumenion(NUMENION_TOOL_ERROR_PATH)
        // The tool-result event errors the call, then the stream error
        // terminates iteration.
        expect(out).toEqual([
            {
                type: 'tool-call',
                callId: 'legacy_1',
                name: 'proposeAction',
                input: { kind: 'swap' },
            },
            {
                type: 'tool-result',
                callId: 'legacy_1',
                error: { code: 'TOOL_ERROR', message: 'simulation reverted' },
            },
            { type: 'error', message: 'simulation reverted' },
        ])
    })

    it('synthesises callIds via ctx.nextCallId() so concurrent calls are unique', async () => {
        const out = await runNumenion([
            {
                event: 'tool_use',
                data: JSON.stringify({ name: 'a', input: {} }),
            },
            {
                event: 'tool_use',
                data: JSON.stringify({ name: 'b', input: {} }),
            },
            { event: 'done', data: '{}' },
        ])
        const ids = out
            .filter(e => e.type === 'tool-call')
            .map(e => (e as { callId: string }).callId)
        expect(ids).toEqual(['legacy_1', 'legacy_2'])
    })
})

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
