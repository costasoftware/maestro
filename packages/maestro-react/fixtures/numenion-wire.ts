/**
 * Sample SSE event sequence from numenion's actual wire format.
 *
 * Source of truth: `packages/agent/src/agent.ts` in numenion-app emits
 * an `AgentEvent` union of:
 *
 *   { type: "text_delta", delta: string }
 *   { type: "tool_use", name: string, input: unknown }
 *   { type: "tool_result", name: string, result: unknown, error?: boolean }
 *   { type: "done", text: string }
 *   { type: "error", message: string }
 *
 * Notable shape gaps vs protocol:
 *
 *   - `tool_use` carries NO callId — the mapper must synthesise one
 *     via `ctx.nextCallId()`. The next `tool_result` for that tool name
 *     is matched against `ctx.lastCallId()`.
 *
 *   - `tool_result.name` instead of `callId` means concurrent tool
 *     calls of the same name are ambiguous. Numenion runs tools
 *     sequentially today, so single-call-in-flight matching is sound.
 *
 *   - `error` is stream-level — numenion has no per-tool error wire,
 *     it sets `tool_result.error: true` instead.
 */

/** One SSE frame as wire bytes would arrive: event name + JSON data. */
export interface NumenionWireFrame {
    readonly event: string
    readonly data: string
}

export const NUMENION_HAPPY_PATH: ReadonlyArray<NumenionWireFrame> = [
    {
        event: 'text_delta',
        data: JSON.stringify({ delta: 'Looking up ' }),
    },
    {
        event: 'text_delta',
        data: JSON.stringify({ delta: 'your portfolio…' }),
    },
    {
        event: 'tool_use',
        data: JSON.stringify({
            name: 'getPortfolio',
            input: { wallet: '0x7099…79C8' },
        }),
    },
    {
        event: 'tool_result',
        data: JSON.stringify({
            name: 'getPortfolio',
            result: { netWorth: 12345, positions: 3 },
        }),
    },
    {
        event: 'text_delta',
        data: JSON.stringify({ delta: '\n\nYour net worth is **$12,345**.' }),
    },
    {
        event: 'done',
        data: JSON.stringify({
            text: 'Looking up your portfolio…\n\nYour net worth is **$12,345**.',
        }),
    },
]

export const NUMENION_TOOL_ERROR_PATH: ReadonlyArray<NumenionWireFrame> = [
    {
        event: 'tool_use',
        data: JSON.stringify({
            name: 'proposeAction',
            input: { kind: 'swap' },
        }),
    },
    {
        event: 'tool_result',
        data: JSON.stringify({
            name: 'proposeAction',
            error: true,
            result: { message: 'simulation reverted' },
        }),
    },
    {
        event: 'error',
        data: JSON.stringify({ message: 'simulation reverted' }),
    },
]

/**
 * Reference event map for numenion. Production consumers can copy/paste
 * this verbatim. The mapper for `tool_result` peeks `ctx.lastCallId()`
 * so the result attaches to the synthetic call from the most recent
 * `tool_use` — correct under numenion's sequential tool-call assumption.
 */
import type { LegacyEventMap } from '../src/transports/legacy-sse.js'

export const numenionEventMap: LegacyEventMap<Record<string, unknown>> = {
    text_delta: data => {
        if (
            typeof data !== 'object' ||
            data === null ||
            typeof (data as { delta: unknown }).delta !== 'string'
        ) {
            return null
        }
        return {
            type: 'text-delta',
            delta: (data as { delta: string }).delta,
        }
    },
    tool_use: (data, ctx) => {
        if (
            typeof data !== 'object' ||
            data === null ||
            typeof (data as { name: unknown }).name !== 'string'
        ) {
            return null
        }
        const payload = data as { name: string; input?: unknown }
        return {
            type: 'tool-call',
            callId: ctx.nextCallId(),
            name: payload.name,
            input: payload.input,
        }
    },
    tool_result: (data, ctx) => {
        if (typeof data !== 'object' || data === null) return null
        const payload = data as {
            name?: string
            result?: unknown
            error?: boolean
        }
        const callId = ctx.lastCallId() ?? ctx.nextCallId()
        if (payload.error) {
            return {
                type: 'tool-result',
                callId,
                error: {
                    code: 'TOOL_ERROR',
                    message:
                        typeof (payload.result as { message?: unknown })
                            ?.message === 'string'
                            ? (payload.result as { message: string }).message
                            : 'tool failed',
                },
            }
        }
        return {
            type: 'tool-result',
            callId,
            result: payload.result,
        }
    },
    error: data => {
        const message =
            typeof data === 'object' &&
            data !== null &&
            typeof (data as { message: unknown }).message === 'string'
                ? (data as { message: string }).message
                : 'stream error'
        return { type: 'error', message }
    },
    done: data => {
        const text =
            typeof data === 'object' &&
            data !== null &&
            typeof (data as { text: unknown }).text === 'string'
                ? (data as { text: string }).text
                : undefined
        return { type: 'done', text }
    },
}
