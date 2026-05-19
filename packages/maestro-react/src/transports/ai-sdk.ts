/**
 * `aiSdkTransport` — adapter for backends streaming AI SDK v6
 * `UIMessageStream` format. Used by barbeiro's `/api/help/chat` v2.
 *
 * The AI SDK uses an SSE wire format where each frame's `data:` is a
 * JSON-encoded `UIMessageChunk`. This transport parses those chunks
 * and translates them into `MaestroEvent`s the rest of the library
 * understands.
 *
 * Translation table (chunk → MaestroEvent):
 *
 *   text-delta              → text-delta
 *   tool-input-available    → tool-call
 *   tool-input-start        → (deferred; tool-call needs the input)
 *   tool-input-delta        → ignored (we wait for tool-input-available)
 *   tool-output-available   → tool-result (success)
 *   tool-output-error       → tool-result (error)
 *   tool-input-error        → tool-result (error)
 *   source-url              → citation
 *   source-document         → citation
 *   data-<name>             → data (key=<name>)
 *   data-citations          → MULTIPLE citations (barbeiro convention)
 *   error                   → error
 *   finish                  → done
 *
 * Chunks ignored as not relevant to the protocol surface:
 *   text-start, text-end, reasoning-*, start-step, finish-step,
 *   start, abort, message-metadata, file, tool-approval-request,
 *   tool-output-denied.
 *
 * `ai` is an OPTIONAL peer dep — this transport only requires the
 * server-side wire format, not the `ai` package itself. The chunk
 * shape mirrors `UIMessageChunk` from `ai@^6` but we redeclare a
 * minimal surface here to avoid forcing the dep on consumers who
 * use this transport alone.
 */

import type { MaestroEvent } from '../protocol.js'
import type { Transport, TransportSendArgs } from '../transport.js'
import { parseSseStream } from './sse-parser.js'

export interface AiSdkTransportOptions {
    readonly url: string
    readonly headers?:
        | Record<string, string>
        | (() => Record<string, string> | Promise<Record<string, string>>)
    readonly credentials?: RequestCredentials
    readonly fetch?: typeof fetch
    /**
     * Override the POST body. Defaults to the AI SDK convention:
     * `{ messages: <UIMessage[]> }`. Barbeiro adds `{ id, ... }`.
     * Receives a raw `TransportSendArgs` — narrow `args.messages` to
     * your own `MaestroMessage<TDataMap>[]` shape if you need it.
     *
     * Per-send `metadata` from `useMaestroChat#send(text, { metadata })`
     * is reachable via `args.metadata`. Per-send `attachments` (added
     * in protocol 0.2.0-beta) is reachable via `args.attachments`. The
     * default body folds both in as top-level fields when present;
     * override this builder if your backend expects a different shape
     * (e.g. AI SDK v6 `messageMetadata` per-turn, or attachments folded
     * into the AI SDK `parts: [{ type: 'file', ... }]` per-message
     * shape).
     */
    readonly bodyBuilder?: (args: AnySendArgs) => unknown
    /**
     * Custom data-name → MaestroEvent key mapping. By convention,
     * `data-citations` chips fan out into one citation event per entry;
     * everything else passes through as a `data` event with the
     * data-name as the key.
     */
    readonly dataNameMapping?: Record<string, (data: unknown) => MaestroEvent[]>
    readonly onParseError?: (raw: string, error: unknown) => void
}

/**
 * Loose alias for `TransportSendArgs` with an unknown data map.
 * Used in `bodyBuilder` so consumers don't need to thread the
 * generic through the options type.
 */
type AnySendArgs = TransportSendArgs<Record<string, unknown>>

/**
 * Minimal shape of an AI SDK v6 chunk we care about. We accept
 * `unknown` from the wire and narrow at translate-time.
 */
type AiSdkChunk = { type: string } & Record<string, unknown>

export function aiSdkTransport<
    TDataMap = Record<string, unknown>,
>(opts: AiSdkTransportOptions): Transport<TDataMap> {
    return {
        send(args: TransportSendArgs<TDataMap>): AsyncIterable<MaestroEvent> {
            // Cast through unknown — the iterator doesn't care about
            // the data-map narrowing; only `bodyBuilder` does, and
            // that's typed against `AnySendArgs` above.
            return iterate(opts, args as unknown as AnySendArgs)
        },
    }
}

