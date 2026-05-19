/**
 * `<ChatPanel>` — the actual chat surface: message list + input.
 *
 * Composes `<MessageList>` + `<ChatInput>` into the canonical layout
 * (scroll area on top, fixed input at the bottom). Designed to be
 * dropped INTO:
 *
 *   - a `<ChatSheet>` for bubble mode (FAB → slide-in)
 *   - any full-height container for page mode
 *
 * Takes the `UseMaestroChatReturn` output directly so consumers don't
 * have to wire `send` / `messages` separately. This is the single
 * highest-leverage component in the package: with a working transport,
 * `<ChatPanel chat={useMaestroChat(...)} />` is a complete chat UI.
 */

import type { MaestroCitation, MaestroToolCall } from '../message.js'
import type { UseMaestroChatReturn } from '../hook.js'
import { ChatInput } from './chat-input.js'
import type { DataRendererRegistry } from './data-renderers.js'
import { MessageList } from './message-list.js'

export interface ChatPanelProps<TDataMap = Record<string, unknown>> {
    /** Output of `useMaestroChat`. */
    readonly chat: UseMaestroChatReturn<TDataMap>
    /** Renderers for typed data events. Optional. */
    readonly dataRenderers?: DataRendererRegistry<TDataMap>
    /** Renderer for each tool call. Falls back to <ToolCallCard>. */
    readonly renderToolCall?: (call: MaestroToolCall) => React.ReactNode
    /** Renderer for each citation. Falls back to <CitationCard>. */
    readonly renderCitation?: (citation: MaestroCitation) => React.ReactNode
    /** Empty-state slot, rendered when there are zero messages. */
    readonly emptyState?: React.ReactNode
    /** Input placeholder text. */
    readonly placeholder?: string
    /** Whether the input should be multiline. Default false. */
    readonly multiline?: boolean
    /** Whether to autoscroll to bottom on new message. Default true. */
    readonly autoScroll?: boolean
    /** Slot rendered above the message list (e.g. quick actions). */
    readonly header?: React.ReactNode
    /** Slot rendered below the input (e.g. terms / model name). */
    readonly footer?: React.ReactNode
    readonly className?: string
}

export function ChatPanel<TDataMap = Record<string, unknown>>({
    chat,
    dataRenderers,
    renderToolCall,
    renderCitation,
    emptyState,
    placeholder,
    multiline = false,
    autoScroll = true,
    header,
    footer,
    className,
}: ChatPanelProps<TDataMap>): React.JSX.Element {
    const classes = ['maestro-chat-panel', className].filter(Boolean).join(' ')
    const hasMessages = chat.messages.length > 0

    return (
        <div className={classes}>
            <div className="maestro-chat-panel__body">
                {hasMessages ? (
                    <MessageList
                        messages={chat.messages}
                        dataRenderers={dataRenderers}
                        renderToolCall={renderToolCall}
                        renderCitation={renderCitation}
                        autoScroll={autoScroll}
                        header={header}
                    />
                ) : (
                    <div className="maestro-chat-panel__empty">
                        {emptyState ?? (
                            <p className="maestro-chat-panel__empty-default">
                                Ask me anything to get started.
                            </p>
                        )}
                    </div>
                )}
            </div>

            {chat.error ? (
                <div className="maestro-chat-panel__error" role="alert">
                    {chat.error.code ? <strong>{chat.error.code}: </strong> : null}
                    {chat.error.message}
                </div>
            ) : null}

            <div className="maestro-chat-panel__input">
                <ChatInput
                    onSend={text => {
                        void chat.send(text)
                    }}
                    disabled={chat.isLoading}
                    placeholder={placeholder}
                    multiline={multiline}
                />
                {chat.isLoading ? (
                    <button
                        type="button"
                        className="maestro-chat-panel__stop"
                        onClick={chat.abort}
                        aria-label="Stop"
                    >
                        Stop
                    </button>
                ) : null}
            </div>

            {footer ? <div className="maestro-chat-panel__footer">{footer}</div> : null}
        </div>
    )
}
