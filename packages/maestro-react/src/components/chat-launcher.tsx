/**
 * `<ChatLauncher>` — floating action button that opens a `<ChatSheet>`.
 *
 * Pairs with `<ChatSheet>` to deliver the canonical "bubble" mode:
 *
 *   const [open, setOpen] = useState(false)
 *   const chat = useMaestroChat({ transport })
 *   return (
 *       <>
 *           <ChatLauncher onOpen={() => setOpen(true)} />
 *           <ChatSheet open={open} onClose={() => setOpen(false)}>
 *               <ChatPanel chat={chat} />
 *           </ChatSheet>
 *       </>
 *   )
 *
 * Pure CSS positioning + transition; no Framer Motion / Tailwind /
 * Radix runtime deps. Hosts override the look via CSS vars
 * (`--maestro-launcher-bg`, `--maestro-launcher-fg`) or the `className`
 * prop.
 */

export interface ChatLauncherProps {
    readonly onOpen: () => void
    /** Custom icon node. Defaults to a chat bubble SVG. */
    readonly icon?: React.ReactNode
    /** Optional badge for unread count / pulse. */
    readonly badge?: React.ReactNode
    /** Position preset. Default 'bottom-right'. */
    readonly position?: 'bottom-right' | 'bottom-left'
    /** Accessibility label. Defaults to "Open chat". */
    readonly 'aria-label'?: string
    /** Bring-your-own className for the FAB button. */
    readonly className?: string
}

export function ChatLauncher({
    onOpen,
    icon,
    badge,
    position = 'bottom-right',
    'aria-label': ariaLabel = 'Open chat',
    className,
}: ChatLauncherProps): React.JSX.Element {
    const classes = [
        'maestro-chat-launcher',
        `maestro-chat-launcher--${position}`,
        className,
    ]
        .filter(Boolean)
        .join(' ')

    return (
        <button
            type="button"
            className={classes}
            onClick={onOpen}
            aria-label={ariaLabel}
        >
            <span className="maestro-chat-launcher__icon" aria-hidden="true">
                {icon ?? <DefaultChatIcon />}
            </span>
            {badge ? (
                <span className="maestro-chat-launcher__badge">{badge}</span>
            ) : null}
        </button>
    )
}

function DefaultChatIcon(): React.JSX.Element {
    return (
        <svg
            viewBox="0 0 24 24"
            width="24"
            height="24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
    )
}
