// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { MaestroMessage } from './message.js'
import type { MaestroEvent } from './protocol.js'
import type { Transport } from './transport.js'
import { useMaestroChat } from './hook.js'

type DataMap = Record<string, unknown>

/**
 * Mock transport with a controllable async iterator. The test pushes
 * events one at a time, so we can assert intermediate render state.
 */
function makeControlledTransport(): {
    transport: Transport<DataMap>
    push(event: MaestroEvent): Promise<void>
    finish(): void
    sentMessages(): ReadonlyArray<MaestroMessage<DataMap>>
} {
    let resolve: ((value: IteratorResult<MaestroEvent>) => void) | null = null
    const queue: MaestroEvent[] = []
    let done = false
    let captured: ReadonlyArray<MaestroMessage<DataMap>> = []

    const flush = () => {
        if (!resolve) return
        if (queue.length > 0) {
            const value = queue.shift()!
            const r = resolve
            resolve = null
            r({ value, done: false })
        } else if (done) {
            const r = resolve
            resolve = null
            r({ value: undefined as unknown as MaestroEvent, done: true })
        }
    }

    const transport: Transport<DataMap> = {
        send({ messages }) {
            captured = messages
            return {
                [Symbol.asyncIterator]() {
                    return {
                        next() {
                            return new Promise<IteratorResult<MaestroEvent>>(r => {
                                resolve = r
                                flush()
                            })
                        },
                    }
                },
            }
        },
    }

    return {
        transport,
        async push(event) {
            queue.push(event)
            flush()
            // Yield a microtask so the consumer can advance.
            await Promise.resolve()
        },
        finish() {
            done = true
            flush()
        },
        sentMessages: () => captured,
    }
}

describe('useMaestroChat — send happy path', () => {
    it('appends user + assistant messages and streams text into assistant', async () => {
        const ctl = makeControlledTransport()
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({ transport: ctl.transport }),
        )

        await act(async () => {
            void result.current.send('hello')
        })

        // Two messages: user + pending assistant
        expect(result.current.messages).toHaveLength(2)
        expect(result.current.messages[0]).toMatchObject({
            role: 'user',
            text: 'hello',
            status: 'complete',
        })
        expect(result.current.messages[1]).toMatchObject({
            role: 'assistant',
            status: 'pending',
        })
        expect(result.current.isLoading).toBe(true)

        await act(async () => {
            await ctl.push({ type: 'text-delta', delta: 'hi ' })
            await ctl.push({ type: 'text-delta', delta: 'there' })
        })

        await waitFor(() => {
            expect(result.current.messages[1]?.text).toBe('hi there')
            expect(result.current.messages[1]?.status).toBe('streaming')
        })

        await act(async () => {
            await ctl.push({ type: 'done' })
            ctl.finish()
        })

        await waitFor(() => {
            expect(result.current.messages[1]?.status).toBe('complete')
            expect(result.current.isLoading).toBe(false)
        })
    })

    it('passes the user message to the transport but NOT the pending assistant', async () => {
        const ctl = makeControlledTransport()
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({ transport: ctl.transport }),
        )
        await act(async () => {
            void result.current.send('hi')
            await Promise.resolve()
        })
        const sent = ctl.sentMessages()
        // The transport sees only the user turn.
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({ role: 'user', text: 'hi' })

        await act(async () => {
            await ctl.push({ type: 'done' })
            ctl.finish()
        })
        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })
    })

    it('fires onFinish with the completed assistant message', async () => {
        const ctl = makeControlledTransport()
        const onFinish = vi.fn()
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({
                transport: ctl.transport,
                onFinish,
            }),
        )

        await act(async () => {
            void result.current.send('hi')
        })
        await act(async () => {
            await ctl.push({ type: 'text-delta', delta: 'ok' })
            await ctl.push({ type: 'done' })
            ctl.finish()
        })

        await waitFor(() => {
            expect(onFinish).toHaveBeenCalledTimes(1)
        })
        const arg = onFinish.mock.calls[0]?.[0] as MaestroMessage<DataMap>
        expect(arg.status).toBe('complete')
        expect(arg.text).toBe('ok')
    })
})

describe('useMaestroChat — abort + reset', () => {
    it('abort() marks the trailing assistant as aborted and clears isLoading', async () => {
        const ctl = makeControlledTransport()
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({ transport: ctl.transport }),
        )
        await act(async () => {
            void result.current.send('hi')
        })
        await act(async () => {
            await ctl.push({ type: 'text-delta', delta: 'partial' })
        })
        await act(async () => {
            result.current.abort()
        })
        await waitFor(() => {
            expect(result.current.messages[1]?.status).toBe('aborted')
            expect(result.current.isLoading).toBe(false)
        })
    })

    it('reset() restores initialMessages and aborts any in-flight stream', async () => {
        const ctl = makeControlledTransport()
        const initial: MaestroMessage<DataMap>[] = [
            {
                id: 'seed',
                role: 'assistant',
                text: 'greetings',
                toolCalls: [],
                citations: [],
                data: [],
                status: 'complete',
                createdAt: 1,
                completedAt: 1,
            },
        ]
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({
                transport: ctl.transport,
                initialMessages: initial,
            }),
        )

        expect(result.current.messages).toEqual(initial)

        await act(async () => {
            void result.current.send('new turn')
        })
        expect(result.current.messages).toHaveLength(3)

        await act(async () => {
            result.current.reset()
        })
        expect(result.current.messages).toEqual(initial)
        expect(result.current.isLoading).toBe(false)
    })
})

describe('useMaestroChat — error surface', () => {
    it('a stream-level error event errors the assistant and fires onError', async () => {
        const ctl = makeControlledTransport()
        const onError = vi.fn()
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({
                transport: ctl.transport,
                onError,
            }),
        )

        await act(async () => {
            void result.current.send('hi')
        })
        await act(async () => {
            await ctl.push({ type: 'error', code: 'X', message: 'boom' })
            ctl.finish()
        })

        await waitFor(() => {
            expect(result.current.messages[1]?.status).toBe('errored')
            expect(result.current.error?.code).toBe('X')
            expect(onError).toHaveBeenCalled()
        })
    })

    it('append() adds a programmatic message without invoking the transport', async () => {
        const ctl = makeControlledTransport()
        const sendSpy = vi.spyOn(ctl.transport, 'send')
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({ transport: ctl.transport }),
        )

        await act(async () => {
            result.current.append({
                id: 'sys',
                role: 'assistant',
                text: 'system says hello',
                toolCalls: [],
                citations: [],
                data: [],
                status: 'complete',
                createdAt: 1,
                completedAt: 1,
            })
        })

        expect(result.current.messages).toHaveLength(1)
        expect(sendSpy).not.toHaveBeenCalled()
    })
})

describe('useMaestroChat — empty / whitespace send', () => {
    it('ignores empty input', async () => {
        const ctl = makeControlledTransport()
        const sendSpy = vi.spyOn(ctl.transport, 'send')
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({ transport: ctl.transport }),
        )

        await act(async () => {
            await result.current.send('   ')
        })

        expect(result.current.messages).toHaveLength(0)
        expect(sendSpy).not.toHaveBeenCalled()
    })
})
