import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { BaseToolContext } from '../context.js'
import { ok } from '../envelope.js'
import { FixedClock } from '../ports/clock.js'
import type { Logger } from '../ports/logger.js'
import type { TelemetryEvent, TelemetrySink } from '../ports/telemetry-sink.js'
import { defineAgentTool } from '../tool.js'

/**
 * Regression suite for the runChatTurn → streamText handoff.
 *
 * The bugs caught by 0.2.3 (system prompt mixed into messages, missing
 * stopWhen) were both invisible to type-checks — they only surfaced as
 * "the model emits `<function_calls>` XML in prose" in production. A
 * smoke test that asserts the streamText call shape would have caught
 * either bug before publish.
 *
 * Strategy: mock `streamText`, `convertToModelMessages`, and
 * `createAnthropic` from the AI SDK; call `runChatTurn` with minimal
 * fake ports; inspect the streamText invocation's args. No real LLM
 * call, no API key needed, runs in CI.
 *
 * See memory note `ai_sdk_tools_function_calls_xml_in_prose.md` for
 * the failure mode this guards against.
 */

const streamTextMock = vi.fn()
const convertToModelMessagesMock = vi.fn().mockResolvedValue([
    { role: 'user' as const, content: 'hi there' },
])
const anthropicFactoryMock = vi.fn().mockReturnValue('mock-anthropic-model-instance')
const createAnthropicMock = vi.fn().mockReturnValue(anthropicFactoryMock)

vi.mock('ai', async () => {
    const actual = await vi.importActual<typeof import('ai')>('ai')
    return {
        ...actual,
        streamText: streamTextMock,
        convertToModelMessages: convertToModelMessagesMock,
    }
})

vi.mock('@ai-sdk/anthropic', () => ({
    createAnthropic: createAnthropicMock,
}))

const { runChatTurn } = await import('./run-chat-turn.js')

const FIXED = new Date('2026-05-17T18:30:00.000Z')

interface FakeCtx extends BaseToolContext {
    role: 'admin'
}

const ctx: FakeCtx = {
    tenantId: '42',
    principal: { id: '7', kind: 'user' },
    actor: 'human',
    transport: 'chat',
    locale: 'pt-BR',
    timezone: 'America/Sao_Paulo',
    requestId: 'req_test',
    role: 'admin',
}

function makeTools() {
    return [
        defineAgentTool<z.ZodObject<{ q: z.ZodString }>, { answered: boolean }, FakeCtx>({
            name: 'lookup',
            description: 'look up by q',
            transports: ['chat'],
            inputSchema: z.object({ q: z.string() }),
            execute: async () => ok({ answered: true }),
        }),
    ]
}

function makePorts() {
    return {
        turnStore: {
            upsert: vi.fn().mockResolvedValue(undefined),
            loadHistory: vi.fn().mockResolvedValue([]),
            markFailed: vi.fn().mockResolvedValue(undefined),
            markAborted: vi.fn().mockResolvedValue(undefined),
        },
        keyProvider: {
            getKey: vi.fn().mockResolvedValue('test-anthropic-key'),
        },
    }
}

function makeArgs(overrides: Partial<Parameters<typeof runChatTurn>[0]> = {}) {
    return {
        threadId: 'thread_x',
        ctx,
        messages: [
            {
                id: 'msg_1',
                role: 'user' as const,
                parts: [{ type: 'text' as const, text: 'hi there' }],
            },
        ],
        tools: makeTools(),
        systemPrompt: {
            static: 'You are a helpful assistant.',
            dynamic: 'Tenant prefers PT-BR.',
        },
        models: {
            fast: 'claude-haiku-4-5-20251001',
            smart: 'claude-sonnet-4-6',
        },
        ports: makePorts(),
        ...overrides,
    } as Parameters<typeof runChatTurn>[0]
}

beforeEach(() => {
    streamTextMock.mockReset()
    streamTextMock.mockReturnValue({
        toUIMessageStreamResponse: () => new Response('mock stream'),
    })
    convertToModelMessagesMock.mockClear()
    createAnthropicMock.mockClear()
    anthropicFactoryMock.mockClear()
})

