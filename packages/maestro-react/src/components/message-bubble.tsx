/**
 * `<MessageBubble>` — single turn renderer (user OR assistant).
 *
 * Composition order inside an assistant bubble:
 *
 *   1. text body (`MaestroMessage.text`)
 *   2. tool calls (renderToolCall override OR <ToolCallCard>)
 *   3. data attachments (dataRenderers[key] OR fallback JSON)
 *   4. citations (renderCitation override OR <CitationCard>)
 *   5. error footer (when status === 'errored' or 'aborted')
 *
 * Data attachments are intentionally rendered BEFORE citations because
 * citations typically anchor the entire turn ("sources I consulted")
 * while data chips are usually inline status updates.
 */

import { Fragment } from 'react'

import type { MaestroCitation, MaestroMessage, MaestroToolCall } from '../message.js'
import { CitationCard } from './citation-card.js'
import type { DataRendererRegistry } from './data-renderers.js'
import { ToolCallCard } from './tool-call-card.js'

export interface MessageBubbleProps<TDataMap = Record<string, unknown>> {
    readonly message: MaestroMessage<TDataMap>
    readonly dataRenderers?: DataRendererRegistry<TDataMap>
    readonly renderToolCall?: (call: MaestroToolCall) => React.ReactNode
    readonly renderCitation?: (citation: MaestroCitation) => React.ReactNode
    readonly className?: string
}

export function MessageBubble<TDataMap = Record<string, unknown>>({
    message,
    dataRenderers,
    renderToolCall,
    renderCitation,
    className,
}: MessageBubbleProps<TDataMap>): React.JSX.Element {
    const classes = [
        'maestro-chat-bubble',
        `maestro-chat-bubble--${message.role}`,
        `maestro-chat-bubble--${message.status}`,
        className,
    ]
        .filter(Boolean)
        .join(' ')

    const showCursor = message.role === 'assistant' && message.status === 'streaming'

    return (
        <div
            className={classes}
            data-message-id={message.id}
            data-role={message.role}
            data-status={message.status}
        >
            {message.text || message.role === 'user' ? (
                <div className="maestro-chat-bubble__text">
                    {message.text}
                    {showCursor ? (
                        <span className="maestro-chat-bubble__cursor" aria-hidden="true">
                            ▍
                        </span>
                    ) : null}
                </div>
            ) : message.status === 'pending' || message.status === 'streaming' ? (
                <div className="maestro-chat-bubble__placeholder" aria-label="thinking">
                    <span className="maestro-chat-bubble__dot" />
                    <span className="maestro-chat-bubble__dot" />
                    <span className="maestro-chat-bubble__dot" />
                </div>
            ) : null}

            {message.toolCalls.length > 0 ? (
                <div className="maestro-chat-bubble__tools">
                    {message.toolCalls.map(call => (
                        <Fragment key={call.callId}>
                            {renderToolCall ? renderToolCall(call) : <ToolCallCard call={call} />}
                        </Fragment>
                    ))}
                </div>
            ) : null}

            {message.data.length > 0 ? (
                <div className="maestro-chat-bubble__data">
                    {message.data.map((entry, idx) => (
                        <DataEntry
                            // Multiple data events may share a key, so include the index.
                            key={`${String(entry.key)}-${idx}`}
                            entry={entry}
                            registry={dataRenderers}
                        />
                    ))}
                </div>
            ) : null}

            {message.citations.length > 0 ? (
                <div className="maestro-chat-bubble__citations">
                    {message.citations.map((citation, idx) => (
                        <Fragment key={citation.id ?? citation.url ?? idx}>
                            {renderCitation ? (
                                renderCitation(citation)
                            ) : (
                                <CitationCard citation={citation} />
                            )}
                        </Fragment>
                    ))}
                </div>
            ) : null}

            {message.status === 'errored' && message.error ? (
                <p className="maestro-chat-bubble__error">
                    {message.error.code ? <strong>{message.error.code}: </strong> : null}
                    {message.error.message}
                </p>
            ) : null}
            {message.status === 'aborted' ? (
                <p className="maestro-chat-bubble__aborted">(stopped)</p>
            ) : null}
        </div>
    )
}

interface DataEntryProps<TDataMap> {
    readonly entry: MaestroMessage<TDataMap>['data'][number]
    readonly registry?: DataRendererRegistry<TDataMap>
}

function DataEntry<TDataMap>({ entry, registry }: DataEntryProps<TDataMap>): React.JSX.Element {
    // Narrowing through a homomorphic mapped type loses to TS' value-
    // space inference here, so we cast at the lookup site. Runtime is
    // safe: the registry value is either `undefined` or a renderer that
    // expects exactly `entry.value`'s type for this key.
    const Renderer = registry?.[entry.key as keyof TDataMap] as
        | React.ComponentType<{ value: unknown; callId?: string }>
        | undefined

    if (Renderer) {
        return <Renderer value={entry.value} callId={entry.callId} />
    }
    return (
        <pre className="maestro-chat-bubble__data-fallback" data-key={String(entry.key)}>
            {safeStringify(entry.value)}
        </pre>
    )
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}
