/**
 * `<ChatInput>` — text entry + send button.
 *
 * Two modes:
 *
 *  - single-line (default): plain `<input>`, Enter submits.
 *  - multiline: `<textarea>`, Enter submits, Shift+Enter inserts a
 *    newline. Mirrors the convention used across ChatGPT, Claude.ai,
 *    Slack, Linear AI, etc.
 *
 * Stateless w.r.t. transmission — the parent owns the chat hook and
 * passes `disabled` while a turn is in flight. We control the text
 * value internally because the consumer only cares about the final
 * submitted string.
 */

import { useCallback, useState, type FormEvent, type KeyboardEvent } from 'react'

export interface ChatInputProps {
    readonly onSend: (text: string) => void
    readonly disabled?: boolean
    readonly placeholder?: string
    /** Multi-line input mode. Default false (single line + send-on-enter). */
    readonly multiline?: boolean
    readonly className?: string
    /** Label rendered inside the submit button. Defaults to "Send". */
    readonly submitLabel?: React.ReactNode
}

export function ChatInput({
    onSend,
    disabled = false,
    placeholder,
    multiline = false,
    className,
    submitLabel = 'Send',
}: ChatInputProps): React.JSX.Element {
    const [value, setValue] = useState('')

    const submit = useCallback(() => {
        const trimmed = value.trim()
        if (trimmed.length === 0) return
        onSend(trimmed)
        setValue('')
    }, [value, onSend])

    const handleSubmit = useCallback(
        (e: FormEvent<HTMLFormElement>) => {
            e.preventDefault()
            if (disabled) return
            submit()
        },
        [disabled, submit],
    )

    const handleTextareaKeyDown = useCallback(
        (e: KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key !== 'Enter') return
            // Shift+Enter (or any modifier) inserts a newline.
            if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
            e.preventDefault()
            if (disabled) return
            submit()
        },
        [disabled, submit],
    )

    const classes = ['maestro-chat-input', className].filter(Boolean).join(' ')
    const canSend = !disabled && value.trim().length > 0

    return (
        <form className={classes} onSubmit={handleSubmit}>
            {multiline ? (
                <textarea
                    className="maestro-chat-input__textarea"
                    value={value}
                    onChange={e => setValue(e.target.value)}
                    onKeyDown={handleTextareaKeyDown}
                    placeholder={placeholder}
                    disabled={disabled}
                    rows={2}
                    aria-label={placeholder ?? 'Message'}
                />
            ) : (
                <input
                    className="maestro-chat-input__field"
                    type="text"
                    value={value}
                    onChange={e => setValue(e.target.value)}
                    placeholder={placeholder}
                    disabled={disabled}
                    aria-label={placeholder ?? 'Message'}
                />
            )}
            <button
                type="submit"
                className="maestro-chat-input__submit"
                disabled={!canSend}
                aria-label="Send message"
            >
                {submitLabel}
            </button>
        </form>
    )
}
