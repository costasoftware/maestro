/**
 * `useMaestroChat` — the headless chat hook. Drives a `Transport`
 * implementation, folds emitted `MaestroEvent`s into `MaestroMessage`s,
 * exposes a minimal imperative API (`send` / `abort` / `reset` /
 * `append` / `setMessages` / `regenerate`) plus reactive `messages` /
 * `isLoading` / `error`.
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
 *
 *  - `setMessages` and `regenerate` were added in 0.3.0. `setMessages`
 *    is a wholesale replacement that intentionally leaves the abort
 *    controller alone — it is the rehydration primitive (loading a
 *    saved thread should not cancel an unrelated in-flight stream).
 *    `regenerate` trims after the last user turn and re-runs the
 *    transport; it DOES cancel an in-flight controller because it is
 *    itself starting a new stream, exactly like `send()`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { MaestroError, MaestroMessage } from './message.js'
import type { MaestroAttachment, MaestroEvent } from './protocol.js'
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
    send(
        text: string,
        opts?: {
            metadata?: unknown
            attachments?: ReadonlyArray<MaestroAttachment>
        },
    ): Promise<void>
    abort(): void
    reset(): void
    append(message: MaestroMessage<TDataMap>): void
    /**
     * Replace the message list wholesale. Intended for rehydrating a
     * saved thread without the abort + replay dance `reset()` + N×
     * `append()` would otherwise require.
     *
     * Does NOT touch the in-flight `AbortController`, does NOT clear
     * `error`, and does NOT toggle `isLoading`. Use `reset()` if you
     * want a full state wipe.
     */
    setMessages(next: ReadonlyArray<MaestroMessage<TDataMap>>): void
    /**
     * Re-run the transport against the conversation up to (and
     * including) the most recent user message — everything after that
     * user turn is dropped before the new request fires.
     *
     * If `messages` contains no user message, this is a no-op and a
     * `console.warn` is emitted.
     *
     * Like `send()`, this aborts any in-flight stream BEFORE starting
     * the new one (two simultaneous streams would race). Unlike
     * `reset()`, it does NOT clear state beyond the trimmed assistant
     * turn — `error` is cleared so the UI can show the fresh stream
     * cleanly.
     */
    regenerate(opts?: {
        metadata?: unknown
        attachments?: ReadonlyArray<MaestroAttachment>
    }): Promise<void>
}

const defaultGenerateId = (): string =>
    `msg_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`

export function useMaestroChat<
    TDataMap = Record<string, unknown>,