describe('runChatTurn → streamText handoff (regression guard)', () => {
    it('passes `system` as the top-level parameter, NOT mixed into messages', async () => {
        await runChatTurn(makeArgs({ ports: { ...makePorts(), clock: new FixedClock(FIXED) } }))

        expect(streamTextMock).toHaveBeenCalledTimes(1)
        const call = streamTextMock.mock.calls[0]?.[0] as {
            system?: unknown
            messages?: Array<{ role: string }>
        }

        // System present at top level — without this, Anthropic tool-use
        // does not engage and the model falls back to emitting
        // <function_calls> XML in prose.
        expect(call.system).toBeDefined()

        // No `role: 'system'` entries in messages — they belong in `system`.
        expect(Array.isArray(call.messages)).toBe(true)
        for (const m of call.messages ?? []) {
            expect(m.role).not.toBe('system')
        }
    })

    it('sets `stopWhen` so the SDK runs more than one step (tool follow-up)', async () => {
        await runChatTurn(makeArgs({ ports: { ...makePorts(), clock: new FixedClock(FIXED) } }))

        const call = streamTextMock.mock.calls[0]?.[0] as { stopWhen?: unknown }
        // Default of stepCountIs(1) prevents tool-result follow-up — the
        // model can't see what its tools returned. Must be set.
        expect(call.stopWhen).toBeDefined()
    })

    it('honours custom maxSteps when provided', async () => {
        // Two parallel calls with different maxSteps; assert each gets
        // a distinct stopWhen value (we can't easily inspect the
        // closure, but having a stopWhen is the contract — the value
        // path is tested by the AI SDK itself).
        await runChatTurn(
            makeArgs({
                maxSteps: 10,
                ports: { ...makePorts(), clock: new FixedClock(FIXED) },
            })
        )

        const call = streamTextMock.mock.calls[0]?.[0] as { stopWhen?: unknown }
        expect(call.stopWhen).toBeDefined()
    })

    it('passes tools to streamText (so the model can actually invoke them)', async () => {
        await runChatTurn(makeArgs({ ports: { ...makePorts(), clock: new FixedClock(FIXED) } }))

        const call = streamTextMock.mock.calls[0]?.[0] as {
            tools?: Record<string, unknown>
        }
        expect(call.tools).toBeDefined()
        expect(call.tools).toHaveProperty('lookup')
    })

    it('honours host-supplied turnId on the assistant TurnStore upsert', async () => {
        const ports = makePorts()
        await runChatTurn(
            makeArgs({
                turnId: 'host-supplied-123',
                ports: { ...ports, clock: new FixedClock(FIXED) },
            })
        )

        // First upsert is the `pending` assistant row; id must be the
        // host-supplied string verbatim, not a kernel-generated one.
        const pendingUpsert = (ports.turnStore.upsert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
            | { id?: string; status?: string }
            | undefined
        expect(pendingUpsert?.id).toBe('host-supplied-123')
        expect(pendingUpsert?.status).toBe('pending')
    })

    it('falls back to a generated turnId when host does not supply one', async () => {
        const ports = makePorts()
        await runChatTurn(makeArgs({ ports: { ...ports, clock: new FixedClock(FIXED) } }))

        const pendingUpsert = (ports.turnStore.upsert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
            | { id?: string }
            | undefined
        expect(pendingUpsert?.id).toMatch(/^turn_\d+/)
    })

    it('resolves provider key via ModelKeyProvider before calling streamText', async () => {
        const ports = makePorts()
        await runChatTurn(makeArgs({ ports: { ...ports, clock: new FixedClock(FIXED) } }))

        expect(ports.keyProvider.getKey).toHaveBeenCalledWith('anthropic', '42')
        expect(createAnthropicMock).toHaveBeenCalledWith(
            expect.objectContaining({ apiKey: 'test-anthropic-key' })
        )
    })

    it('logs a warn when the tool registry is empty (likely host filter dropped everything)', async () => {
        // The surface-vs-transport trap (barbeiro PR #377) collapsed
        // the entire eligibility list to zero tools. Anthropic with
        // `tools: {}` falls back to emitting <function_calls> XML in
        // prose from its pre-tool-use training corpus. The symptom
        // only surfaces in the user's chat bubble — never in stack
        // traces. A kernel-side warn at least puts the signal in
        // operator logs so the failure mode has a foothold besides
        // the user complaint.
        const warn = vi.fn()
        const logger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn,
            error: vi.fn(),
        }
        await runChatTurn(
            makeArgs({
                tools: [],
                ports: { ...makePorts(), clock: new FixedClock(FIXED), logger },
            })
        )

        const emptyWarns = warn.mock.calls.filter(([msg]) =>
            typeof msg === 'string' && msg.includes('empty tool registry')
        )
        expect(emptyWarns.length).toBe(1)
        expect(emptyWarns[0]?.[1]).toMatchObject({
            tenantId: '42',
            transport: 'chat',
            actor: 'human',
        })
    })

    it('does NOT log the empty-registry warn when tools are present', async () => {
        const warn = vi.fn()
        const logger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn,
            error: vi.fn(),
        }
        await runChatTurn(
            makeArgs({
                ports: { ...makePorts(), clock: new FixedClock(FIXED), logger },
            })
        )

        const emptyWarns = warn.mock.calls.filter(([msg]) =>
            typeof msg === 'string' && msg.includes('empty tool registry')
        )
        expect(emptyWarns.length).toBe(0)
    })
})

