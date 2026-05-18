/**
 * Sample SSE event sequence from trading-rag's FastAPI wire format.
 *
 * Source of truth: `backend/app/api/chat.py` in trading-rag emits
 * these events depending on the pipeline taken:
 *
 *   - token                    chunked assistant text
 *   - agent_start              { asset, timeframe }
 *   - agent_step               { step_name, status }
 *   - agent_result             { suggestion, run_id, duration_seconds, ... }
 *   - sources                  Array<{ chunk_id, filename, similarity }>
 *   - chart_start              { chart_id }
 *   - chart_description        { text }
 *   - chart_matches            { setup_matches: [...], similar_frames: [...] }
 *   - error                    { message }
 *   - done                     { conversation_id, message_id }
 *
 * Notable shape gaps vs protocol:
 *
 *   - NO tool_use/tool_result. The agent pipeline IS the tool, surfaced
 *     as `agent_start` + `agent_step*` + `agent_result`. Mapping
 *     synthesises ONE tool-call at `agent_start`, fans `agent_step`
 *     into tool-progress events, and closes with one tool-result at
 *     `agent_result`.
 *
 *   - `sources` is a single frame carrying an ARRAY. Mapper fans out
 *     into N citation events.
 *
 *   - `chart_*` is the chart-analysis pipeline. We model the matches
 *     as a typed `data` event under key `rag.chart_matches` so a chart
 *     UI can subscribe; description is folded into text-delta so it
 *     renders inline.
 *
 *   - `done.text` is NOT emitted by trading-rag — the assistant text
 *     comes from the token stream alone. This validates D4 of the
 *     protocol: `done.text` MUST be optional.
 */

export interface TradingRagWireFrame {
    readonly event: string
    readonly data: string
}

export const TRADING_RAG_AGENT_FLOW: ReadonlyArray<TradingRagWireFrame> = [
    {
        event: 'agent_start',
        data: JSON.stringify({ asset: 'BTC/USDT', timeframe: '1h' }),
    },
    {
        event: 'agent_step',
        data: JSON.stringify({ step_name: 'fetch', status: 'pending' }),
    },
    {
        event: 'agent_step',
        data: JSON.stringify({ step_name: 'fetch', status: 'completed' }),
    },
    {
        event: 'agent_step',
        data: JSON.stringify({ step_name: 'setups', status: 'completed' }),
    },
    {
        event: 'agent_result',
        data: JSON.stringify({
            suggestion: { direction: 'long', confidence: 72 },
            run_id: 'run_abc',
            duration_seconds: 3.4,
        }),
    },
    {
        event: 'token',
        data: JSON.stringify({ content: 'BTC is showing a ' }),
    },
    {
        event: 'token',
        data: JSON.stringify({ content: 'bullish flag pattern.' }),
    },
    {
        event: 'sources',
        data: JSON.stringify([
            { chunk_id: 'c1', filename: 'patterns.pdf', similarity: 0.91 },
            { chunk_id: 'c2', filename: 'risk.pdf', similarity: 0.73 },
        ]),
    },
    {
        event: 'done',
        data: JSON.stringify({
            conversation_id: 'conv_1',
            message_id: 'msg_1',
        }),
    },
]

export const TRADING_RAG_CHART_FLOW: ReadonlyArray<TradingRagWireFrame> = [
    {
        event: 'chart_start',
        data: JSON.stringify({ chart_id: 'chart_42' }),
    },
    {
        event: 'chart_description',
        data: JSON.stringify({ text: 'Daily BTC with bullish engulfing.' }),
    },
    {
        event: 'chart_matches',
        data: JSON.stringify({
            setup_matches: [{ chunk_id: 'c1', confidence: 88 }],
            similar_frames: [{ chunk_id: 'f1' }],
        }),
    },
    {
        event: 'agent_result',
        data: JSON.stringify({
            suggestion: { direction: 'long' },
            run_id: 'run_chart_1',
        }),
    },
    {
        event: 'done',
        data: JSON.stringify({
            conversation_id: 'conv_2',
            message_id: 'msg_2',
        }),
    },
]

/**
 * Typed data map for trading-rag's data events. Use as
 * `useMaestroChat<TradingRagDataMap>(...)` to get narrowed `event.value`.
 */
export interface TradingRagDataMap {
    'rag.agent_step': { step_name: string; status: string }
    'rag.chart_matches': {
        setup_matches: Array<{ chunk_id: string; confidence?: number }>
        similar_frames: Array<{ chunk_id: string }>
    }
}

import type { LegacyEventMap } from '../src/transports/legacy-sse.js'

/**
 * Production-shape event map. Shows the synthetic-tool-call pattern
 * for backends without a native tool_use/result wire.
 */
export const tradingRagEventMap: LegacyEventMap<TradingRagDataMap> = {
    token: data => {
        if (
            typeof data !== 'object' ||
            data === null ||
            typeof (data as { content: unknown }).content !== 'string'
        ) {
            return null
        }
        return {
            type: 'text-delta',
            delta: (data as { content: string }).content,
        }
    },
    agent_start: (data, ctx) => {
        // Open a synthetic "agent" tool-call so the pipeline phases
        // attach as progress chips in the default UI.
        const callId = ctx.nextCallId()
        return {
            type: 'tool-call',
            callId,
            name: 'agent',
            input: data,
        }
    },
    agent_step: (data, ctx) => {
        const callId = ctx.lastCallId()
        if (!callId) return null
        const payload = data as { step_name?: string; status?: string }
        return [
            {
                type: 'tool-progress',
                callId,
                message: payload.step_name
                    ? `${payload.step_name}: ${payload.status ?? '?'}`
                    : undefined,
            },
            // Also fan out as typed data so a richer UI can render
            // per-step state.
            {
                type: 'data',
                key: 'rag.agent_step',
                value: data,
                callId,
            },
        ]
    },
    agent_result: (data, ctx) => {
        const callId = ctx.lastCallId() ?? ctx.nextCallId()
        return {
            type: 'tool-result',
            callId,
            result: data,
        }
    },
    chart_start: (_data, ctx) => {
        // Open a synthetic chart tool-call.
        return {
            type: 'tool-call',
            callId: ctx.nextCallId(),
            name: 'chart-analysis',
            input: _data,
        }
    },
    chart_description: data => {
        if (
            typeof data !== 'object' ||
            data === null ||
            typeof (data as { text: unknown }).text !== 'string'
        ) {
            return null
        }
        // Description streams inline as text — UIs that don't know
        // about charts still render it.
        return {
            type: 'text-delta',
            delta: `${(data as { text: string }).text}\n\n`,
        }
    },
    chart_matches: (data, ctx) => {
        const callId = ctx.lastCallId()
        return {
            type: 'data',
            key: 'rag.chart_matches',
            value: data as TradingRagDataMap['rag.chart_matches'],
            callId,
        }
    },
    sources: data => {
        if (!Array.isArray(data)) return null
        const out = []
        for (const raw of data) {
            if (typeof raw !== 'object' || raw === null) continue
            const row = raw as {
                chunk_id?: string
                filename?: string
                similarity?: number
            }
            out.push({
                type: 'citation' as const,
                source: {
                    id: row.chunk_id,
                    title: row.filename,
                },
            })
        }
        return out
    },
    error: data => {
        const message =
            typeof data === 'object' &&
            data !== null &&
            typeof (data as { message: unknown }).message === 'string'
                ? (data as { message: string }).message
                : 'stream error'
        return { type: 'error', message }
    },
    done: data => {
        return {
            type: 'done',
            metadata: data,
        }
    },
}
