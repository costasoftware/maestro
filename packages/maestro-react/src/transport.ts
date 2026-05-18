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

import type { MaestroEvent } from './protocol.js'
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
}

export interface Transport<
    TDataMap = Record<string, unknown>,
> {
    send(args: TransportSendArgs<TDataMap>): AsyncIterable<MaestroEvent>
}
