/**
 * `<MessageList>` — scroll container that renders every message in
 * the conversation. Composes `<MessageBubble>` per turn. Pinned-to-
 * bottom autoscroll is handled by `useAutoScroll`.
 *
 * The list intentionally does NOT own the chat hook — it takes the
 * `messages` array directly so consumers can render lists from
 * arbitrary sources (server-rendered transcripts, snapshot replays,
 * fixture data in tests).
 */

import type { MaestroCitation, MaestroMessage, MaestroToolCall } from '../message.js'
import type { DataRendererRegistry } from './data-renderers.js'
import { MessageBubble } from './message-bubble.js'
import { useAutoScroll } from './scroll-anchor.js'

export interface MessageListProps<TDataMap = Record<string, unknown>> {
    readonly messages: ReadonlyArray<MaestroMessage<TDataMap>>
    readonly dataRenderers?: DataRendererRegistry<TDataMap>
    readonly renderToolCall?: (call: MaestroToolCall) => React.ReactNode
    readonly renderCitation?: (citation: MaestroCitation) => React.ReactNode
    /** Override renderer for a whole message bubble. */
    readonly renderMessage?: (message: MaestroMessage<TDataMap>) => React.ReactNode
    readonly autoScroll?: boolean
    readonly className?: string
    /** Slot rendered at the top of the list (e.g. system intro). */
    readonly header?: React.ReactNode
}

export function MessageList<TDataMap = Record<string, unknown>>({
    messages,
    dataRenderers,
    renderToolCall,
    renderCitation,
    renderMessage,
    autoScroll = true,
    className,
    header,
}: MessageListProps<TDataMap>): React.JSX.Element {
    const { containerRef, anchorRef } = useAutoScroll(messages, autoScroll)
    const classes = ['maestro-chat-message-list', className].filter(Boolean).join(' ')

    return (
        <div ref={containerRef} className={classes} role="log" aria-live="polite">
            {header}
            {messages.map(message => (
                <div key={message.id} className="maestro-chat-message-list__item">
                    {renderMessage ? (
                        renderMessage(message)
                    ) : (
                        <MessageBubble
                            message={message}
                            dataRenderers={dataRenderers}
                            renderToolCall={renderToolCall}
                            renderCitation={renderCitation}
                        />
                    )}
                </div>
            ))}
            <div ref={anchorRef} className="maestro-chat-message-list__anchor" aria-hidden="true" />
        </div>
    )
}
