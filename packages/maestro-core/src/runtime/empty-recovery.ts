/**
 * Empty-text recovery decision helper.
 *
 * The recoverable bug class: the model called a tool, got valid data
 * back, then emitted zero user-visible text. The visitor sees an empty
 * bubble below the tool card and reads it as failure. Symptom seen in
 * prod across multiple deployments — `event.text === '' && event.toolCalls.length > 0`
 * after streamText finishes.
 *
 * The kernel offers this as a PURE decision helper. Callers detect the
 * empty-text condition themselves (cheapest check: `text.trim().length === 0`
 * after a turn that invoked tools), supply the locale-appropriate
 * fallback string, and act on the decision struct (inject text into
 * the stream + persist the recovery error code on the turn row).
 *
 * Why a helper instead of in-kernel recovery: the act of injecting
 * text mid-stream is host-specific (Next.js Server Components,
 * Cloudflare Worker, raw Node HTTP all differ). The decision is
 * portable; the execution is not.
 */
export type EmptyRecoveryMode = 'off' | 'log_only' | 'enforce'

export interface EmptyRecoveryDecision {
    /**
     * Whether recovery engaged for this turn. `false` means the mode
     * was `off`, the turn isn't a recoverable tool-loop-no-text case,
     * or the turn produced visible text.
     */
    triggered: boolean
    mode: EmptyRecoveryMode
    /**
     * Pre-localized fallback string the caller should inject. Only
     * populated when `triggered === true && mode === 'enforce'`. `null`
     * in `log_only` mode (caller logs but does NOT modify the stream
     * or row).
     */
    fallbackText: string | null
    /**
     * Suggested error code to persist on the turn row:
     *   - `null` — recovery did not engage.
     *   - `'tool_loop_no_text_logged'` — log_only mode signal.
     *   - `'tool_loop_no_text_recovered_fallback'` — enforce signal.
     */
    persistedErrorCode: string | null
}

export interface DecideEmptyRecoveryArgs {
    mode: EmptyRecoveryMode
    /**
     * Caller-detected signal: `true` when the model invoked a tool but
     * produced no visible text on the turn. Other empty-answer shapes
     * (token-limit cap, empty response) are handled by separate layers.
     */
    isToolLoopNoText: boolean
    /**
     * Locale + surface-appropriate fallback. The kernel intentionally
     * does NOT ship per-locale defaults — every host has its own
     * translation namespace, and shipping a copy here would create two
     * sources of truth.
     */
    fallbackText: string
}

export function decideEmptyRecovery(args: DecideEmptyRecoveryArgs): EmptyRecoveryDecision {
    if (args.mode === 'off') {
        return {
            triggered: false,
            mode: 'off',
            fallbackText: null,
            persistedErrorCode: null,
        }
    }
    if (!args.isToolLoopNoText) {
        return {
            triggered: false,
            mode: args.mode,
            fallbackText: null,
            persistedErrorCode: null,
        }
    }
    if (args.mode === 'log_only') {
        return {
            triggered: true,
            mode: 'log_only',
            fallbackText: null,
            persistedErrorCode: 'tool_loop_no_text_logged',
        }
    }
    // enforce
    return {
        triggered: true,
        mode: 'enforce',
        fallbackText: args.fallbackText,
        persistedErrorCode: 'tool_loop_no_text_recovered_fallback',
    }
}
