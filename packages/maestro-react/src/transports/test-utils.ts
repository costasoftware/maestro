/**
 * Test-only helpers for building mock fetch responses with SSE bodies.
 * Lives in the transports/ folder beside the implementations; excluded
 * from the build by `tsconfig.build.json` (test pattern).
 */

export interface SsePayload {
    readonly event?: string
    readonly data: string
}

/** Encode a list of payloads as a single SSE byte stream. */
export function encodeSseStream(
    payloads: ReadonlyArray<SsePayload>,
): Uint8Array {
    const lines: string[] = []
    for (const p of payloads) {
        if (p.event && p.event !== 'message') {
            lines.push(`event: ${p.event}`)
        }
        // Per spec, multi-line data should be sent as multiple `data:`
        // lines; tests use single-line JSON so a simple join suffices.
        lines.push(`data: ${p.data}`)
        lines.push('') // blank line terminates the frame
    }
    lines.push('') // trailing newline to ensure last frame flushes
    return new TextEncoder().encode(lines.join('\n'))
}

/** Build a ReadableStream that yields the encoded SSE in one chunk. */
export function sseStream(
    payloads: ReadonlyArray<SsePayload>,
): ReadableStream<Uint8Array> {
    const bytes = encodeSseStream(payloads)
    return new ReadableStream({
        start(controller) {
            controller.enqueue(bytes)
            controller.close()
        },
    })
}

/** Build a ReadableStream that yields the encoded SSE one frame at a time. */
export function chunkedSseStream(
    payloads: ReadonlyArray<SsePayload>,
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let i = 0
    return new ReadableStream({
        pull(controller) {
            if (i >= payloads.length) {
                controller.close()
                return
            }
            const payload = payloads[i]!
            i += 1
            const parts: string[] = []
            if (payload.event && payload.event !== 'message') {
                parts.push(`event: ${payload.event}`)
            }
            parts.push(`data: ${payload.data}`)
            parts.push('')
            parts.push('')
            controller.enqueue(encoder.encode(parts.join('\n')))
        },
    })
}

/** Build a mock fetch that responds with the supplied SSE payloads. */
export function makeSseFetch(
    payloads: ReadonlyArray<SsePayload>,
    init: { status?: number; statusText?: string } = {},
): typeof fetch {
    return (async () => {
        return new Response(sseStream(payloads), {
            status: init.status ?? 200,
            statusText: init.statusText ?? 'OK',
            headers: { 'content-type': 'text/event-stream' },
        })
    }) as unknown as typeof fetch
}
