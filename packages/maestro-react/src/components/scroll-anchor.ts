/**
 * `useAutoScroll` — keeps a scroll container pinned to its bottom edge
 * as new content arrives, but disengages the moment the user scrolls
 * up (so they can review earlier messages without being yanked back).
 *
 * Implementation notes:
 *
 *  - Two refs: `containerRef` on the scroller, `anchorRef` on a 1px
 *    sentinel rendered at the bottom of the content. An
 *    IntersectionObserver tracks whether the anchor is visible — if
 *    yes, autoscroll is "engaged" and we scroll to it on every
 *    dependency change.
 *
 *  - We DON'T use `scrollIntoView({ behavior: 'smooth' })` while
 *    streaming — at chat cadence (every text-delta) smooth animation
 *    jitters. Instant scroll is correct here.
 *
 *  - SSR-safe: all DOM access is inside `useEffect`. The hook returns
 *    refs the consumer attaches via JSX.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseAutoScrollResult<
    TContainer extends HTMLElement,
    TAnchor extends HTMLElement,
> {
    readonly containerRef: React.RefObject<TContainer | null>
    readonly anchorRef: React.RefObject<TAnchor | null>
    readonly isPinned: boolean
    /** Force-scroll to the bottom and re-engage pinning. */
    readonly scrollToBottom: () => void
}

export function useAutoScroll<
    TContainer extends HTMLElement = HTMLDivElement,
    TAnchor extends HTMLElement = HTMLDivElement,
>(
    /**
     * Dependency the scroller reacts to — typically the message array.
     * Pass an array or any value whose identity changes on new content.
     */
    dep: unknown,
    enabled: boolean = true,
): UseAutoScrollResult<TContainer, TAnchor> {
    const containerRef = useRef<TContainer>(null)
    const anchorRef = useRef<TAnchor>(null)
    const [isPinned, setIsPinned] = useState(true)
    // Mirror state in a ref so the layout effect below sees the latest
    // value without resubscribing on every flip.
    const pinnedRef = useRef(true)
    useEffect(() => {
        pinnedRef.current = isPinned
    }, [isPinned])

    // Track when the anchor becomes visible/invisible — that's our
    // proxy for "user is at bottom".
    useEffect(() => {
        const anchor = anchorRef.current
        const container = containerRef.current
        if (!enabled || !anchor || !container) return
        if (typeof IntersectionObserver === 'undefined') return

        const io = new IntersectionObserver(
            entries => {
                const entry = entries[0]
                if (!entry) return
                setIsPinned(entry.isIntersecting)
            },
            { root: container, threshold: 0.0 },
        )
        io.observe(anchor)
        return () => io.disconnect()
    }, [enabled])

    // When the dependency changes (new message / new chunk), if we're
    // still pinned, scroll to the anchor. Use a layout effect so the
    // scroll happens before the browser paints to avoid a visible jump.
    useEffect(() => {
        if (!enabled) return
        if (!pinnedRef.current) return
        const anchor = anchorRef.current
        if (!anchor) return
        anchor.scrollIntoView({ block: 'end' })
    }, [dep, enabled])

    const scrollToBottom = useCallback(() => {
        const anchor = anchorRef.current
        if (!anchor) return
        anchor.scrollIntoView({ block: 'end' })
        setIsPinned(true)
    }, [])

    return { containerRef, anchorRef, isPinned, scrollToBottom }
}