>(opts: UseMaestroChatOptions<TDataMap>): UseMaestroChatReturn<TDataMap> {
    const { transport, initialMessages, onError, onFinish } = opts
    const generateId = opts.generateId ?? defaultGenerateId

    const [messages, setMessagesState] = useState<
        ReadonlyArray<MaestroMessage<TDataMap>>
    >(() => initialMessages ?? [])
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<MaestroError | null>(null)

    // Mirror `messages` into a ref so `send` / `regenerate` can read the
    // latest committed snapshot synchronously without depending on the
    // `setMessagesState(prev => …)` updater being called eagerly. React
    // 18+ concurrent rendering defers updater functions to the commit
    // phase, so the prior pattern of capturing `prev` via closure
    // assignment yielded an empty snapshot on the first turn of any
    // fresh thread (no prior `messages`, no append yet → updater not yet
    // invoked when the next line read the local variable). Hoisted above
    // `send` so the closure resolves cleanly without TDZ warnings.
    const messagesRef = useRef<ReadonlyArray<MaestroMessage<TDataMap>>>(
        messages,
    )
    useEffect(() => {
        messagesRef.current = messages
    }, [messages])

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

    /**
     * Core stream runner shared by `send` and `regenerate`. Owns the
     * abort-controller swap, the loading flag, and the post-stream
     * `onFinish` / `onError` dispatch. Callers prepare the snapshot
     * (history + user + pending assistant) and pass the assistant id
     * that should absorb the incoming events.
     */
    const runStream = useCallback(
        async (
            transportMessages: ReadonlyArray<MaestroMessage<TDataMap>>,
            assistantId: string,
            metadata: unknown,
            attachments: ReadonlyArray<MaestroAttachment> | undefined,
        ): Promise<void> => {
            controllerRef.current?.abort()
            const controller = new AbortController()
            controllerRef.current = controller

            setError(null)
            setIsLoading(true)

            try {
                const iterable = transport.send({
                    messages: transportMessages,
                    signal: controller.signal,
                    metadata,
                    ...(attachments !== undefined ? { attachments } : {}),
                })
                for await (const event of iterable) {
                    if (controller.signal.aborted) break
                    setMessagesState(prev =>
                        applyEventInList(prev, assistantId, event),
                    )
                }
            } catch (err) {
                const maestroError = toMaestroError(err)
                setMessagesState(prev =>
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
            setMessagesState(prev => {
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
        [transport],
    )

    const send = useCallback(
        async (
            text: string,
            sendOpts?: {
                metadata?: unknown
                attachments?: ReadonlyArray<MaestroAttachment>
            },
        ): Promise<void> => {
            const trimmed = text.trim()
            // Allow empty text iff attachments are present — pure-media
            // sends are legitimate (image-only chat turns). Without
            // attachments, fall back to the prior empty-input guard.
            const hasAttachments =
                sendOpts?.attachments !== undefined &&
                sendOpts.attachments.length > 0
            if (trimmed.length === 0 && !hasAttachments) return

            const userMessage = createUserMessage<TDataMap>({
                id: generateId(),
                text: trimmed,
                attachments: sendOpts?.attachments,
            })
            const assistantId = generateId()
            const assistantMessage = createAssistantMessage<TDataMap>({
                id: assistantId,
            })

            // Capture the snapshot the transport sees synchronously from
            // the messages ref (kept in sync with the React state via the
            // hoisted effect above). Reading the ref instead of the prior
            // `setMessagesState(prev => …)` closure capture avoids the
            // React-18 race where the updater is deferred to commit, which
            // left `transportMessages` empty on the first turn of any
            // fresh thread.
            const snapshot: ReadonlyArray<MaestroMessage<TDataMap>> = [
                ...messagesRef.current,
                userMessage,
                assistantMessage,
            ]
            setMessagesState(snapshot)

            // Strip the placeholder assistant from the snapshot the
            // transport sees — it's still pending, no point sending it.
            const transportMessages = snapshot.slice(0, -1)

            await runStream(
                transportMessages,
                assistantId,
                sendOpts?.metadata,
                sendOpts?.attachments,
            )
        },
        [generateId, runStream],
    )

    const abort = useCallback(() => {
        const controller = controllerRef.current
        if (!controller) return
        controller.abort()
        controllerRef.current = null
        setIsLoading(false)
        setMessagesState(prev => {
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
        setMessagesState(initialMessages ?? [])
        setError(null)
        setIsLoading(false)
    }, [initialMessages])

    const append = useCallback(
        (message: MaestroMessage<TDataMap>) => {
            setMessagesState(prev => [...prev, message])
        },
        [],
    )

    /**
     * Replace the message list wholesale. Deliberately does NOT call
     * `controllerRef.current?.abort()` — a thread rehydration should
     * not cancel an unrelated in-flight stream that the caller might
     * still be awaiting via `onFinish`.
     */
    const setMessages = useCallback(
        (next: ReadonlyArray<MaestroMessage<TDataMap>>) => {
            setMessagesState(next)
        },
        [],
    )

    const regenerate = useCallback(
        async (regenOpts?: {
            metadata?: unknown
            attachments?: ReadonlyArray<MaestroAttachment>
        }): Promise<void> => {
            const current = messagesRef.current
            const lastUserIdx = findLastIndex(
                current,
                m => m.role === 'user',
            )
            if (lastUserIdx === -1) {
                // eslint-disable-next-line no-console
                console.warn(
                    'useMaestroChat: regenerate() called with no user message in history; no-op.',
                )
                return
            }
            // Transport sees history up to + including the user turn,
            // mirroring `send()`'s convention.
            const transportMessages = current.slice(0, lastUserIdx + 1)
            const assistantId = generateId()
            const assistantMessage = createAssistantMessage<TDataMap>({
                id: assistantId,
            })
            const nextMessages = [...transportMessages, assistantMessage]
            // Apply the trimmed + fresh assistant snapshot before we
            // start the stream so the UI immediately drops the stale
            // assistant turn.
            setMessagesState(nextMessages)

            // Re-use the trailing user turn's attachments by default so
            // a retry sends the same payload to the backend. Callers can
            // override via `regenOpts.attachments` (e.g. to drop a
            // failed-to-upload file before retrying).
            const trailingUser = current[lastUserIdx]
            const attachments =
                regenOpts && 'attachments' in regenOpts
                    ? regenOpts.attachments
                    : trailingUser?.attachments

            await runStream(
                transportMessages,
                assistantId,
                regenOpts?.metadata,
                attachments,
            )
        },
        [generateId, runStream],
    )

    return useMemo(
        () => ({
            messages,
            isLoading,
            error,
            send,
            abort,
            reset,
            append,
            setMessages,
            regenerate,
        }),
        [
            messages,
            isLoading,
            error,
            send,
            abort,
            reset,
            append,
            setMessages,
            regenerate,
        ],
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

/**
 * `Array#findLastIndex` polyfill — keep this hook ES2022-safe without
 * pulling in a lib bump. Drop once we require ES2023.
 */
function findLastIndex<T>(
    arr: ReadonlyArray<T>,
    predicate: (item: T) => boolean,
): number {
    for (let i = arr.length - 1; i >= 0; i -= 1) {
        const item = arr[i]
        if (item !== undefined && predicate(item)) return i
    }
    return -1
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
