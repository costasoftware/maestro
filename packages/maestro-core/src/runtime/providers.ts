import { APICallError, RetryError } from 'ai'

/**
 * Provider-fallback helpers. Used by hosts that want OpenAI as a
 * resilience fallback when the primary Anthropic call hits a transient
 * failure mode.
 *
 * 0.2.0 ships the helpers but does NOT wrap `runChatTurn` with the
 * retry loop — mid-stream provider switching is invasive enough to
 * deserve its own design pass. Hosts compose retry themselves using
 * these primitives:
 *
 *   try {
 *     return await runChatTurn({ ..., models: anthropicModels })
 *   } catch (e) {
 *     if (shouldFallback(e)) {
 *       return runChatTurn({
 *         ...,
 *         models: {
 *           fast: mapModelIdToOpenAI(anthropicModels.fast),
 *           smart: mapModelIdToOpenAI(anthropicModels.smart),
 *         },
 *       })
 *     }
 *     throw e
 *   }
 *
 * Built-in retry wrapper tracked for 0.2.1.
 */

/**
 * Returns true when the error suggests a transient provider failure
 * worth retrying against a different provider (rate limit, 5xx,
 * network error, timeout). Returns false for caller-side errors
 * (auth, content policy, abort, intentional quota deny) so a real
 * problem doesn't get masked by a successful fallback.
 *
 * Unwraps a single layer of `RetryError` (the AI SDK wraps the
 * underlying APICallError after exhausting its internal retries) so
 * the status-code logic applies to the root cause.
 */
export function shouldFallback(err: unknown): boolean {
    if (!(err instanceof Error)) return false

    // Intentional denies — never fallback.
    if (err.name === 'AiQuotaDeniedError') return false

    // User cancelled — never fallback; the stream would arrive after abort.
    if (err.name === 'AbortError') return false

    // Unwrap one layer of RetryError from the AI SDK.
    if (RetryError.isInstance(err)) {
        if (err.reason === 'abort') return false
        const underlying = err.lastError
        if (underlying instanceof Error) {
            return shouldFallback(underlying)
        }
        return false
    }

    const message = err.message.toLowerCase()

    // Content policy violation — real signal; OpenAI also refuses this content.
    if (message.includes('content_policy') || message.includes('content policy')) {
        return false
    }

    // Network layer failures — transient infrastructure issues.
    if (
        message.includes('econnrefused') ||
        message.includes('enotfound') ||
        message.includes('etimedout') ||
        message.includes('fetch failed') ||
        err.name === 'NetworkError' ||
        err.name === 'FetchError'
    ) {
        return true
    }

    // Explicit timeout — likely provider degradation.
    if (err.name === 'TimeoutError' || message.includes('timeout')) {
        return true
    }

    // Rate-limit phrase — providers sometimes format 429s as text-only
    // messages without a clean status code in the string. Match by
    // phrase before falling through to numeric extraction.
    if (message.includes('rate limit') || message.includes('rate_limit')) {
        return true
    }

    const status = APICallError.isInstance(err)
        ? (err.statusCode ?? 0)
        : extractStatusCodeFromMessage(err)

    if (status === 429) return true // rate limit
    if (status >= 500 && status < 600) return true // server error
    if (status === 400 || status === 401 || status === 403) return false // caller-side / auth

    return false // conservative default
}

/**
 * Map an Anthropic model id to its OpenAI equivalent for the fallback
 * path. Capability + cost parity:
 *   - Haiku  → gpt-4o-mini  (fast, cheap)
 *   - Sonnet → gpt-4o       (capable, mid-range)
 *   - Opus   → gpt-4o       (closest available equivalent)
 *   - Unknown → gpt-4o-mini (conservative default — cheaper)
 *
 * Anthropic model ids may include date suffixes
 * (e.g. `claude-haiku-4-5-20251001`); the substring match handles all
 * variants.
 */
export function mapModelIdToOpenAI(anthropicModelId: string | null | undefined): string {
    if (!anthropicModelId) return 'gpt-4o-mini'
    const id = anthropicModelId.toLowerCase()
    if (id.includes('sonnet') || id.includes('opus')) return 'gpt-4o'
    return 'gpt-4o-mini'
}

/**
 * Last-resort status-code parser. Matches patterns like "503 Service
 * Unavailable" in error messages when the error is not an
 * `APICallError` instance. Returns 0 when no valid HTTP code is found.
 */
function extractStatusCodeFromMessage(err: Error): number {
    const match = err.message.match(/\b([45]\d{2})\b/)
    const code = match?.[1]
    return code ? parseInt(code, 10) : 0
}
