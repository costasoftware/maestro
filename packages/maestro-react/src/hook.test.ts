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
    reset(): void
    sentMessages(): ReadonlyArray<MaestroMessage<DataMap>>
    sentMetadata(): unknown
    sendCount(): number
    lastSignal(): AbortSignal | null
} {
    let resolve: ((value: IteratorResult<MaestroEvent>) => void) | null = null
    let queue: MaestroEvent[] = []
    let done = false
    let captured: ReadonlyArray<MaestroMessage<DataMap>> = []
    let capturedMetadata: unknown = undefined
    let sendCalls = 0
    let lastSignal: AbortSignal | null = null

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
        send({ messages, signal, metadata }) {
            sendCalls += 1
            captured = messages
            capturedMetadata = metadata
            lastSignal = signal
            // Each `send` resets the iterator queue + done flag so the
            // hook's second invocation (e.g. via `regenerate`) doesn't
            // inherit the prior stream's terminal state.
            queue = []
            done = false
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
        reset() {
            queue = []
            done = false
            resolve = null
        },
        sentMessages: () => captured,
        sentMetadata: () => capturedMetadata,
        sendCount: () => sendCalls,
        lastSignal: () => lastSignal,
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

describe('useMaestroChat — send metadata forwarding', () => {
    it('threads opts.metadata through to transport.send', async () => {
        const ctl = makeControlledTransport()
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({ transport: ctl.transport }),
        )

        await act(async () => {
            void result.current.send('hi', {
                metadata: { surface: 'admin', requestId: 'r-1' },
            })
            await Promise.resolve()
        })

        expect(ctl.sentMetadata()).toEqual({
            surface: 'admin',
            requestId: 'r-1',
        })

        await act(async () => {
            await ctl.push({ type: 'done' })
            ctl.finish()
        })
    })

    it('passes undefined metadata when none is supplied', async () => {
        const ctl = makeControlledTransport()
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({ transport: ctl.transport }),
        )

        await act(async () => {
            void result.current.send('hi')
            await Promise.resolve()
        })

        expect(ctl.sentMetadata()).toBeUndefined()

        await act(async () => {
            await ctl.push({ type: 'done' })
            ctl.finish()
        })
    })
})

describe('useMaestroChat — setMessages rehydration', () => {
    it('replaces the message list wholesale', async () => {
        const ctl = makeControlledTransport()
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({ transport: ctl.transport }),
        )

        const rehydrated: MaestroMessage<DataMap>[] = [
            {
                id: 'u1',
                role: 'user',
                text: 'hi',
                toolCalls: [],
                citations: [],
                data: [],
                status: 'complete',
                createdAt: 1,
                completedAt: 1,
            },
            {
                id: 'a1',
                role: 'assistant',
                text: 'hello!',
                toolCalls: [],
                citations: [],
                data: [],
                status: 'complete',
                createdAt: 2,
                completedAt: 2,
            },
        ]

        await act(async () => {
            result.current.setMessages(rehydrated)
        })

        expect(result.current.messages).toEqual(rehydrated)
    })

    it('does NOT abort an in-flight stream when called', async () => {
        const ctl = makeControlledTransport()
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({ transport: ctl.transport }),
        )

        await act(async () => {
            void result.current.send('hi')
            await Promise.resolve()
        })
        const signal = ctl.lastSignal()
        expect(signal?.aborted).toBe(false)

        await act(async () => {
            // Rehydrate while a stream is in flight. The stream's
            // abort signal MUST remain un-aborted — this is the whole
            // point of `setMessages` over `reset()` + `append()`.
            result.current.setMessages([])
        })
        expect(signal?.aborted).toBe(false)
        expect(result.current.messages).toHaveLength(0)

        // Let the in-flight stream complete cleanly so the test exits.
        await act(async () => {
            await ctl.push({ type: 'done' })
            ctl.finish()
        })
    })

    it('does NOT touch error or isLoading state', async () => {
        const ctl = makeControlledTransport()
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({ transport: ctl.transport }),
        )

        // Trigger an error first.
        await act(async () => {
            void result.current.send('hi')
        })
        await act(async () => {
            await ctl.push({ type: 'error', code: 'X', message: 'boom' })
            ctl.finish()
        })
        await waitFor(() => {
            expect(result.current.error?.code).toBe('X')
        })

        await act(async () => {
            result.current.setMessages([])
        })

        // Error is preserved — `setMessages` is rehydration, not reset.
        expect(result.current.error?.code).toBe('X')
        expect(result.current.isLoading).toBe(false)
    })
})

