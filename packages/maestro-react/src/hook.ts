/**
 * `useMaestroChat` — the headless chat hook. Drives a `Transport`
 * implementation, folds emitted `MaestroEvent`s into `MaestroMessage`s,
 * exposes a minimal imperative API (`send` / `abort` / `reset` /
 * `append`) plus reactive `messages` / `isLoading` / `error`.
 *
 * This file is the ONLY React-touching module in P2. Everything else
 * (protocol, reducer, transports) is framework-agnostic.
 *
 * Design notes:
 *
 *  - We hold messages in `useState` keyed by an internal `version`
 *    counter, not a Map. The reducer returns a fresh message per event,
 *    so each chunk produces one render — fine at human-chat cadence.
 *
 *  - The latest in-flight `AbortController` is held in a ref so calling
 *    `send()` again supersedes the previous request without racing the
 *    React batched update.
 *
 *  - `onError` / `onFinish` fire AFTER state updates so callers can
 *    safely call `messages.find(...)` synchronously inside them.
 *
 *  - SSR-safe: no DOM access at module scope. The hook itself doesn't
 *    touch DOM either — that's the transport's job.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { MaestroError, MaestroMessage } from './message.js'
import type { MaestroEvent } from './protocol.js'
import type { Transport } from './transport.js'
import {
    abortMessage,
    applyEvent,
    createAssistantMessage,
    createUserMessage,
    failMessage,
} from './reducer.js'

export interface UseMaestroChatOptions<
    TDataMap = Record<string, unknown>,
> {
    readonly transport: Transport<TDataMap>
    readonly initialMessages?: ReadonlyArray<MaestroMessage<TDataMap>>
    readonly onError?: (error: MaestroError) => void
    readonly onFinish?: (final: MaestroMessage<TDataMap>) => void
    /** Generate IDs for messages. Defaults to a small uid factory. */
    readonly generateId?: () => string
}

export interface UseMaestroChatReturn<
    TDataMap = Record<string, unknown>,
> {
    readonly messages: ReadonlyArray<MaestroMessage<TDataMap>>
    readonly isLoading: boolean
    readonly error: MaestroError | null
    send(text: string, opts?: { metadata?: unknown }): Promise<void>
    abort(): void
    reset(): void
    append(message: MaestroMessage<TDataMap>): void
}

const defaultGenerateId = (): string =>
    `msg_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`

export function useMaestroChat<
    TDataMap = Record<string, unknown>,