async function* iterate(
    opts: AiSdkTransportOptions,
    args: AnySendArgs,
): AsyncGenerator<MaestroEvent> {
    const fetchImpl: typeof fetch = opts.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
        throw new Error(
            'aiSdkTransport: no fetch implementation available. Provide opts.fetch.',
        )
    }

    const headers = await resolveHeaders(opts.headers)
    const body = JSON.stringify(
        opts.bodyBuilder ? opts.bodyBuilder(args) : buildDefaultBody(args),
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
            message: `aiSdkTransport: ${response.status} ${response.statusText}`,
        }
        return
    }
    if (!response.body) {
        yield {
            type: 'error',
            code: 'NO_BODY',
            message: 'aiSdkTransport: response has no body',
        }
        return
    }

    const onParseError =
        opts.onParseError ??
        ((raw, error) => {
            // eslint-disable-next-line no-console
            console.warn('aiSdkTransport: failed to parse chunk', {
                raw,
                error,
            })
        })

    let sawFinish = false
    // The AI SDK emits `tool-input-start` before `tool-input-available`
    // for streamed tool inputs. We only emit our `tool-call` once we
    // have the full input, but we cache the toolName so the eventual
    // `tool-output-*` chunk can populate `name` if needed.
    const toolNameByCallId = new Map<string, string>()

    for await (const frame of parseSseStream(response.body, args.signal)) {
        const chunk = tryParseChunk(frame.data, onParseError)
        if (chunk === null) continue
        for (const event of translateChunk(
            chunk,
            opts.dataNameMapping,
            toolNameByCallId,
        )) {
            yield event
            if (event.type === 'done' || event.type === 'error') {
                sawFinish = true
                return
            }
        }
    }

    if (!sawFinish) {
        yield { type: 'done' }
    }
}

function tryParseChunk(
    raw: string,
    onParseError: (raw: string, error: unknown) => void,
): AiSdkChunk | null {
    try {
        const value = JSON.parse(raw)
        if (
            typeof value === 'object' &&
            value !== null &&
            typeof (value as { type: unknown }).type === 'string'
        ) {
            return value as AiSdkChunk
        }
        onParseError(raw, new Error('chunk missing type field'))
        return null
    } catch (error) {
        onParseError(raw, error)
        return null
    }
}

/**
 * Translate one AI SDK chunk into 0..N MaestroEvents. Pure: takes the
 * tool-name cache by reference so we can stitch tool-input-start →
 * tool-output-* without exposing state to callers.
 */
