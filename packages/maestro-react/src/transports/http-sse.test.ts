import { describe, expect, it, vi } from 'vitest'

import type { MaestroEvent } from '../protocol.js'
import { httpSSETransport } from './http-sse.js'
import { makeSseFetch, sseStream } from './test-utils.js'

async function collect(
    iter: AsyncIterable<MaestroEvent>,
): Promise<MaestroEvent[]> {
    const out: MaestroEvent[] = []
    for await (const e of iter) out.push(e)
    return out
}

describe('httpSSETransport', () => {
    it('parses one JSON-encoded MaestroEvent per data line', async () => {
        const events: MaestroEvent[] = [
            { type: 'text-delta', delta: 'hi' },
            { type: 'done' },
        ]
        const fetchImpl = makeSseFetch(
            events.map(e => ({ data: JSON.stringify(e) })),
        )
        const transport = httpSSETransport({
            url: 'https://api/x',
            fetch: fetchImpl,
        })
        const out = await collect(
            transport.send({
                messages: [],
                signal: new AbortController().signal,
            }),
        )
        expect(out).toEqual(events)
    })

    it('synthesises a `done` if the stream ends without one', async () => {
        const fetchImpl = makeSseFetch([
            { data: JSON.stringify({ type: 'text-delta', delta: 'a' }) },
        ])
        const transport = httpSSETransport({
            url: 'https://api/x',
            fetch: fetchImpl,
        })
        const out = await collect(
            transport.send({
                messages: [],
                signal: new AbortController().signal,
            }),
        )
        expect(out).toEqual([
            { type: 'text-delta', delta: 'a' },
            { type: 'done' },
        ])
    })

    it('emits a synthetic error event on non-2xx', async () => {
        const fetchImpl = makeSseFetch([], { status: 429, statusText: 'Too Many' })
        const transport = httpSSETransport({
            url: 'https://api/x',
            fetch: fetchImpl,
        })
        const out = await collect(
            transport.send({
                messages: [],
                signal: new AbortController().signal,
            }),
        )
        expect(out).toHaveLength(1)
        expect(out[0]).toMatchObject({
            type: 'error',
            code: 'HTTP_429',
        })
    })

    it('drops malformed frames via onParseError', async () => {
        const onParseError = vi.fn()
        const fetchImpl = makeSseFetch([
            { data: 'not-json' },
            { data: JSON.stringify({ type: 'done' }) },
        ])
        const transport = httpSSETransport({
            url: 'https://api/x',
            fetch: fetchImpl,
            onParseError,
        })
        const out = await collect(
            transport.send({
                messages: [],
                signal: new AbortController().signal,
            }),
        )
        expect(out).toEqual([{ type: 'done' }])
        expect(onParseError).toHaveBeenCalledTimes(1)
    })

    it('honours bodyBuilder + headers factory', async () => {
        const calls: { url: string; init: RequestInit }[] = []
        const fetchImpl = (async (url: string, init: RequestInit) => {
            calls.push({ url, init })
            return new Response(
                sseStream([
                    { data: JSON.stringify({ type: 'done' }) },
                ]),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            )
        }) as unknown as typeof fetch

        const transport = httpSSETransport({
            url: 'https://api/x',
            fetch: fetchImpl,
            headers: () => ({ authorization: 'Bearer t' }),
            bodyBuilder: msgs => ({ custom: { count: msgs.length } }),
        })

        await collect(
            transport.send({
                messages: [],
                signal: new AbortController().signal,
            }),
        )

        expect(calls).toHaveLength(1)
        const sentHeaders = calls[0]!.init.headers as Record<string, string>
        expect(sentHeaders.authorization).toBe('Bearer t')
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
            custom: { count: 0 },
        })
    })

    it('forwards send-time metadata to bodyBuilder as the second argument', async () => {
        const seen: Array<{
            messages: unknown
            metadata: unknown
        }> = []
        const fetchImpl = (async (_url: string, _init: RequestInit) => {
            return new Response(
                sseStream([
                    { data: JSON.stringify({ type: 'done' }) },
                ]),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            )
        }) as unknown as typeof fetch

        const transport = httpSSETransport({
            url: 'https://api/x',
            fetch: fetchImpl,
            bodyBuilder: (messages, metadata) => {
                seen.push({ messages, metadata })
                return { messages, metadata }
            },
        })

        const out: MaestroEvent[] = []
        for await (const e of transport.send({
            messages: [],
            signal: new AbortController().signal,
            metadata: { requestId: 'abc', surface: 'admin' },
        })) {
            out.push(e)
        }

        expect(seen).toHaveLength(1)
        expect(seen[0]!.metadata).toEqual({
            requestId: 'abc',
            surface: 'admin',
        })
    })

    it('default body folds metadata in when no bodyBuilder is provided', async () => {
        const calls: { url: string; init: RequestInit }[] = []
        const fetchImpl = (async (url: string, init: RequestInit) => {
            calls.push({ url, init })
            return new Response(
                sseStream([
                    { data: JSON.stringify({ type: 'done' }) },
                ]),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            )
        }) as unknown as typeof fetch

        const transport = httpSSETransport({
            url: 'https://api/x',
            fetch: fetchImpl,
        })
        for await (const _ of transport.send({
            messages: [],
            signal: new AbortController().signal,
            metadata: { tag: 'regen' },
        })) {
            // drain
        }
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
            messages: [],
            metadata: { tag: 'regen' },
        })
    })

    it('default body omits metadata when none is supplied', async () => {
        const calls: { url: string; init: RequestInit }[] = []
        const fetchImpl = (async (url: string, init: RequestInit) => {
            calls.push({ url, init })
            return new Response(
                sseStream([
                    { data: JSON.stringify({ type: 'done' }) },
                ]),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            )
        }) as unknown as typeof fetch

        const transport = httpSSETransport({
            url: 'https://api/x',
            fetch: fetchImpl,
        })
        for await (const _ of transport.send({
            messages: [],
            signal: new AbortController().signal,
        })) {
            // drain
        }
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
            messages: [],
        })
    })

    it('stops yielding after a `done` event (no post-terminal leaks)', async () => {
        const fetchImpl = makeSseFetch([
            { data: JSON.stringify({ type: 'text-delta', delta: 'a' }) },
            { data: JSON.stringify({ type: 'done' }) },
            { data: JSON.stringify({ type: 'text-delta', delta: 'late' }) },
        ])
        const transport = httpSSETransport({
            url: 'https://api/x',
            fetch: fetchImpl,
        })
        const out = await collect(
            transport.send({
                messages: [],
                signal: new AbortController().signal,
            }),
        )
        expect(out).toEqual([
            { type: 'text-delta', delta: 'a' },
            { type: 'done' },
        ])
    })
})