describe('useMaestroChat — regenerate', () => {
    it('trims everything after the last user message and re-runs', async () => {
        const ctl = makeControlledTransport()
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({ transport: ctl.transport }),
        )

        // First turn — completes.
        await act(async () => {
            void result.current.send('hello')
        })
        await act(async () => {
            await ctl.push({ type: 'text-delta', delta: 'hi' })
            await ctl.push({ type: 'done' })
            ctl.finish()
        })
        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })
        expect(result.current.messages).toHaveLength(2)
        const sendsBefore = ctl.sendCount()

        // Regenerate — should drop the assistant turn, keep the user.
        await act(async () => {
            void result.current.regenerate()
            await Promise.resolve()
        })

        // Transport sees the user-only history.
        const sentForRegen = ctl.sentMessages()
        expect(sentForRegen).toHaveLength(1)
        expect(sentForRegen[0]).toMatchObject({ role: 'user', text: 'hello' })
        // Two messages again: same user + fresh pending assistant.
        expect(result.current.messages).toHaveLength(2)
        expect(result.current.messages[0]).toMatchObject({
            role: 'user',
            text: 'hello',
        })
        expect(result.current.messages[1]).toMatchObject({
            role: 'assistant',
            status: 'pending',
        })
        expect(ctl.sendCount()).toBe(sendsBefore + 1)

        await act(async () => {
            await ctl.push({ type: 'text-delta', delta: 'try 2' })
            await ctl.push({ type: 'done' })
            ctl.finish()
        })
        await waitFor(() => {
            expect(result.current.messages[1]?.text).toBe('try 2')
        })
    })

    it('aborts an in-flight stream from the trimmed assistant turn before re-running', async () => {
        const ctl = makeControlledTransport()
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({ transport: ctl.transport }),
        )

        await act(async () => {
            void result.current.send('q')
            await Promise.resolve()
        })
        const firstSignal = ctl.lastSignal()
        expect(firstSignal?.aborted).toBe(false)

        await act(async () => {
            void result.current.regenerate()
            await Promise.resolve()
        })

        // The PRIOR stream's signal must have aborted — otherwise the
        // old stream would race the new one.
        expect(firstSignal?.aborted).toBe(true)
        // The new stream's signal is a fresh, un-aborted controller.
        const secondSignal = ctl.lastSignal()
        expect(secondSignal).not.toBe(firstSignal)
        expect(secondSignal?.aborted).toBe(false)

        await act(async () => {
            await ctl.push({ type: 'done' })
            ctl.finish()
        })
    })

    it('no-ops + warns when no user message exists', async () => {
        const ctl = makeControlledTransport()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({ transport: ctl.transport }),
        )

        await act(async () => {
            await result.current.regenerate()
        })

        expect(ctl.sendCount()).toBe(0)
        expect(result.current.messages).toHaveLength(0)
        expect(warn).toHaveBeenCalledTimes(1)
        warn.mockRestore()
    })

    it('forwards opts.metadata to the regenerated transport call', async () => {
        const ctl = makeControlledTransport()
        const { result } = renderHook(() =>
            useMaestroChat<DataMap>({ transport: ctl.transport }),
        )

        await act(async () => {
            void result.current.send('hello')
        })
        await act(async () => {
            await ctl.push({ type: 'done' })
            ctl.finish()
        })
        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
        })

        await act(async () => {
            void result.current.regenerate({
                metadata: { reason: 'retry-after-rate-limit' },
            })
            await Promise.resolve()
        })

        expect(ctl.sentMetadata()).toEqual({
            reason: 'retry-after-rate-limit',
        })

        await act(async () => {
            await ctl.push({ type: 'done' })
            ctl.finish()
        })
    })
})
