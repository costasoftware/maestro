/**
 * Pure folds of `MaestroEvent` streams into `MaestroMessage` resting
 * state. Lives outside the hook so it is trivially testable and could
 * be reused server-side for replay / snapshotting.
 *
 * The reducer is the single source of truth for how a stream of events
 * collapses into a renderable message. The hook (`./hook.ts`) calls
 * `applyEvent` per chunk; nothing else mutates message state.
 */

import {
    citationFromEvent,
    errorFromEvent,
    type MaestroData,
    type MaestroError,
    type MaestroMessage,
    type MaestroToolCall,
    progressFromEvent,
} from './message.js'
import {
    assertNever,
    type CitationEvent,
    type DataEvent,
    type DoneEvent,
    type ErrorEvent,
    type MaestroAttachment,
    type MaestroEvent,
    type TextDeltaEvent,
    type ToolCallEvent,
    type ToolProgressEvent,
    type ToolResultEvent,
} from './protocol.js'

/**
 * Build a fresh assistant message in `pending` state. Use this when
 * the hook receives a `send()` call but the transport has not yet
 * yielded its first event.
 */
export function createAssistantMessage<
    TDataMap,
>(args: { id: string; createdAt?: number }): MaestroMessage<TDataMap> {
    return {
        id: args.id,
        role: 'assistant',
        text: '',
        toolCalls: [],
        citations: [],
        data: [],
        status: 'pending',
        createdAt: args.createdAt ?? Date.now(),
    }
}

/**
 * Build a user message. Always lands in `complete` state — there is
 * no streaming for user input.
 *
 * `attachments` (added in protocol 0.2.0-beta) is stamped verbatim
 * onto the message so renderers can preview user-attached media
 * alongside the text. It is `undefined` when the caller did not
 * attach anything.
 */
export function createUserMessage<TDataMap>(
    args: {
        id: string
        text: string
        createdAt?: number
        attachments?: ReadonlyArray<MaestroAttachment>
    },
): MaestroMessage<TDataMap> {
    const now = args.createdAt ?? Date.now()
    return {
        id: args.id,
        role: 'user',
        text: args.text,
        toolCalls: [],
        citations: [],
        data: [],
        status: 'complete',
        createdAt: now,
        completedAt: now,
        ...(args.attachments !== undefined
            ? { attachments: args.attachments }
            : {}),
    }
}

/**
 * Mark a message as aborted (terminal). Used by the hook when the
 * caller invokes `abort()` before the stream completes naturally.
 */
export function abortMessage<TDataMap>(
    message: MaestroMessage<TDataMap>,
    completedAt: number = Date.now(),
): MaestroMessage<TDataMap> {
    if (message.status === 'complete' || message.status === 'errored') {
        return message
    }
    return { ...message, status: 'aborted', completedAt }
}

/**
 * Mark a message as errored by a transport-level failure that
 * arrived OUTSIDE the event stream (e.g. fetch rejected, JSON
 * parse failure). Stream-level `error` events are handled by
 * `applyEvent` instead.
 */
export function failMessage<TDataMap>(
    message: MaestroMessage<TDataMap>,
    error: MaestroError,
    completedAt: number = Date.now(),
): MaestroMessage<TDataMap> {
    if (message.status === 'complete' || message.status === 'aborted') {
        return message
    }
    return { ...message, status: 'errored', error, completedAt }
}

/**
 * Apply a single event to a message, returning a new message
 * (shallow-immutable). The function is pure: same input → same output,
 * no I/O, no mutation of `message` or `event`.
 */
export function applyEvent<TDataMap>(
    message: MaestroMessage<TDataMap>,
    event: MaestroEvent,
): MaestroMessage<TDataMap> {
    // Terminal states ignore subsequent events. This guards against
    // a misbehaving transport that yields after `done` or after an
    // abort. Real transports should close the iterator, but we cannot
    // trust that contractually.
    if (
        message.status === 'complete' ||
        message.status === 'aborted' ||
        message.status === 'errored'
    ) {
        return message
    }

    // First event flips pending → streaming. Done/error apply their
    // own terminal status; everything else keeps us in streaming.
    const baseStatus: MaestroMessage<TDataMap>['status'] =
        event.type === 'done' || event.type === 'error'
            ? message.status
            : 'streaming'

    switch (event.type) {
        case 'text-delta':
            return applyTextDelta(message, event, baseStatus)
        case 'tool-call':
            return applyToolCall(message, event, baseStatus)
        case 'tool-progress':
            return applyToolProgress(message, event, baseStatus)
        case 'tool-result':
            return applyToolResult(message, event, baseStatus)
        case 'citation':
            return applyCitation(message, event, baseStatus)
        case 'data':
            return applyData(message, event, baseStatus)
        case 'error':
            return applyError(message, event)
        case 'done':
            return applyDone(message, event)
        default:
            return assertNever(event)
    }
}

