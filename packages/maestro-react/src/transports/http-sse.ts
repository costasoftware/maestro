/**
 * `httpSSETransport` — canonical raw-protocol transport.
 *
 * Posts the conversation to `url` and parses the SSE response, where
 * each `data:` line is one JSON-encoded `MaestroEvent`. This is the
 * "happy path" transport for backends that adopt the protocol natively
 * (P4 trading-rag target).
 *
 * Wire shape expected from the backend:
 *
 *   POST /chat
 *   Accept: text/event-stream
 *   Content-Type: application/json
 *
 *   data: {"type":"text-delta","delta":"Hello"}\n\n
 *   data: {"type":"tool-call","callId":"c1","name":"x","input":{}}\n\n
 *   data: {"type":"done"}\n\n
 */

import type { MaestroEvent } from '../protocol.js'
import type { MaestroMessage } from '../message.js'
import type { Transport, TransportSendArgs } from '../transport.js'
import { parseSseStream } from './sse-parser.js'

export interface HttpSSETransportOptions<
    TDataMap,
> {
    /** Endpoint that returns `text/event-stream` of `MaestroEvent`s. */
    readonly url: string
    /**
     * Static headers or a factory invoked per request. Use a factory
     * for auth tokens that may rotate between requests (typically a
     * short-lived JWT).
     */
    readonly headers?:
        | Record<string, string>
        | (() => Record<string, string> | Promise<Record<string, string>>)
    readonly credentials?: RequestCredentials
    /**
     * Customise the POST body. Defaults to `{ messages }` shape, which
     * matches barbeiro's `/api/help/chat`. Backends that expect their
     * own envelope (e.g. `{ thread, input }`) override this.
     */
    readonly bodyBuilder?: (
        messages: ReadonlyArray<MaestroMessage<TDataMap>>,
    ) => unknown
    /**
     * Override fetch — primarily for tests. Defaults to globalThis.fetch.
     */
    readonly fetch?: typeof fetch
    /**
     * Invoked for each `data:` payload that fails JSON.parse or fails
     * the runtime shape check. Defaults to a `console.warn`.
     */
    readonly onParseError?: (raw: string, error: unknown) => void
}

export function httpSSETransport<
    TDataMap = Record<string, unknown>,
>(opts: HttpSSETransportOptions<TDataMap>): Transport<TDataMap> {
    return {
        send(args: TransportSendArgs<TDataMap>): AsyncIterable<MaestroEvent> {
            return iterate(opts, args)
        },
    }
}

async function* iterate<TDataMap>(
    opts: HttpSSETransportOptions<TDataMap>,
    args: TransportSendArgs<TDataMap>,
): AsyncGenerator<MaestroEvent> {
    const fetchImpl: typeof fetch = opts.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
        throw new Error(
            'httpSSETransport: no fetch implementation available. Provide opts.fetch.',
        )
    }

    const headers = await resolveHeaders(opts.headers)
    const body = JSON.stringify(
        opts.bodyBuilder
            ? opts.bodyBuilder(args.messages)
            : { messages: args.messages },
    )

    const response = await fetchImpl(opts.url, {
        method: 'POST',
        signal: args.signal,
        credentials: opts.credentials,
        headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...headers,
        },
        body,
    })

    if (!response.ok) {
        // Surface as a stream-level error event so the reducer marks
        // the message `errored` without forcing every caller to wrap
        // `send()` in try/catch.
        yield {
            type: 'error',
            code: `HTTP_${response.status}`,
            message: `httpSSETransport: ${response.status} ${response.statusText}`,
        }
        return
    }

    if (!response.body) {
        yield {
            type: 'error',
            code: 'NO_BODY',
            message: 'httpSSETransport: response has no body',
        }
        return
    }

    const onParseError =
        opts.onParseError ??
        ((raw: string, error: unknown) => {
            // Library default: warn loudly but don't crash the stream.
            // Backends emit bad frames more often than anyone wants.
            // eslint-disable-next-line no-console
            console.warn('httpSSETransport: failed to parse frame', {
                raw,
                error,
            })
        })

    let sawDone = false
    for await (const frame of parseSseStream(response.body, args.signal)) {
        const parsed = tryParseEvent(frame.data, onParseError)
        if (parsed === null) continue
        yield parsed
        if (parsed.type === 'done' || parsed.type === 'error') {
            sawDone = true
            // Backend SHOULD close after done, but if it doesn't we
            // stop iterating ourselves so the reducer never sees
            // post-terminal events.
            return
        }
    }

    if (!sawDone) {
        // Stream closed cleanly without a `done` — synthesise one so
        // the reducer can transition the message to `complete`.
        yield { type: 'done' }
    }
}

async function resolveHeaders(
    headers: HttpSSETransportOptions<never>['headers'],
): Promise<Record<string, string>> {
    if (!headers) return {}
    if (typeof headers === 'function') return await headers()
    return headers
}

const KNOWN_EVENT_TYPES: ReadonlySet<MaestroEvent['type']> = new Set([
    'text-delta',
    'tool-call',
    'tool-progress',
    'tool-result',
    'citation',
    'data',
    'error',
    'done',
])

function tryParseEvent(
    raw: string,
    onParseError: (raw: string, error: unknown) => void,
): MaestroEvent | null {
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch (error) {
        onParseError(raw, error)
        return null
    }
    if (
        typeof value !== 'object' ||
        value === null ||
        !('type' in value) ||
        typeof (value as { type: unknown }).type !== 'string' ||
        !KNOWN_EVENT_TYPES.has(
            (value as { type: MaestroEvent['type'] }).type,
        )
    ) {
        onParseError(raw, new Error('event is not a MaestroEvent'))
        return null
    }
    return value as MaestroEvent
}
