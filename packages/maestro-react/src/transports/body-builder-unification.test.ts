/**
 * Cross-transport assertion: all three transports' `bodyBuilder`
 * accept the same `BodyBuilderArgs` shape (the v0.5 unification).
 *
 * The test reaches via a single object literal usable as the
 * `bodyBuilder` for all three options shapes — if any transport's
 * `bodyBuilder` parameter ever diverges (extra required field, renamed
 * key) this file stops compiling. The runtime body of the test also
 * exercises each transport once so we catch a regression in the
 * delivered args, not just the declared types.
 */

import { describe, expect, it } from 'vitest'

import type { MaestroEvent } from '../protocol.js'
import type { BodyBuilderArgs } from '../transport.js'
import { aiSdkTransport, type AiSdkTransportOptions } from './ai-sdk.js'
import { httpSSETransport, type HttpSSETransportOptions } from './http-sse.js'
import {
    legacySseTransport,
    type LegacySseTransportOptions,
} from './legacy-sse.js'
import { sseStream } from './test-utils.js'

function silentSseFetch(frames: Array<{ data?: string; event?: string }>): typeof fetch {
    return (async () =>
        new Response(
            sseStream(
                frames.map(f => ({
                    data: f.data ?? '{}',
                    ...(f.event ? { event: f.event } : {}),
                })),
            ),
            {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
            },
        )) as unknown as typeof fetch
}

describe('bodyBuilder unification across transports', () => {
    it('a single object-arg builder type-checks against all three transport options', () => {
        // If `bodyBuilder` ever diverges across transports, one of these
        // assignments stops compiling.
        const unified = (args: BodyBuilderArgs) => ({
            messages: args.messages,
            metadata: args.metadata,
            attachments: args.attachments,
        })

        const httpOpts: HttpSSETransportOptions<Record<string, unknown>> = {
            url: '/x',
            bodyBuilder: unified,
        }
        const aiOpts: AiSdkTransportOptions = {
            url: '/x',
            bodyBuilder: unified,
        }
        const legacyOpts: LegacySseTransportOptions<Record<string, unknown>> = {
            url: '/x',
            eventMap: { done: () => ({ type: 'done' }) },
            bodyBuilder: unified,
        }

        // Touch the options so the compiler can't tree-shake them away.
        expect(typeof httpOpts.bodyBuilder).toBe('function')
        expect(typeof aiOpts.bodyBuilder).toBe('function')
        expect(typeof legacyOpts.bodyBuilder).toBe('function')
    })

    it('every transport delivers the same args shape at runtime', async () => {
        let delivered: BodyBuilderArgs | undefined
        const unified = (args: BodyBuilderArgs) => {
            delivered = {
                messages: args.messages,
                metadata: args.metadata,
                attachments: args.attachments,
            }
            return { messages: args.messages }
        }

        const expected: BodyBuilderArgs = {
            messages: [],
            metadata: { traceId: 't1' },
            attachments: [{ kind: 'image', url: 'https://cdn/a.png' }],
        }

        async function drain(
            stream: AsyncIterable<MaestroEvent>,
        ): Promise<void> {
            for await (const _ of stream) {
                // drain
            }
        }

        const sendArgs = {
            messages: [] as ReadonlyArray<never>,
            signal: new AbortController().signal,
            metadata: { traceId: 't1' },
            attachments: [
                { kind: 'image' as const, url: 'https://cdn/a.png' },
            ],
        }

        delivered = undefined
        await drain(
            httpSSETransport({
                url: '/x',
                fetch: silentSseFetch([
                    { data: JSON.stringify({ type: 'done' }) },
                ]),
                bodyBuilder: unified,
            }).send(sendArgs),
        )
        expect(delivered).toEqual(expected)

        delivered = undefined
        await drain(
            aiSdkTransport({
                url: '/x',
                fetch: silentSseFetch([
                    { data: JSON.stringify({ type: 'finish' }) },
                ]),
                bodyBuilder: unified,
            }).send(sendArgs),
        )
        expect(delivered).toEqual(expected)

        delivered = undefined
        await drain(
            legacySseTransport({
                url: '/x',
                fetch: silentSseFetch([{ event: 'done', data: '{}' }]),
                eventMap: { done: () => ({ type: 'done' }) },
                bodyBuilder: unified,
            }).send(sendArgs),
        )
        expect(delivered).toEqual(expected)
    })
})
