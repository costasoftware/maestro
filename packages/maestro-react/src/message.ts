/**
 * Aggregated, renderable shapes derived from the streaming
 * `MaestroEvent` vocabulary defined in `./protocol.ts`.
 *
 * The protocol describes the wire — one event per SSE `data:` line.
 * These types describe the resting state after the reducer (`./reducer.ts`)
 * has folded a stream of events into something a UI can render:
 *
 *   - `MaestroMessage<TDataMap>` — one assistant (or user) turn
 *   - `MaestroToolCall`         — aggregates tool-call + tool-progress + tool-result
 *   - `MaestroCitation`         — flattened citation source
 *   - `MaestroError`            — terminal stream error (NOT a tool-result error)
 *
 * `TDataMap` is a host-supplied registry of typed `data` events. Consumers
 * who want narrow types pass a concrete map; consumers who don't, use
 * `Record<string, unknown>` (the default).
 */

import type {
    CitationEvent,
    ErrorEvent,
    MaestroAttachment,
    ToolProgressEvent,
    ToolResultEvent,
} from './protocol.js'

/**
 * One streamed data attachment, narrowed against the host-supplied
 * `TDataMap`. `K` is fixed per entry so `value` is the exact payload
 * for that key.
 */
export type MaestroData<
    TDataMap = Record<string, unknown>,
> = {
    [K in keyof TDataMap & string]: {
        readonly key: K
        readonly value: TDataMap[K]
        readonly callId?: string
    }
}[keyof TDataMap & string]

/**
 * Resting shape of a single tool invocation. Built from one
 * `tool-call`, zero-or-more `tool-progress`, and exactly one
 * `tool-result` event sharing the same `callId`.
 *
 * `status` is derived:
 *   - 'pending'    after `tool-call`, before any progress / result
 *   - 'running'    after the first `tool-progress`
 *   - 'success'    after a `tool-result` with `result` set
 *   - 'errored'    after a `tool-result` with `error` set
 */
export interface MaestroToolCall {
    readonly callId: string
    readonly name: string
    readonly input: unknown
    readonly status: 'pending' | 'running' | 'success' | 'errored'
    readonly progress: ReadonlyArray<{
        readonly message?: string
        readonly data?: unknown
    }>
    readonly result?: unknown
    readonly error?: ToolResultEvent['error']
}

/**
 * Flattened citation. Mirrors `CitationEvent.source` plus the optional
 * `callId` correlator for tool-scoped citations.
 */
export interface MaestroCitation {
    readonly id?: string
    readonly url?: string
    readonly title?: string
    readonly snippet?: string
    readonly callId?: string
}

/**
 * Terminal stream error. Distinct from `MaestroToolCall.error` (which
 * is scoped to one tool invocation). Triggered by:
 *   - an `error` event from the transport
 *   - an `AbortError` from the AbortSignal
 *   - a transport-level network / parse failure
 */
export interface MaestroError {
    readonly code?: string
    readonly message: string
    readonly cause?: unknown
}

/**
 * One conversation turn — user or assistant. The reducer populates
 * `text`, `toolCalls`, `citations`, and `data` from streamed events.
 *
 * Status lifecycle for assistant turns:
 *   pending → streaming → complete  (happy path)
 *                       → errored   (stream-level error event)
 *                       → aborted   (AbortSignal fired)
 *
 * User turns are always `complete` the moment they're appended.
 */
export interface MaestroMessage<
    TDataMap = Record<string, unknown>,
> {
    readonly id: string
    readonly role: 'user' | 'assistant'
    readonly text: string
    readonly toolCalls: ReadonlyArray<MaestroToolCall>
    readonly citations: ReadonlyArray<MaestroCitation>
    readonly data: ReadonlyArray<MaestroData<TDataMap>>
    readonly status: 'pending' | 'streaming' | 'complete' | 'errored' | 'aborted'
    readonly createdAt: number
    readonly completedAt?: number
    readonly error?: MaestroError
    readonly metadata?: unknown
    /**
     * User-attached media for this turn. Stamped at `send()` time from
     * `send(text, { attachments: [...] })`; never derived from events.
     *
     * Only meaningful on `role: 'user'` messages — assistant turns will
     * always leave this `undefined`. The field is typed on the union to
     * keep renderer code uniform (a single `message.attachments?.map(...)`
     * branch works for either role).
     *
     * Added in protocol 0.2.0-beta. See `MaestroAttachment` in
     * `./protocol.ts` for the shape and lifecycle.
     */
    readonly attachments?: ReadonlyArray<MaestroAttachment>
}

/**
 * Helpers for transports / external callers that need to construct
 * the resting shapes without re-deriving them from events.
 */
export function citationFromEvent(event: CitationEvent): MaestroCitation {
    const { source, callId } = event
    return {
        id: source.id,
        url: source.url,
        title: source.title,
        snippet: source.snippet,
        callId,
    }
}

export function progressFromEvent(
    event: ToolProgressEvent,
): { message?: string; data?: unknown } {
    return { message: event.message, data: event.data }
}

export function errorFromEvent(event: ErrorEvent): MaestroError {
    return { code: event.code, message: event.message }
}
