/**
 * `<CitationCard>` — single source pill. Default renderer for
 * `MaestroCitation`. Hosts override via `<ChatPanel renderCitation>`
 * or `<MessageBubble renderCitation>`.
 *
 * Renders a compact link with the title (or URL host) and an optional
 * snippet underneath. If the citation has no URL, falls back to a
 * non-clickable card with the title and snippet.
 */

import type { MaestroCitation } from '../message.js'

export interface CitationCardProps {
    readonly citation: MaestroCitation
    readonly className?: string
}

export function CitationCard({ citation, className }: CitationCardProps): React.JSX.Element {
    const classes = ['maestro-citation-card', className].filter(Boolean).join(' ')
    const label =
        citation.title ?? (citation.url ? safeHost(citation.url) : 'source')
    const body = citation.url ? (
        <a
            className="maestro-citation-card__link"
            href={citation.url}
            target="_blank"
            rel="noopener noreferrer"
        >
            {label}
        </a>
    ) : (
        <span className="maestro-citation-card__label">{label}</span>
    )
    return (
        <div className={classes} data-call-id={citation.callId ?? undefined}>
            <div className="maestro-citation-card__title">{body}</div>
            {citation.snippet ? (
                <p className="maestro-citation-card__snippet">{citation.snippet}</p>
            ) : null}
        </div>
    )
}

function safeHost(url: string): string {
    try {
        return new URL(url).host
    } catch {
        return url
    }
}
