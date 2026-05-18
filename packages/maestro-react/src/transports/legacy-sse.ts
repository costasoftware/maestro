/**
 * `legacySseTransport` — the killer adapter for adoption without
 * backend changes. Consumers map their existing SSE event names onto
 * `MaestroEvent`s; the rest of the library treats their stream as if
 * it were protocol-native.
 *
 * Used by:
 *   - numenion: event names `text_delta` | `tool_use` | `tool_result`
 *     | `error` | `done`
 *   - trading-rag (current): `token` | `agent_start` | `agent_step`
 *     | `agent_result` | `sources` | `chart_*` | `done` | `error`
 *
 * The mapper returns 0, 1, or N MaestroEvents per legacy frame. Unknown
 * event names are logged through `onUnknownEvent` (defaults to
 * `console.warn`) and skipped. Mappers that return `null` are also
 * treated as "no events" — useful for legacy frames that carry pure
 * metadata the protocol doesn't model.
 */

import type { MaestroEvent } from '../protocol.js'
import type { Transport, TransportSendArgs } from '../transport.js'
import { parseSseStream } from './sse-parser.js'

export interface LegacyEventMapContext {
    /**
     * Generate a fresh callId for synthetic tool-call events. Useful
     * when the legacy stream doesn't carry a callId — numenion's
     * `tool_use` is the canonical example.
     */
    nextCallId(): string
    /**
     * The last callId issued by `nextCallId()`. Use when a legacy
     * `tool_result` frame needs to be matched against the synthetic
     * call created at the most recent `tool_use`.
     */
    lastCallId(): string | undefined
}

export type LegacyEventMapper<TDataMap> = (
    data: unknown,
    ctx: LegacyEventMapContext,
) => MaestroEvent | MaestroEvent[] | null

export type LegacyEventMap<TDataMap> = Record<
    string,
    LegacyEventMapper<TDataMap>
>

export interface LegacySseTransportOptions<
    TDataMap,
> {
    readonly url: string
    readonly headers?:
        | Record<string, string>
        | (() => Record<string, string> | Promise<Record<string, string>>)
    readonly credentials?: RequestCredentials
    /**
     * Map of legacy `event:` name → translator. Required; without it
     * every frame is unknown.
     */
    readonly eventMap: LegacyEventMap<TDataMap>
    /**
     * Customise the POST body. Defaults to `{ messages }`. Backends
     * with their own envelope (numenion's UIMessage[] from useChat,
     * trading-rag's `{ message, conversation_id }`) override this.
     */
    readonly bodyBuilder?: (args: TransportSendArgs<TDataMap>) => unknown
    readonly fetch?: typeof fetch
    /**
     * Invoked when an `event:` name has no mapper entry. Defaults to
     * `console.warn`. Use this for telemetry on backends that emit
     * new events you haven't mapped yet.
     */
    readonly onUnknownEvent?: (eventName: string, data: string) => void
    /**
     * Invoked when the JSON `data:` payload fails to parse. Defaults
     * to `console.warn`. The mapper still gets called with the raw
     * string when parsing fails — many legacy backends emit plain-text
     * data, so the mapper can choose to handle that.
     */
    readonly onParseError?: (raw: string, error: unknown) => void
}

export function legacySseTransport<
    TDataMap = Record<string, unknown>,
>(opts: LegacySseTransportOptions<TDataMap>): Transport<TDataMap> {
    return {
        send(args: TransportSendArgs<TDataMap>): AsyncIterable<MaestroEvent> {
            return iterate(opts, args)
        },
    }
}

async function* iterate<TDataMap>(
    opts: LegacySseTransportOptions<TDataMap>,
    args: TransportSendArgs<TDataMap>,
): AsyncGenerator<MaestroEvent> {
    const fetchImpl: typeof fetch = opts.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
        throw new Error(
            'legacySseTransport: no fetch implementation available. Provide opts.fetch.',
        )
    }

    const headers = await resolveHeaders(opts.headers)
    const body = JSON.stringify(
        opts.bodyBuilder
            ? opts.bodyBuilder(args)
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
        yield {
            type: 'error',
            code: `HTTP_${response.status}`,
            message: `legacySseTransport: ${response.status} ${response.statusText}`,
        }
        return
    }
    if (!response.body) {
        yield {
            type: 'error',
            code: 'NO_BODY',
            message: 'legacySseTransport: response has no body',
        }
        return
    }

    const onUnknownEvent =
        opts.onUnknownEvent ??
        ((name: string) => {
            // eslint-disable-next-line no-console
            console.warn('legacySseTransport: unknown event', { name })
        })
    const onParseError =
        opts.onParseError ??
        ((raw: string, error: unknown) => {
            // eslint-disable-next-line no-console
            console.warn('legacySseTransport: failed to parse frame', {
                raw,
                error,
            })
        })

    // CallId scratchpad — single counter per stream so synthetic
    // tool-call IDs are stable for the mapper's `lastCallId()` peek.
    let callCounter = 0
    let lastIssuedCallId: string | undefined
    const ctx: LegacyEventMapContext = {
        nextCallId(): string {
            callCounter += 1
            lastIssuedCallId = `legacy_${callCounter}`
            return lastIssuedCallId
        },
        lastCallId(): string | undefined {
            return lastIssuedCallId
        },
    }

    let sawTerminal = false
    for await (const frame of parseSseStream(response.body, args.signal)) {
        const mapper = opts.eventMap[frame.event]
        if (!mapper) {
            onUnknownEvent(frame.event, frame.data)
            continue
        }
        let payload: unknown
        try {
            payload = frame.data.length > 0 ? JSON.parse(frame.data) : null
        } catch (error) {
            onParseError(frame.data, error)
            // Pass the raw string to the mapper so it can handle plain-text
            // legacy events (some backends emit raw text on `event: token`).
            payload = frame.data
        }
        const result = mapper(payload, ctx)
        if (result === null) continue
        const events = Array.isArray(result) ? result : [result]
        for (const event of events) {
            yield event
            if (event.type === 'done' || event.type === 'error') {
                sawTerminal = true
                return
            }
        }
    }

    if (!sawTerminal) {
        yield { type: 'done' }
    }
}

async function resolveHeaders(
    headers: LegacySseTransportOptions<never>['headers'],
): Promise<Record<string, string>> {
    if (!headers) return {}
    if (typeof headers === 'function') return await headers()
    return headers
}
