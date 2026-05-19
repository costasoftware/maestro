/**
 * `<ToolCallCard>` — collapsible card showing the name + status of a
 * tool invocation. Default renderer for `MaestroToolCall`. Hosts
 * override via `<ChatPanel renderToolCall>` or `<MessageBubble
 * renderToolCall>` when they want product-specific affordances (e.g.
 * a custom card per tool name).
 *
 * Collapsed by default: a single line with name + status badge. Click
 * to expand the input / progress / result JSON. Error tool-results
 * also surface the error code + message inline so the user doesn't
 * have to expand to see them.
 */

import { useState } from 'react'

import type { MaestroToolCall } from '../message.js'

export interface ToolCallCardProps {
    readonly call: MaestroToolCall
    /** Force-collapsed by default. Click to expand JSON. */
    readonly defaultExpanded?: boolean
    readonly className?: string
}

export function ToolCallCard({
    call,
    defaultExpanded = false,
    className,
}: ToolCallCardProps): React.JSX.Element {
    const [expanded, setExpanded] = useState(defaultExpanded)
    const classes = [
        'maestro-tool-call-card',
        `maestro-tool-call-card--${call.status}`,
        className,
    ]
        .filter(Boolean)
        .join(' ')

    return (
        <div className={classes} data-call-id={call.callId}>
            <button
                type="button"
                className="maestro-tool-call-card__header"
                onClick={() => setExpanded(prev => !prev)}
                aria-expanded={expanded}
            >
                <span className="maestro-tool-call-card__name">{call.name}</span>
                <span className="maestro-tool-call-card__status">{call.status}</span>
                <span
                    className="maestro-tool-call-card__chevron"
                    aria-hidden="true"
                >
                    {expanded ? '▾' : '▸'}
                </span>
            </button>
            {call.status === 'errored' && call.error ? (
                <p className="maestro-tool-call-card__error">
                    <strong>{call.error.code}</strong>: {call.error.message}
                </p>
            ) : null}
            {expanded ? (
                <div className="maestro-tool-call-card__body">
                    <Section title="input" value={call.input} />
                    {call.progress.length > 0 ? (
                        <Section title="progress" value={call.progress} />
                    ) : null}
                    {call.result !== undefined ? (
                        <Section title="result" value={call.result} />
                    ) : null}
                </div>
            ) : null}
        </div>
    )
}

function Section({ title, value }: { title: string; value: unknown }): React.JSX.Element {
    return (
        <div className="maestro-tool-call-card__section">
            <div className="maestro-tool-call-card__section-title">{title}</div>
            <pre className="maestro-tool-call-card__json">{safeStringify(value)}</pre>
        </div>
    )
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}