>(opts: UseMaestroChatOptions<TDataMap>): UseMaestroChatReturn<TDataMap> {
    const { transport, initialMessages, onError, onFinish } = opts
    const generateId = opts.generateId ?? defaultGenerateId

    const [messages, setMessages] = useState<
        ReadonlyArray<MaestroMessage<TDataMap>>
    >(() => initialMessages ?? [])
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<MaestroError | null>(null)

    // We hold the in-flight controller in a ref so a new send() can
    // abort the previous request without forcing the prior `send()`
    // promise to throw on its own — the AbortSignal is the canonical
    // cancellation channel.
    const controllerRef = useRef<AbortController | null>(null)

    // Keep stable callbacks behind refs so the hook can be called
    // with a fresh `onError` / `onFinish` on every render without
    // invalidating `send`/`abort` identity. Useful for consumers that
    // close over `messages` in their handler.
    const onErrorRef = useRef(onError)
    const onFinishRef = useRef(onFinish)
    useEffect(() => {
        onErrorRef.current = onError
    }, [onError])
    useEffect(() => {
        onFinishRef.current = onFinish
    }, [onFinish])

    // Abort any in-flight request when the component unmounts. The
    // transport SHOULD listen to the AbortSignal and stop reading.
    useEffect(() => {
        return () => {
            controllerRef.current?.abort()
        }
    }, [])

    const send = useCallback(
        async (text: string): Promise<void> => {
            const trimmed = text.trim()
            if (trimmed.length === 0) return

            // Cancel any in-flight stream first. If the caller has not
            // yet awaited the previous `send()`, this is the only way
            // to guarantee no overlap.
            controllerRef.current?.abort()
            const controller = new AbortController()
            controllerRef.current = controller

            const userMessage = createUserMessage<TDataMap>({
                id: generateId(),
                text: trimmed,
            })
            const assistantId = generateId()
            const assistantMessage = createAssistantMessage<TDataMap>({
                id: assistantId,
            })

            // Capture the snapshot the transport sees (history + user
            // turn) BEFORE we touch React state — `setMessages` is async.
            let snapshot: ReadonlyArray<MaestroMessage<TDataMap>> = []
            setMessages(prev => {
                snapshot = [...prev, userMessage, assistantMessage]
                return snapshot
            })
            setError(null)
            setIsLoading(true)

            // Strip the placeholder assistant from the snapshot the
            // transport sees — it's still pending, no point sending it.
            const transportMessages = snapshot.slice(0, -1)

            try {
                const iterable = transport.send({
                    messages: transportMessages,
                    signal: controller.signal,
                })
                for await (const event of iterable) {
                    if (controller.signal.aborted) break
                    setMessages(prev =>
                        applyEventInList(prev, assistantId, event),
                    )
                }
            } catch (err) {
                const maestroError = toMaestroError(err)
                setMessages(prev =>
                    failMessageInList(prev, assistantId, maestroError),
                )
                setError(maestroError)
                // Fire onError AFTER state updates so consumers can read
                // the final state inside the handler.
                queueMicrotask(() => onErrorRef.current?.(maestroError))
                return
            } finally {
                if (controllerRef.current === controller) {
                    controllerRef.current = null
                    setIsLoading(false)
                }
            }

            // Compute the final assistant message after all events
            // applied. Fire onFinish only on a clean completion — not
            // abort / error.
            setMessages(prev => {
                const final = prev.find(m => m.id === assistantId)
                if (final && final.status === 'complete') {
                    queueMicrotask(() => onFinishRef.current?.(final))
                } else if (final && final.status === 'errored' && final.error) {
                    const captured = final.error
                    setError(captured)
                    queueMicrotask(() => onErrorRef.current?.(captured))
                }
                return prev
            })
        },
        [transport, generateId],
    )

    const abort = useCallback(() => {
        const controller = controllerRef.current
        if (!controller) return
        controller.abort()
        controllerRef.current = null
        setIsLoading(false)
        setMessages(prev => {
            // Mark the trailing pending/streaming assistant turn as
            // aborted. This is what the UI listens to.
            const last = prev[prev.length - 1]
            if (
                !last ||
                last.role !== 'assistant' ||
                (last.status !== 'pending' && last.status !== 'streaming')
            ) {
                return prev
            }
            const next = prev.slice()
            next[next.length - 1] = abortMessage(last)
            return next
        })
    }, [])

    const reset = useCallback(() => {
        controllerRef.current?.abort()
        controllerRef.current = null
        setMessages(initialMessages ?? [])
        setError(null)
        setIsLoading(false)
    }, [initialMessages])

    const append = useCallback(
        (message: MaestroMessage<TDataMap>) => {
            setMessages(prev => [...prev, message])
        },
        [],
    )

    return useMemo(
        () => ({ messages, isLoading, error, send, abort, reset, append }),
        [messages, isLoading, error, send, abort, reset, append],
    )
}

function applyEventInList<TDataMap>(
    list: ReadonlyArray<MaestroMessage<TDataMap>>,
    assistantId: string,
    event: MaestroEvent,
): ReadonlyArray<MaestroMessage<TDataMap>> {
    const idx = list.findIndex(m => m.id === assistantId)
    if (idx === -1) return list
    const existing = list[idx]
    if (!existing) return list
    const next = list.slice()
    next[idx] = applyEvent(existing, event)
    return next
}

function failMessageInList<TDataMap>(
    list: ReadonlyArray<MaestroMessage<TDataMap>>,
    assistantId: string,
    error: MaestroError,
): ReadonlyArray<MaestroMessage<TDataMap>> {
    const idx = list.findIndex(m => m.id === assistantId)
    if (idx === -1) return list
    const existing = list[idx]
    if (!existing) return list
    const next = list.slice()
    next[idx] = failMessage(existing, error)
    return next
}

function toMaestroError(error: unknown): MaestroError {
    if (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error as { name: unknown }).name === 'AbortError'
    ) {
        return { code: 'ABORTED', message: 'request aborted' }
    }
    if (error instanceof Error) {
        return { code: error.name, message: error.message, cause: error }
    }
    return { message: String(error), cause: error }
}
