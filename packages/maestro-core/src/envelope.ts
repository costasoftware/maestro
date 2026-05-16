/**
 * Uniform return shape for every Maestro tool. Wrapping success and failure
 * in the same envelope lets the model recover gracefully ("sorry, that slot
 * was just taken") instead of crashing the whole turn, and lets every adapter
 * (AI SDK, MCP, transports added later) render the result with the same code
 * path.
 */
export interface ToolMeta {
    /**
     * Set when the host UI already renders a rich card for this tool result.
     * Chat transports with a UI surface read this and tell the model to skip
     * restating the data — preventing the duplicate "card + paragraph saying
     * the same thing" bubble. Advisory only on transports without UI cards
     * (whatsapp, mcp, voice) — those still get the full LLM restatement.
     */
    uiRendered?: string
}

export type ToolEnvelope<T> =
    | { ok: true; data: T; meta?: ToolMeta }
    | { ok: false; error: { code: string; message: string } }

export const ok = <T>(data: T, meta?: ToolMeta): ToolEnvelope<T> =>
    meta ? { ok: true, data, meta } : { ok: true, data }

export const err = (code: string, message: string): ToolEnvelope<never> => ({
    ok: false,
    error: { code, message },
})

export function isOk<T>(
    envelope: ToolEnvelope<T>
): envelope is { ok: true; data: T; meta?: ToolMeta } {
    return envelope.ok === true
}