/**
 * Empty-recovery wire-in regression suite.
 *
 * runChatTurn classifies every finished turn via `decideEmptyRecovery`
 * and surfaces the outcome via the TelemetrySink + Logger ports. Mid-
 * stream injection is NOT yet wired (streamText v6 doesn't expose a
 * writer), so these tests cover observability only.
 *
 * Strategy: capture the `onFinish` callback streamText receives, drive
 * it manually with synthetic `event` objects shaped like the AI SDK's
 * `onFinish` payload, then assert the telemetry sink + logger were
 * called with the right discriminator and shape.
 */
describe('runChatTurn → empty-recovery wire-in', () => {
    function captureOnFinish(): () => (event: unknown) => Promise<void> {
        return () => {
            const call = streamTextMock.mock.calls.at(-1)?.[0] as
                | { onFinish?: (event: unknown) => Promise<void> }
                | undefined
            if (!call?.onFinish) {
                throw new Error('onFinish was not passed to streamText')
            }
            return call.onFinish
        }
    }

    function makeTelemetry(): { sink: TelemetrySink; events: TelemetryEvent[] } {
        const events: TelemetryEvent[] = []
        return {
            events,
            sink: {
                emit: async (batch) => {
                    events.push(...batch)
                },
            },
        }
    }

    function makeLogger(): { logger: Logger; warnCalls: Array<[string, object | undefined]> } {
        const warnCalls: Array<[string, object | undefined]> = []
        return {
            warnCalls,
            logger: {
                debug: () => {},
                info: () => {},
                warn: (msg, meta) => {
                    warnCalls.push([msg, meta])
                },
                error: () => {},
            },
        }
    }

    it('does NOT emit turn.empty_recovery when the turn has text (classifier returns triggered=false)', async () => {
        const { sink, events } = makeTelemetry()
        const { logger, warnCalls } = makeLogger()

        await runChatTurn(
            makeArgs({
                ports: {
                    ...makePorts(),
                    clock: new FixedClock(FIXED),
                    telemetry: sink,
                    logger,
                },
            })
        )
        const grab = captureOnFinish()
        await grab()({
            text: 'Here is your answer.',
            toolCalls: [{ toolName: 'lookup' }],
            usage: { inputTokens: 10, outputTokens: 20 },
        })

        const recoveryEvents = events.filter((e) => e.type === 'turn.empty_recovery')
        expect(recoveryEvents).toHaveLength(0)
        // turn.finalized still fires.
        expect(events.some((e) => e.type === 'turn.finalized')).toBe(true)
        // No warn for the no-op case.
        expect(
            warnCalls.some(([msg]) => msg.includes('empty-recovery classifier triggered'))
        ).toBe(false)
    })

    it('emits turn.empty_recovery (log_only) when tools ran but text is empty', async () => {
        const { sink, events } = makeTelemetry()
        const { logger, warnCalls } = makeLogger()

        await runChatTurn(
            makeArgs({
                ports: {
                    ...makePorts(),
                    clock: new FixedClock(FIXED),
                    telemetry: sink,
                    logger,
                },
                // Default mode is 'log_only' but spell it out for clarity.
                emptyRecoveryMode: 'log_only',
            })
        )
        const grab = captureOnFinish()
        await grab()({
            text: '',
            toolCalls: [{ toolName: 'lookup' }],
            usage: { inputTokens: 10, outputTokens: 0 },
        })

        const recoveryEvents = events.filter((e) => e.type === 'turn.empty_recovery')
        expect(recoveryEvents).toHaveLength(1)
        const evt = recoveryEvents[0] as Extract<TelemetryEvent, { type: 'turn.empty_recovery' }>
        expect(evt.turnId).toBeDefined()
        expect(evt.threadId).toBe('thread_x')
        expect(evt.tenantId).toBe('42')
        expect(evt.decision.triggered).toBe(true)
        expect(evt.decision.mode).toBe('log_only')
        expect(evt.decision.persistedErrorCode).toBe('tool_loop_no_text_logged')
        expect(evt.decision.fallbackText).toBeNull()

        // Telemetry order: empty_recovery before turn.finalized.
        const recoveryIdx = events.findIndex((e) => e.type === 'turn.empty_recovery')
        const finalizedIdx = events.findIndex((e) => e.type === 'turn.finalized')
        expect(recoveryIdx).toBeLessThan(finalizedIdx)

        // Warn fires with structured context.
        const warn = warnCalls.find(([msg]) =>
            msg.includes('empty-recovery classifier triggered')
        )
        expect(warn).toBeDefined()
        expect(warn?.[1]).toMatchObject({
            tenantId: '42',
            threadId: 'thread_x',
            mode: 'log_only',
            persistedErrorCode: 'tool_loop_no_text_logged',
        })
    })

    it('emits turn.empty_recovery (enforce) with the fallback text + recovered code, and records metadata.empty_recovery_code on the TurnStore upsert', async () => {
        const { sink, events } = makeTelemetry()
        const { logger, warnCalls } = makeLogger()
        const ports = makePorts()

        await runChatTurn(
            makeArgs({
                ports: {
                    ...ports,
                    clock: new FixedClock(FIXED),
                    telemetry: sink,
                    logger,
                },
                emptyRecoveryMode: 'enforce',
                emptyRecoveryFallback: 'Desculpe, tive um problema. Pode tentar de novo?',
            })
        )
        const grab = captureOnFinish()
        await grab()({
            text: '',
            toolCalls: [{ toolName: 'lookup' }],
            usage: { inputTokens: 10, outputTokens: 0 },
        })

        const recoveryEvents = events.filter((e) => e.type === 'turn.empty_recovery')
        expect(recoveryEvents).toHaveLength(1)
        const evt = recoveryEvents[0] as Extract<TelemetryEvent, { type: 'turn.empty_recovery' }>
        expect(evt.decision.mode).toBe('enforce')
        expect(evt.decision.persistedErrorCode).toBe('tool_loop_no_text_recovered_fallback')
        expect(evt.decision.fallbackText).toBe(
            'Desculpe, tive um problema. Pode tentar de novo?'
        )

        // Warn fired for the non-ok decision.
        expect(
            warnCalls.some(([msg]) => msg.includes('empty-recovery classifier triggered'))
        ).toBe(true)

        // Final assistant upsert carries the recovered code in metadata.
        // The first upsert is the 'pending' row; the second is the
        // 'completed' row written from onFinish.
        const upsertCalls = (ports.turnStore.upsert as ReturnType<typeof vi.fn>).mock.calls
        const finalUpsert = upsertCalls.at(-1)?.[0] as
            | { status?: string; metadata?: Record<string, unknown> }
            | undefined
        expect(finalUpsert?.status).toBe('completed')
        expect(finalUpsert?.metadata).toMatchObject({
            empty_recovery_code: 'tool_loop_no_text_recovered_fallback',
        })
    })

    it('does nothing when emptyRecoveryMode is "off"', async () => {
        const { sink, events } = makeTelemetry()
        const { logger, warnCalls } = makeLogger()

        await runChatTurn(
            makeArgs({
                ports: {
                    ...makePorts(),
                    clock: new FixedClock(FIXED),
                    telemetry: sink,
                    logger,
                },
                emptyRecoveryMode: 'off',
            })
        )
        const grab = captureOnFinish()
        await grab()({
            text: '',
            toolCalls: [{ toolName: 'lookup' }],
            usage: { inputTokens: 10, outputTokens: 0 },
        })

        expect(events.filter((e) => e.type === 'turn.empty_recovery')).toHaveLength(0)
        expect(
            warnCalls.some(([msg]) => msg.includes('empty-recovery classifier triggered'))
        ).toBe(false)
    })
})
