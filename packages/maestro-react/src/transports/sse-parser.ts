/**
 * Minimal SSE frame parser shared by HTTP-SSE-based transports.
 * Deliberately tiny: handles `event:` + `data:` + blank-line frame
 * boundaries, ignores `id:`/`retry:`/comments. Multi-line `data:`
 * within a single frame is concatenated with `\n` per the WHATWG
 * EventSource spec.
 *
 * Implementing this inline keeps the package zero-runtime-dependency
 * (the protocol package's promise) and avoids the EventSource API,
 * which lacks abort + custom-header support in the browser.
 */

export interface SseFrame {
    /** SSE `event:` field. Defaults to `'message'` when absent. */
    readonly event: string
    /** Joined `data:` payload. May be empty. */
    readonly data: string
}

/**
 * Stream a ReadableStream of UTF-8 bytes as parsed SSE frames.
 * Yields each complete frame as it becomes available; the underlying
 * reader is released when the iterator is exhausted or aborted.
 */
export async function* parseSseStream(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    const abortPromise = signal
        ? new Promise<never>((_, reject) => {
              if (signal.aborted) {
                  reject(new DOMException('Aborted', 'AbortError'))
                  return
              }
              signal.addEventListener(
                  'abort',
                  () =>
                      reject(new DOMException('Aborted', 'AbortError')),
                  { once: true },
              )
          })
        : null

    try {
        while (true) {
            const readPromise = reader.read()
            const result = abortPromise
                ? await Promise.race([readPromise, abortPromise])
                : await readPromise

            if (result.done) {
                // Flush any partial trailing frame.
                if (buffer.trim().length > 0) {
                    const frame = parseFrame(buffer)
                    if (frame !== null) yield frame
                }
                return
            }

            buffer += decoder.decode(result.value, { stream: true })

            // Frames are separated by a blank line. Per WHATWG either
            // CRLFCRLF, LFLF, or CRCR delimit; normalise on \n\n.
            const normalised = buffer.replace(/\r\n?/g, '\n')
            const parts = normalised.split('\n\n')
            buffer = parts.pop() ?? ''
            for (const part of parts) {
                if (part.length === 0) continue
                const frame = parseFrame(part)
                if (frame !== null) yield frame
            }
        }
    } finally {
        try {
            reader.releaseLock()
        } catch {
            // Reader already released — ignore.
        }
    }
}

/**
 * Parse a single SSE frame (the text between two blank lines).
 * Returns `null` when the frame contains no `data:` field — comments,
 * pure `retry:` frames, or malformed payloads.
 */
export function parseFrame(text: string): SseFrame | null {
    let event = 'message'
    const dataLines: string[] = []
    for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/\r$/, '')
        if (line.length === 0) continue
        // Comments start with ':' per the SSE spec.
        if (line.startsWith(':')) continue
        const colonIdx = line.indexOf(':')
        const field = colonIdx === -1 ? line : line.slice(0, colonIdx)
        const valueRaw = colonIdx === -1 ? '' : line.slice(colonIdx + 1)
        const value = valueRaw.startsWith(' ') ? valueRaw.slice(1) : valueRaw
        if (field === 'event') {
            event = value
        } else if (field === 'data') {
            dataLines.push(value)
        }
        // Ignore id / retry / unknown fields.
    }
    if (dataLines.length === 0) return null
    return { event, data: dataLines.join('\n') }
}
