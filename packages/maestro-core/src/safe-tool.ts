/**
 * Capture a tool-execute exception so observability tooling (Sentry,
 * OTel, Datadog, custom) sees a uniform alert without each adapter
 * inventing its own catch block.
 *
 * The kernel does NOT depend on a specific observability SDK. Hosts
 * wire one by passing an `onError` callback to the adapter builders;
 * the adapter calls this helper to format the tags and invoke the
 * callback.
 *
 * Important: the throw is intentionally NOT swallowed by the adapter
 * that calls this helper. AI SDK / MCP need the rejection to mark
 * the tool result as `error` so the model sees it and can recover.
 * Swallowing would surface as the assistant continuing as if the tool
 * had succeeded.
 */
export interface ToolExceptionTags {
    /** Tool that threw. */
    toolName: string
    /** Surface invoking the tool. */
    transport: string
    /** Who authorised the call. */
    actor: string
    /** Tenant scope. */
    tenantId: string
    /** Principal id if known, else null. */
    principalId?: string | null
    /** Trace id, if any. */
    requestId?: string | null
}

export type ToolExceptionHandler = (error: unknown, tags: ToolExceptionTags) => void

/**
 * Invoke the host's observability handler, if provided, with structured
 * tags. Errors thrown by the handler itself are swallowed — observability
 * must never break the chat turn.
 */
export function captureToolException(
    error: unknown,
    tags: ToolExceptionTags,
    onError?: ToolExceptionHandler
): void {
    if (!onError) return
    try {
        onError(error, tags)
    } catch {
        // Intentional swallow — see doc above.
    }
}
