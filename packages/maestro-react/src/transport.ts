/**
 * Transport contract — the seam between the hook and the wire.
 *
 * A transport is a pure async iterator factory: given the current
 * conversation and an abort signal, yield `MaestroEvent`s until the
 * stream completes (`done`), errors (`error`), or the signal fires.
 *
 * The hook drives iteration; the transport never knows about React.
 * This keeps transports trivially unit-testable with mock fetch and
 * lets backends adopt new ones without touching the hook.
 */

import type { MaestroAttachment, MaestroEvent } from './protocol.js'
import type { MaestroMessage } from './message.js'

export interface TransportSendArgs<
    TDataMap = Record<string, unknown>,
> {
    /**
     * Full message history, including the user message just appended
     * by the hook. The transport is responsible for serializing this
     * into whatever wire format the backend expects.
     */
    readonly messages: ReadonlyArray<MaestroMessage<TDataMap>>
    /**
     * Fires when the consumer calls `abort()`, the component unmounts,
     * or a new `send()` supersedes the current request. Transports
     * MUST honour this — at minimum by aborting the underlying fetch.
     */
    readonly signal: AbortSignal
    /**
     * Optional per-send envelope passed verbatim from
     * `useMaestroChat#send(text, { metadata })` (or any other call site
     * that originated the request — `regenerate()` forwards the
     * metadata of the user turn it re-runs if any was attached).
     *
     * Transports SHOULD fold this into the wire body — for example as
     * the second argument to `httpSSETransport`'s `bodyBuilder`, or
     * via `args.metadata` inside `aiSdkTransport`'s / `legacySseTransport`'s
     * `bodyBuilder({ messages, metadata })`. The library does not
     * inspect the value; it is a side channel for callers that need to
     * tag a single turn (e.g. AI SDK message metadata, request-scoped
     * feature flags, idempotency keys).
     */
    readonly metadata?: unknown
    /**
     * User-attached media for the turn being sent. Forwarded verbatim
     * from `useMaestroChat#send(text, { attachments })`. The hook also
     * stamps the same array onto the trailing user `MaestroMessage` so
     * UIs can render previews without inspecting transport args.
     *
     * Default transport `bodyBuilder`s fold `attachments` into the POST
     * body as a top-level `attachments` field when present; custom
     * builders receive it as the second argument (`httpSSETransport`)
     * or on `args.attachments` (`aiSdkTransport` / `legacySseTransport`).
     *
     * Added in protocol 0.2.0-beta. See `MaestroAttachment` in
     * `./protocol.ts`.
     */
    readonly attachments?: ReadonlyArray<MaestroAttachment>
}

export interface Transport<
    TDataMap = Record<string, unknown>,
> {
    send(args: TransportSendArgs<TDataMap>): AsyncIterable<MaestroEvent>
}
