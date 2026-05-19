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

import type { MaestroAttachment, MaestroEvent } from '../protocol.js'
import type { MaestroMessage } from '../message.js'
import type {
    BodyBuilderArgs,
    Transport,
    TransportSendArgs,
} from '../transport.js'
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
     *
     * Receives the unified `BodyBuilderArgs` object (same shape across
     * all three transports as of 0.5.0-beta):
     *
     *   - `args.messages` — full history with the trailing user turn
     *     and any `attachments` the hook stamped on it
     *   - `args.metadata` — per-send envelope from
     *     `useMaestroChat#send(text, { metadata })`, `undefined` when
     *     omitted
     *   - `args.attachments` — per-send media from
     *     `useMaestroChat#send(text, { attachments })`, `undefined`
     *     when omitted (added in protocol 0.2.0-beta)
     *
     * @deprecated The legacy positional form `(messages, metadata,
     * attachments)` is still accepted for backwards compatibility with
     * 0.4.x consumers, but emits a one-time `console.warn` in non-
     * production builds. It is scheduled for removal in 1.0 — switch
     * to the object-arg form.
     */
    readonly bodyBuilder?: BodyBuilderFn<TDataMap>
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

/**
 * Modern object-arg shape (preferred, 0.5+).
 */
type BodyBuilderObjectFn<TDataMap> = (
    args: BodyBuilderArgs<TDataMap>,
) => unknown

/**
 * Legacy positional shape carried over from 0.4. Still accepted; emits
 * a one-time deprecation warning per builder. Slated for removal in 1.0.
 */
type BodyBuilderPositionalFn<TDataMap> = (
    messages: ReadonlyArray<MaestroMessage<TDataMap>>,
    metadata?: unknown,
    attachments?: ReadonlyArray<MaestroAttachment>,
) => unknown

type BodyBuilderFn<TDataMap> =
    | BodyBuilderObjectFn<TDataMap>
    | BodyBuilderPositionalFn<TDataMap>

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
    const builderArgs: BodyBuilderArgs<TDataMap> = {
        messages: args.messages,
        metadata: args.metadata,
        attachments: args.attachments,
    }
    const body = JSON.stringify(
        opts.bodyBuilder
            ? callBodyBuilder(opts.bodyBuilder, builderArgs)
            : buildDefaultBody(
                  args.messages,
                  args.metadata,
                  args.attachments,
              ),
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

/**
 * Tracks `bodyBuilder` functions we've already warned about so the
 * deprecation message fires at most once per builder per process —
 * busy chats fire `send()` many times a session and noisy logs are a
 * known adoption irritant.
 *
 * `WeakSet` accepts `Function` keys in modern V8 (Node 18+, all
 * browser targets we support) and releases them when the consumer
 * drops the reference, so this never holds onto stale closures.
 */
const POSITIONAL_BUILDER_WARNED = new WeakSet<object>()

/**
 * Read `NODE_ENV` without assuming `process` exists at runtime — the
 * package ships to both Node and browser targets, and the build's
 * `tsconfig` does not pull in `@types/node`. Bundlers replace the
 * inlined access string in production builds; in pure browsers
 * `process` is undefined and we fall through to "non-production" so
 * the deprecation warn still fires during local dev.
 */
function isProduction(): boolean {
    const g = globalThis as { process?: { env?: { NODE_ENV?: string } } }
    return g.process?.env?.NODE_ENV === 'production'
}

/**
 * Dispatch to either the modern object-arg `bodyBuilder` or the legacy
 * positional shape, deciding by `function.length`.
 *
 * Heuristic, intentionally: `function.length` is reliable for the
 * common cases — arrow functions, named-param functions, and bound
 * functions all report their declared param count correctly. A class
 * method declared with default values for every parameter would
 * misreport as `0` and route to the object-arg branch even if the
 * author intended positional — but no real consumer hits that, and
 * the cost of guessing wrong is one bad JSON body, not a corrupted
 * stream. The positional form is scheduled for removal in 1.0, at
 * which point this helper goes away.
 */
function callBodyBuilder<TDataMap>(
    bb: BodyBuilderFn<TDataMap>,
    args: BodyBuilderArgs<TDataMap>,
): unknown {
    // length <= 1 → object-arg shape (modern) or zero-arg
    // (consumer ignores everything). Both are safe to call with the
    // unified args object.
    if (bb.length <= 1) {
        return (bb as BodyBuilderObjectFn<TDataMap>)(args)
    }
    // length > 1 → legacy positional shape. Warn once per builder.
    // `process.env.NODE_ENV` is accessed defensively — the package
    // ships to both Node bundlers (which inline it) and pure browser
    // bundles where `process` may be undefined. Bundlers that DCE on
    // the inlined string drop the warn branch in production builds.
    if (!isProduction() && !POSITIONAL_BUILDER_WARNED.has(bb)) {
        POSITIONAL_BUILDER_WARNED.add(bb)
        // eslint-disable-next-line no-console
        console.warn(
            '[maestro-react] httpSSETransport bodyBuilder positional args are deprecated; ' +
                'switch to `(args) => ...` per v0.5 unification. Positional form will be removed in v1.0.',
        )
    }
    return (bb as BodyBuilderPositionalFn<TDataMap>)(
        args.messages,
        args.metadata,
        args.attachments,
    )
}

/**
 * Build the default POST body when no `bodyBuilder` is configured.
 * Includes `metadata` / `attachments` only when present so backends
 * that pre-date 0.2.0-beta don't see surprise fields on minimal sends.
 */
function buildDefaultBody<TDataMap>(
    messages: ReadonlyArray<MaestroMessage<TDataMap>>,
    metadata: unknown,
    attachments: ReadonlyArray<MaestroAttachment> | undefined,
): Record<string, unknown> {
    const body: Record<string, unknown> = { messages }
    if (metadata !== undefined) body.metadata = metadata
    if (attachments !== undefined) body.attachments = attachments
    return body
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
