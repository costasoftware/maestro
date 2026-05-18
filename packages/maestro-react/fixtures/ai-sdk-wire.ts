/**
 * Sample AI SDK v6 `UIMessageStream` payload shapes.
 *
 * Source of truth: `ai@^6` `UIMessageChunk` discriminated union (see
 * `node_modules/ai/dist/index.d.ts`). We re-declare the relevant
 * subset here as plain objects so tests do not pull in the `ai`
 * package — it is an OPTIONAL peer dep.
 *
 * These fixtures mirror what `createUIMessageStream({ execute })`
 * emits over the wire as SSE frames. The AI SDK serialises each chunk
 * as one `data:` line.
 */

/** One AI SDK chunk as wire bytes would arrive (single `data:` line). */
export interface AiSdkWireFrame {
    /** AI SDK always uses the default `event: message` (omitted on the wire). */
    readonly event: 'message'
    /** JSON-encoded UIMessageChunk. */
    readonly data: string
}

const frame = (chunk: object): AiSdkWireFrame => ({
    event: 'message',
    data: JSON.stringify(chunk),
})

export const AI_SDK_HAPPY_PATH: ReadonlyArray<AiSdkWireFrame> = [
    frame({ type: 'start', messageId: 'm1' }),
    frame({ type: 'start-step' }),
    frame({ type: 'text-start', id: 't1' }),
    frame({ type: 'text-delta', id: 't1', delta: 'Hello ' }),
    frame({ type: 'text-delta', id: 't1', delta: 'world' }),
    frame({ type: 'text-end', id: 't1' }),
    frame({ type: 'finish-step' }),
    frame({ type: 'finish', finishReason: 'stop' }),
]

export const AI_SDK_TOOL_FLOW: ReadonlyArray<AiSdkWireFrame> = [
    frame({ type: 'start', messageId: 'm2' }),
    frame({
        type: 'tool-input-start',
        toolCallId: 'call_42',
        toolName: 'searchBookings',
    }),
    frame({
        type: 'tool-input-available',
        toolCallId: 'call_42',
        toolName: 'searchBookings',
        input: { q: 'tomorrow' },
    }),
    frame({
        type: 'tool-output-available',
        toolCallId: 'call_42',
        output: { count: 3, ids: ['b1', 'b2', 'b3'] },
    }),
    frame({ type: 'text-delta', id: 't2', delta: 'Found 3 bookings.' }),
    frame({ type: 'finish', finishReason: 'tool-calls' }),
]

export const AI_SDK_CITATIONS_FLOW: ReadonlyArray<AiSdkWireFrame> = [
    frame({ type: 'start', messageId: 'm3' }),
    frame({ type: 'text-delta', id: 't3', delta: 'Based on the docs:' }),
    // Barbeiro's chip convention: one `data-citations` chunk carrying
    // an array of sources. The transport fans this out into N citation
    // events.
    frame({
        type: 'data-citations',
        data: [
            {
                id: 'doc_1',
                url: 'https://example.com/a',
                title: 'A',
                snippet: 'snippet A',
            },
            {
                id: 'doc_2',
                url: 'https://example.com/b',
                title: 'B',
            },
        ],
    }),
    // A backend-specific custom chip — passes through as a `data` event.
    frame({
        type: 'data-quota',
        data: { remaining: 7, limit: 100 },
    }),
    frame({ type: 'finish' }),
]

export const AI_SDK_TOOL_ERROR_FLOW: ReadonlyArray<AiSdkWireFrame> = [
    frame({ type: 'start' }),
    frame({
        type: 'tool-input-available',
        toolCallId: 'call_99',
        toolName: 'cancelBooking',
        input: { id: 'b_x' },
    }),
    frame({
        type: 'tool-output-error',
        toolCallId: 'call_99',
        errorText: 'booking not found',
    }),
    frame({ type: 'finish' }),
]

export const AI_SDK_STREAM_ERROR_FLOW: ReadonlyArray<AiSdkWireFrame> = [
    frame({ type: 'start' }),
    frame({ type: 'error', errorText: 'rate limit hit' }),
]

/**
 * Typed data map for the AI SDK fixtures. Demonstrates the
 * `useMaestroChat<TDataMap>` generic on barbeiro-shaped consumers.
 */
export interface BarbeiroDataMap {
    quota: { remaining: number; limit: number }
}