function applyTextDelta<TDataMap>(
    message: MaestroMessage<TDataMap>,
    event: TextDeltaEvent,
    status: MaestroMessage<TDataMap>['status'],
): MaestroMessage<TDataMap> {
    return { ...message, text: message.text + event.delta, status }
}

function applyToolCall<TDataMap>(
    message: MaestroMessage<TDataMap>,
    event: ToolCallEvent,
    status: MaestroMessage<TDataMap>['status'],
): MaestroMessage<TDataMap> {
    // Idempotent: if we somehow see two tool-call events with the same
    // callId (out-of-spec but defensible), keep the first one. The
    // alternative — replacing — loses any progress already collected.
    if (message.toolCalls.some(tc => tc.callId === event.callId)) {
        return { ...message, status }
    }
    const next: MaestroToolCall = {
        callId: event.callId,
        name: event.name,
        input: event.input,
        status: 'pending',
        progress: [],
    }
    return { ...message, toolCalls: [...message.toolCalls, next], status }
}

function applyToolProgress<TDataMap>(
    message: MaestroMessage<TDataMap>,
    event: ToolProgressEvent,
    status: MaestroMessage<TDataMap>['status'],
): MaestroMessage<TDataMap> {
    const idx = message.toolCalls.findIndex(tc => tc.callId === event.callId)
    if (idx === -1) {
        // Progress for an unknown call — drop it. The protocol REQUIRES
        // a preceding tool-call. A noisy transport that violates this
        // shouldn't crash the reducer.
        return { ...message, status }
    }
    const existing = message.toolCalls[idx]
    if (!existing) return { ...message, status }
    const updated: MaestroToolCall = {
        ...existing,
        status: 'running',
        progress: [...existing.progress, progressFromEvent(event)],
    }
    const toolCalls = message.toolCalls.slice()
    toolCalls[idx] = updated
    return { ...message, toolCalls, status }
}

function applyToolResult<TDataMap>(
    message: MaestroMessage<TDataMap>,
    event: ToolResultEvent,
    status: MaestroMessage<TDataMap>['status'],
): MaestroMessage<TDataMap> {
    const idx = message.toolCalls.findIndex(tc => tc.callId === event.callId)
    if (idx === -1) {
        // Result for an unknown call — synthesise a placeholder call.
        // Legacy SSE adapters may legitimately produce this if a
        // backend emits results without a preceding call (e.g. a
        // `tool_result` frame with no callId — the adapter must
        // synthesise one and pair them, see legacy-sse.ts).
        const synthesised: MaestroToolCall = {
            callId: event.callId,
            name: '(unknown)',
            input: undefined,
            status: event.error ? 'errored' : 'success',
            progress: [],
            result: event.result,
            error: event.error,
        }
        return {
            ...message,
            toolCalls: [...message.toolCalls, synthesised],
            status,
        }
    }
    const existing = message.toolCalls[idx]
    if (!existing) return { ...message, status }
    const updated: MaestroToolCall = {
        ...existing,
        status: event.error ? 'errored' : 'success',
        result: event.result,
        error: event.error,
    }
    const toolCalls = message.toolCalls.slice()
    toolCalls[idx] = updated
    return { ...message, toolCalls, status }
}

function applyCitation<TDataMap>(
    message: MaestroMessage<TDataMap>,
    event: CitationEvent,
    status: MaestroMessage<TDataMap>['status'],
): MaestroMessage<TDataMap> {
    return {
        ...message,
        citations: [...message.citations, citationFromEvent(event)],
        status,
    }
}

function applyData<TDataMap>(
    message: MaestroMessage<TDataMap>,
    event: DataEvent,
    status: MaestroMessage<TDataMap>['status'],
): MaestroMessage<TDataMap> {
    // The protocol's `DataEvent.key` is a free `string`; the reducer
    // doesn't enforce membership in `TDataMap` at runtime — that is the
    // consumer's contract. We cast through the union once here so
    // downstream `messages` consumers see the narrowed type.
    const entry = {
        key: event.key,
        value: event.value,
        callId: event.callId,
    } as unknown as MaestroData<TDataMap>
    return { ...message, data: [...message.data, entry], status }
}

function applyError<TDataMap>(
    message: MaestroMessage<TDataMap>,
    event: ErrorEvent,
): MaestroMessage<TDataMap> {
    return {
        ...message,
        status: 'errored',
        error: errorFromEvent(event),
        completedAt: Date.now(),
    }
}

function applyDone<TDataMap>(
    message: MaestroMessage<TDataMap>,
    event: DoneEvent,
): MaestroMessage<TDataMap> {
    return {
        ...message,
        // Per D4: don't trust `done.text` blindly — only adopt it if
        // we never saw a text-delta. Backends that buffer + restate
        // their final text rely on this; backends that stream
        // text-delta normally keep the streamed body.
        text: message.text.length === 0 && event.text ? event.text : message.text,
        status: 'complete',
        completedAt: Date.now(),
        metadata: event.metadata,
    }
}
