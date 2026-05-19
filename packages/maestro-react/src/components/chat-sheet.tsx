/**
 * `<ChatSheet>` — slide-in panel wrapper for bubble-mode chat.
 *
 * Renders nothing into the DOM tree when closed (so it doesn't trap
 * focus or steal pointer events). When opened, slides in from the
 * configured `side` via a CSS transform — no animation library
 * needed.
 *
 * Composition contract:
 *
 *   <ChatLauncher onOpen={...} />
 *   <ChatSheet open={open} onClose={...}>
 *       <ChatPanel chat={chat} />
 *   </ChatSheet>
 *
 * Page mode skips the sheet entirely and renders `<ChatPanel>` in
 * the layout. This shell is deliberately framework-light: no Radix,
 * no Tailwind runtime, no FocusScope. Hosts that need focus trapping
 * (e.g. modal-blocking customer-support chat) wrap children in their
 * own primitive.
 */

import { useEffect } from 'react'

export interface ChatSheetProps {
    readonly open: boolean
    readonly onClose: () => void
    /** Slot for the chat surface (typically a <ChatPanel>). */
    readonly children: React.ReactNode
    /** Sheet side. Default 'right'. */
    readonly side?: 'right' | 'bottom'
    /** Optional sheet title (rendered in a sticky header). */
    readonly title?: React.ReactNode
    /** Show a translucent backdrop. Default true. */
    readonly backdrop?: boolean
    /** Close when Escape is pressed. Default true. */
    readonly closeOnEscape?: boolean
    readonly className?: string
    /** Override the close button label. Defaults to "Close". */
    readonly closeLabel?: string
}

export function ChatSheet({
    open,
    onClose,
    children,
    side = 'right',
    title,
    backdrop = true,
    closeOnEscape = true,
    className,
    closeLabel = 'Close',
}: ChatSheetProps): React.JSX.Element | null {
    useEffect(() => {
        if (!open || !closeOnEscape) return
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [open, closeOnEscape, onClose])

    if (!open) return null

    const classes = [
        'maestro-chat-sheet',
        `maestro-chat-sheet--${side}`,
        'maestro-chat-sheet--open',
        className,
    ]
        .filter(Boolean)
        .join(' ')

    return (
        <div className="maestro-chat-sheet-root">
            {backdrop ? (
                <div
                    className="maestro-chat-sheet__backdrop"
                    onClick={onClose}
                    aria-hidden="true"
                />
            ) : null}
            <aside
                className={classes}
                role="dialog"
                aria-modal="true"
                aria-label={typeof title === 'string' ? title : 'Chat'}
            >
                {title ? (
                    <header className="maestro-chat-sheet__header">
                        <div className="maestro-chat-sheet__title">{title}</div>
                        <button
                            type="button"
                            className="maestro-chat-sheet__close"
                            onClick={onClose}
                            aria-label={closeLabel}
                        >
                            ×
                        </button>
                    </header>
                ) : (
                    <button
                        type="button"
                        className="maestro-chat-sheet__close maestro-chat-sheet__close--floating"
                        onClick={onClose}
                        aria-label={closeLabel}
                    >
                        ×
                    </button>
                )}
                <div className="maestro-chat-sheet__body">{children}</div>
            </aside>
        </div>
    )
}
