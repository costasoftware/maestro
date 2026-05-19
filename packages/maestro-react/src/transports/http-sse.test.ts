import { describe, expect, it, vi } from 'vitest'

import type { MaestroEvent } from '../protocol.js'
import type { BodyBuilderArgs } from '../transport.js'
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

    it('honours bodyBuilder (object-arg) + headers factory', async () => {
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
            bodyBuilder: ({ messages }: BodyBuilderArgs) => ({
                custom: { count: messages.length },
            }),
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

    it('forwards send-time attachments to bodyBuilder as the third argument', async () => {
        const seen: Array<{
            messages: unknown
            metadata: unknown
            attachments: unknown
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
            bodyBuilder: (messages, metadata, attachments) => {
                seen.push({ messages, metadata, attachments })
                return { messages, metadata, attachments }
            },
        })

        for await (const _ of transport.send({
            messages: [],
            signal: new AbortController().signal,
            attachments: [
                { kind: 'image', url: 'https://cdn/a.png' },
            ],
        })) {
            // drain
        }

        expect(seen).toHaveLength(1)
        expect(seen[0]!.attachments).toEqual([
            { kind: 'image', url: 'https://cdn/a.png' },
        ])
    })

    it('default body folds attachments in when no bodyBuilder is provided', async () => {
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
            attachments: [
                {
                    kind: 'image',
                    url: 'https://cdn/a.png',
                    mime: 'image/png',
                    name: 'a.png',
                    size: 1024,
                },
            ],
        })) {
            // drain
        }
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
            messages: [],
            attachments: [
                {
                    kind: 'image',
                    url: 'https://cdn/a.png',
                    mime: 'image/png',
                    name: 'a.png',
                    size: 1024,
                },
            ],
        })
    })

    it('default body folds both metadata + attachments when both supplied', async () => {
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
            metadata: { surface: 'admin' },
            attachments: [{ kind: 'file', url: 'https://cdn/x.pdf' }],
        })) {
            // drain
        }
        expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
            messages: [],
            metadata: { surface: 'admin' },
            attachments: [{ kind: 'file', url: 'https://cdn/x.pdf' }],
        })
    })

    it('default body omits attachments when none is supplied', async () => {
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
        const body = JSON.parse(calls[0]!.init.body as string)
        expect(body).toEqual({ messages: [] })
        expect(body.attachments).toBeUndefined()
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

describe('httpSSETransport — v0.5 bodyBuilder unification', () => {
    function silentSseFetch(): typeof fetch {
        return (async () =>
            new Response(
                sseStream([{ data: JSON.stringify({ type: 'done' }) }]),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                },
            )) as unknown as typeof fetch
    }

    it('object-arg bodyBuilder receives messages, metadata, attachments on args', async () => {
        const seen: Array<{
            messages: unknown
            metadata: unknown
            attachments: unknown
        }> = []
        const transport = httpSSETransport({
            url: 'https://api/x',
            fetch: silentSseFetch(),
            bodyBuilder: (args: BodyBuilderArgs) => {
                seen.push({
                    messages: args.messages,
                    metadata: args.metadata,
                    attachments: args.attachments,
                })
                return { messages: args.messages }
            },
        })
        for await (const _ of transport.send({
            messages: [],
            signal: new AbortController().signal,
            metadata: { requestId: 'r1' },
            attachments: [{ kind: 'image', url: 'https://cdn/a.png' }],
        })) {
            // drain
        }
        expect(seen).toEqual([
            {
                messages: [],
                metadata: { requestId: 'r1' },
                attachments: [{ kind: 'image', url: 'https://cdn/a.png' }],
            },
        ])
    })

    it('positional bodyBuilder still works (back-compat with 0.4.x)', async () => {
        const seen: Array<{
            messages: unknown
            metadata: unknown
            attachments: unknown
        }> = []
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const transport = httpSSETransport({
                url: 'https://api/x',
                fetch: silentSseFetch(),
                bodyBuilder: (messages, metadata, attachments) => {
                    seen.push({ messages, metadata, attachments })
                    return { messages, metadata, attachments }
                },
            })
            for await (const _ of transport.send({
                messages: [],
                signal: new AbortController().signal,
                metadata: { requestId: 'r2' },
                attachments: [{ kind: 'file', url: 'https://cdn/x.pdf' }],
            })) {
                // drain
            }
        } finally {
            warnSpy.mockRestore()
        }
        expect(seen).toEqual([
            {
                messages: [],
                metadata: { requestId: 'r2' },
                attachments: [{ kind: 'file', url: 'https://cdn/x.pdf' }],
            },
        ])
    })

    it('positional bodyBuilder emits the deprecation warn exactly once per builder', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            // Fresh closure → not yet in the module-level WeakSet.
            const positional = (
                messages: unknown,
                metadata?: unknown,
                attachments?: unknown,
            ) => ({ messages, metadata, attachments })

            const transport = httpSSETransport({
                url: 'https://api/x',
                fetch: silentSseFetch(),
                bodyBuilder: positional,
            })

            for (let i = 0; i < 3; i += 1) {
                for await (const _ of transport.send({
                    messages: [],
                    signal: new AbortController().signal,
                })) {
                    // drain
                }
            }

            const deprecationCalls = warnSpy.mock.calls.filter(
                args =>
                    typeof args[0] === 'string' &&
                    args[0].includes('positional args are deprecated'),
            )
            expect(deprecationCalls).toHaveLength(1)
        } finally {
            warnSpy.mockRestore()
        }
    })

    it('object-arg bodyBuilder never emits the deprecation warn', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const transport = httpSSETransport({
                url: 'https://api/x',
                fetch: silentSseFetch(),
                bodyBuilder: (args: BodyBuilderArgs) => ({
                    messages: args.messages,
                }),
            })
            for await (const _ of transport.send({
                messages: [],
                signal: new AbortController().signal,
            })) {
                // drain
            }
            const deprecationCalls = warnSpy.mock.calls.filter(
                a =>
                    typeof a[0] === 'string' &&
                    a[0].includes('positional args are deprecated'),
            )
            expect(deprecationCalls).toHaveLength(0)
        } finally {
            warnSpy.mockRestore()
        }
    })
})