function translateChunk(
    chunk: AiSdkChunk,
    dataNameMapping: AiSdkTransportOptions['dataNameMapping'] | undefined,
    toolNameByCallId: Map<string, string>,
): MaestroEvent[] {
    switch (chunk.type) {
        case 'text-delta': {
            const delta = typeof chunk.delta === 'string' ? chunk.delta : ''
            if (delta.length === 0) return []
            return [{ type: 'text-delta', delta }]
        }

        case 'tool-input-start': {
            const callId = String(chunk.toolCallId ?? '')
            const name = String(chunk.toolName ?? '')
            if (callId && name) toolNameByCallId.set(callId, name)
            return []
        }

        case 'tool-input-delta':
            // Partial tool input. The reducer doesn't model streaming
            // tool inputs; we emit the full call when `tool-input-available`
            // lands. Dropping this is intentional.
            return []

        case 'tool-input-available': {
            const callId = String(chunk.toolCallId ?? '')
            const name = String(chunk.toolName ?? '')
            if (!callId || !name) return []
            toolNameByCallId.set(callId, name)
            return [
                {
                    type: 'tool-call',
                    callId,
                    name,
                    input: chunk.input,
                },
            ]
        }

        case 'tool-input-error': {
            const callId = String(chunk.toolCallId ?? '')
            const name = String(chunk.toolName ?? toolNameByCallId.get(callId) ?? '')
            if (!callId) return []
            const out: MaestroEvent[] = []
            // Emit the call first so the reducer has somewhere to
            // attach the error result.
            if (!toolNameByCallId.has(callId) && name) {
                out.push({
                    type: 'tool-call',
                    callId,
                    name,
                    input: chunk.input,
                })
                toolNameByCallId.set(callId, name)
            }
            out.push({
                type: 'tool-result',
                callId,
                error: {
                    code: 'TOOL_INPUT_ERROR',
                    message:
                        typeof chunk.errorText === 'string'
                            ? chunk.errorText
                            : 'tool input invalid',
                },
            })
            return out
        }

        case 'tool-output-available': {
            const callId = String(chunk.toolCallId ?? '')
            if (!callId) return []
            return [
                {
                    type: 'tool-result',
                    callId,
                    result: chunk.output,
                },
            ]
        }

        case 'tool-output-error': {
            const callId = String(chunk.toolCallId ?? '')
            if (!callId) return []
            return [
                {
                    type: 'tool-result',
                    callId,
                    error: {
                        code: 'TOOL_OUTPUT_ERROR',
                        message:
                            typeof chunk.errorText === 'string'
                                ? chunk.errorText
                                : 'tool execution failed',
                    },
                },
            ]
        }

        case 'source-url':
            return [
                {
                    type: 'citation',
                    source: {
                        id:
                            typeof chunk.sourceId === 'string'
                                ? chunk.sourceId
                                : undefined,
                        url:
                            typeof chunk.url === 'string' ? chunk.url : undefined,
                        title:
                            typeof chunk.title === 'string'
                                ? chunk.title
                                : undefined,
                    },
                },
            ]

        case 'source-document':
            return [
                {
                    type: 'citation',
                    source: {
                        id:
                            typeof chunk.sourceId === 'string'
                                ? chunk.sourceId
                                : undefined,
                        title:
                            typeof chunk.title === 'string'
                                ? chunk.title
                                : undefined,
                    },
                },
            ]

        case 'error':
            return [
                {
                    type: 'error',
                    message:
                        typeof chunk.errorText === 'string'
                            ? chunk.errorText
                            : 'aiSdkTransport: error',
                },
            ]

        case 'finish':
            return [
                {
                    type: 'done',
                    metadata: chunk.messageMetadata,
                },
            ]

        case 'abort':
            return [
                {
                    type: 'error',
                    code: 'ABORTED',
                    message:
                        typeof chunk.reason === 'string'
                            ? chunk.reason
                            : 'stream aborted by server',
                },
            ]

        default:
            // `data-*` chips are the AI SDK's extension channel. They
            // share a common prefix so we can fan them out generically.
            if (chunk.type.startsWith('data-')) {
                return translateDataChunk(chunk, dataNameMapping)
            }
            // Everything else (text-start, text-end, reasoning-*,
            // start-step, finish-step, start, message-metadata,
            // tool-approval-request, tool-output-denied, file) is
            // intentionally ignored.
            return []
    }
}

function translateDataChunk(
    chunk: AiSdkChunk,
    dataNameMapping: AiSdkTransportOptions['dataNameMapping'] | undefined,
): MaestroEvent[] {
    const name = chunk.type.slice('data-'.length)
    if (dataNameMapping && dataNameMapping[name]) {
        return dataNameMapping[name](chunk.data)
    }
    // Built-in: `data-citations` fans out into one citation per entry.
    // Matches barbeiro's `createUIMessageStream` convention.
    if (name === 'citations' && Array.isArray(chunk.data)) {
        const events: MaestroEvent[] = []
        for (const raw of chunk.data) {
            if (typeof raw !== 'object' || raw === null) continue
            const source = raw as Record<string, unknown>
            events.push({
                type: 'citation',
                source: {
                    id:
                        typeof source.id === 'string' ? source.id : undefined,
                    url:
                        typeof source.url === 'string' ? source.url : undefined,
                    title:
                        typeof source.title === 'string'
                            ? source.title
                            : undefined,
                    snippet:
                        typeof source.snippet === 'string'
                            ? source.snippet
                            : undefined,
                },
            })
        }
        return events
    }
    return [
        {
            type: 'data',
            key: name,
            value: chunk.data,
        },
    ]
}

/**
 * Build the default POST body when no `bodyBuilder` is configured.
 * Includes `metadata` / `attachments` only when present so backends
 * that pre-date 0.2.0-beta don't see surprise fields on minimal sends.
 */
function buildDefaultBody(args: AnySendArgs): Record<string, unknown> {
    const body: Record<string, unknown> = { messages: args.messages }
    if (args.metadata !== undefined) body.metadata = args.metadata
    if (args.attachments !== undefined) body.attachments = args.attachments
    return body
}

async function resolveHeaders(
    headers: AiSdkTransportOptions['headers'],
): Promise<Record<string, string>> {
    if (!headers) return {}
    if (typeof headers === 'function') return await headers()
    return headers
}
