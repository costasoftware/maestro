import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { BaseToolContext } from '../context.js'
import { ok } from '../envelope.js'
import { FixedClock } from '../ports/clock.js'
import type { Logger } from '../ports/logger.js'
import type { QuotaStore } from '../ports/quota-store.js'
import type { TelemetryEvent, TelemetrySink } from '../ports/telemetry-sink.js'
import { defineAgentTool } from '../tool.js'

/**
 * Regression suite for runOneShotTurn → generateText handoff.
 *
 * Mirrors run-chat-turn.test.ts: same trap-guard assertions (system
 * at top-level, stopWhen set, empty-registry warn, populated tools),
 * same telemetry / persistence shape, same recovery-mode coverage.
 * Differences: generateText is mocked instead of streamText; the
 * second-call enforce path runs as a real second generateText call
 * (not a writer merge), and the returned typed result is the source
 * of truth for tests (not a Response).
 */

const generateTextMock = vi.fn()
const convertToModelMessagesMock = vi.fn().mockResolvedValue([
    { role: 'user' as const, content: 'hi there' },
])
const anthropicFactoryMock = vi.fn().mockReturnValue('mock-anthropic-model-instance')
const createAnthropicMock = vi.fn().mockReturnValue(anthropicFactoryMock)

vi.mock('ai', async () => {
    const actual = await vi.importActual<typeof import('ai')>('ai')
    return {
        ...actual,
        generateText: generateTextMock,
        convertToModelMessages: convertToModelMessagesMock,
    }
})

vi.mock('@ai-sdk/anthropic', () => ({
    createAnthropic: createAnthropicMock,
}))

const { runOneShotTurn } = await import('./run-one-shot-turn.js')

const FIXED = new Date('2026-05-19T12:00:00.000Z')

interface FakeCtx extends BaseToolContext {
    role: 'admin'
}

const ctx: FakeCtx = {
    tenantId: '42',
    principal: { id: '7', kind: 'user' },
    actor: 'human',
    transport: 'whatsapp',
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
            transports: ['whatsapp'],
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

function makeArgs(overrides: Partial<Parameters<typeof runOneShotTurn>[0]> = {}) {
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
            static: 'You are a WhatsApp assistant.',
            dynamic: 'Tenant prefers PT-BR.',
        },
        models: {
            fast: 'claude-haiku-4-5-20251001',
            smart: 'claude-sonnet-4-6',
        },
        ports: makePorts(),
        ...overrides,
    } as Parameters<typeof runOneShotTurn>[0]
}

function defaultPrimary(overrides: Record<string, unknown> = {}) {
    return {
        text: 'Hello! How can I help you today?',
        toolCalls: [],
        toolResults: [],
        usage: { inputTokens: 100, outputTokens: 50 },
        totalUsage: { inputTokens: 100, outputTokens: 50 },
        finishReason: 'stop',
        response: { messages: [] },
        steps: [],
        ...overrides,
    }
}

beforeEach(() => {
    generateTextMock.mockReset()
    generateTextMock.mockResolvedValue(defaultPrimary())
    convertToModelMessagesMock.mockClear()
    createAnthropicMock.mockClear()
    anthropicFactoryMock.mockClear()
})

describe('runOneShotTurn → generateText handoff (trap-guard regression)', () => {
    it('returns text + toolCalls + usage on the happy path', async () => {
        generateTextMock.mockResolvedValueOnce(
            defaultPrimary({
                text: 'Found it.',
                toolCalls: [
                    { toolName: 'lookup', toolCallId: 'call_1', input: { q: 'x' } },
                ],
                toolResults: [
                    { toolCallId: 'call_1', output: { answered: true } },
                ],
                usage: { inputTokens: 120, outputTokens: 30 },
                totalUsage: { inputTokens: 120, outputTokens: 30 },
                finishReason: 'tool-calls',
            })
        )

        const result = await runOneShotTurn(
            makeArgs({ ports: { ...makePorts(), clock: new FixedClock(FIXED) } })
        )

        expect(result.text).toBe('Found it.')
        expect(result.toolCalls).toHaveLength(1)
        expect(result.toolCalls[0]).toMatchObject({
            name: 'lookup',
            callId: 'call_1',
            input: { q: 'x' },
            result: { answered: true },
        })
        expect(result.usage.tokensIn).toBe(120)
        expect(result.usage.tokensOut).toBe(30)
        expect(result.finishReason).toBe('tool-calls')
        expect(result.emptyRecovery).toEqual({
            triggered: false,
            attempted: false,
            mode: 'log_only',
        })
    })

    it('passes `system` as the top-level parameter, NOT mixed into messages', async () => {
        await runOneShotTurn(
            makeArgs({ ports: { ...makePorts(), clock: new FixedClock(FIXED) } })
        )

        expect(generateTextMock).toHaveBeenCalledTimes(1)
        const call = generateTextMock.mock.calls[0]?.[0] as {
            system?: unknown
            messages?: Array<{ role: string }>
        }

        expect(call.system).toBeDefined()
        expect(Array.isArray(call.messages)).toBe(true)
        for (const m of call.messages ?? []) {
            expect(m.role).not.toBe('system')
        }
    })

    it('sets `stopWhen` so the SDK runs more than one step (tool follow-up)', async () => {
        await runOneShotTurn(
            makeArgs({ ports: { ...makePorts(), clock: new FixedClock(FIXED) } })
        )
        const call = generateTextMock.mock.calls[0]?.[0] as { stopWhen?: unknown }
        expect(call.stopWhen).toBeDefined()
    })

    it('honours custom maxSteps when provided', async () => {
        await runOneShotTurn(
            makeArgs({
                maxSteps: 10,
                ports: { ...makePorts(), clock: new FixedClock(FIXED) },
            })
        )
        const call = generateTextMock.mock.calls[0]?.[0] as { stopWhen?: unknown }
        expect(call.stopWhen).toBeDefined()
    })

    it('passes tools to generateText (so the model can actually invoke them)', async () => {
        await runOneShotTurn(
            makeArgs({ ports: { ...makePorts(), clock: new FixedClock(FIXED) } })
        )
        const call = generateTextMock.mock.calls[0]?.[0] as {
            tools?: Record<string, unknown>
        }
        expect(call.tools).toBeDefined()
        expect(call.tools).toHaveProperty('lookup')
    })

    it('logs a warn when the tool registry is empty', async () => {
        const warn = vi.fn()
        const logger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn,
            error: vi.fn(),
        }
        await runOneShotTurn(
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
            transport: 'whatsapp',
            actor: 'human',
        })
    })

    it('does NOT auto-inject the anti-narration rule (caller composes it)', async () => {
        // The rule is exported for callers to compose into systemPrompt.static.
        // The kernel must not silently inject it — long bespoke prompts would
        // get double-pinged. The system content the kernel actually sends
        // must come straight from systemPrompt.static / dynamic with only
        // the cache-control wrapping + tenant context line that
        // applyCacheBreakpoints adds.
        await runOneShotTurn(
            makeArgs({
                ports: { ...makePorts(), clock: new FixedClock(FIXED) },
            })
        )
        const call = generateTextMock.mock.calls[0]?.[0] as {
            system?: Array<{ content: string }>
        }
        const systemContent = (call.system ?? [])
            .map((s) => s.content)
            .join('\n')
        expect(systemContent).toContain('You are a WhatsApp assistant.')
        expect(systemContent).not.toContain('do NOT narrate the call')
    })

    it('honours host-supplied turnId on the pending TurnStore upsert', async () => {
        const ports = makePorts()
        await runOneShotTurn(
            makeArgs({
                turnId: 'host-supplied-456',
                ports: { ...ports, clock: new FixedClock(FIXED) },
            })
        )

        const pendingUpsert = (ports.turnStore.upsert as ReturnType<typeof vi.fn>).mock
            .calls[0]?.[0] as { id?: string; status?: string } | undefined
        expect(pendingUpsert?.id).toBe('host-supplied-456')
        expect(pendingUpsert?.status).toBe('pending')
    })

    it('falls back to a generated turnId when host does not supply one', async () => {
        const ports = makePorts()
        await runOneShotTurn(
            makeArgs({ ports: { ...ports, clock: new FixedClock(FIXED) } })
        )
        const pendingUpsert = (ports.turnStore.upsert as ReturnType<typeof vi.fn>).mock
            .calls[0]?.[0] as { id?: string } | undefined
        expect(pendingUpsert?.id).toMatch(/^turn_\d+/)
    })

    it('resolves provider key via ModelKeyProvider before calling generateText', async () => {
        const ports = makePorts()
        await runOneShotTurn(
            makeArgs({ ports: { ...ports, clock: new FixedClock(FIXED) } })
        )

        expect(ports.keyProvider.getKey).toHaveBeenCalledWith('anthropic', '42')
        expect(createAnthropicMock).toHaveBeenCalledWith(
            expect.objectContaining({ apiKey: 'test-anthropic-key' })
        )
    })

    it('forwards maxOutputTokens to generateText when provided', async () => {
        await runOneShotTurn(
            makeArgs({
                maxOutputTokens: 256,
                ports: { ...makePorts(), clock: new FixedClock(FIXED) },
            })
        )
        const call = generateTextMock.mock.calls[0]?.[0] as { maxOutputTokens?: number }
        expect(call.maxOutputTokens).toBe(256)
    })

    it('omits maxOutputTokens from generateText args when not provided', async () => {
        await runOneShotTurn(
            makeArgs({ ports: { ...makePorts(), clock: new FixedClock(FIXED) } })
        )
        const call = generateTextMock.mock.calls[0]?.[0] as { maxOutputTokens?: number }
        expect(call.maxOutputTokens).toBeUndefined()
    })

    it('forwards toolChoice "required" to the primary generateText call (WhatsApp stall-retry path)', async () => {
        await runOneShotTurn(
            makeArgs({
                toolChoice: 'required',
                ports: { ...makePorts(), clock: new FixedClock(FIXED) },
            })
        )
        const call = generateTextMock.mock.calls[0]?.[0] as { toolChoice?: unknown }
        expect(call.toolChoice).toBe('required')
    })

    it('forwards toolChoice "none" to the primary generateText call (forced text-only pass)', async () => {
        await runOneShotTurn(
            makeArgs({
                toolChoice: 'none',
                ports: { ...makePorts(), clock: new FixedClock(FIXED) },
            })
        )
        const call = generateTextMock.mock.calls[0]?.[0] as { toolChoice?: unknown }
        expect(call.toolChoice).toBe('none')
    })

    it('defaults toolChoice to "auto" when not supplied (zero behavior change for existing consumers)', async () => {
        await runOneShotTurn(
            makeArgs({ ports: { ...makePorts(), clock: new FixedClock(FIXED) } })
        )
        const call = generateTextMock.mock.calls[0]?.[0] as { toolChoice?: unknown }
        expect(call.toolChoice).toBe('auto')
    })

    it('pins synthesis-call toolChoice to "none" regardless of primary-call toolChoice', async () => {
        // Primary: empty text + tool call so enforce-mode synthesis fires.
        generateTextMock.mockResolvedValueOnce(
            defaultPrimary({
                text: '',
                toolCalls: [{ toolName: 'lookup', toolCallId: 'c1', input: { q: 'x' } }],
                toolResults: [{ toolCallId: 'c1', output: { answered: true } }],
                usage: { inputTokens: 10, outputTokens: 0 },
                totalUsage: { inputTokens: 10, outputTokens: 0 },
            })
        )
        generateTextMock.mockResolvedValueOnce(
            defaultPrimary({
                text: 'synthesised',
                toolCalls: [],
                toolResults: [],
                usage: { inputTokens: 5, outputTokens: 3 },
                totalUsage: { inputTokens: 5, outputTokens: 3 },
            })
        )

        await runOneShotTurn(
            makeArgs({
                toolChoice: 'required',
                emptyRecoveryMode: 'enforce',
                emptyRecoveryFallback: 'fallback',
                ports: { ...makePorts(), clock: new FixedClock(FIXED) },
            })
        )

        expect(generateTextMock).toHaveBeenCalledTimes(2)
        const primary = generateTextMock.mock.calls[0]?.[0] as { toolChoice?: unknown }
        const synth = generateTextMock.mock.calls[1]?.[0] as { toolChoice?: unknown }
        expect(primary.toolChoice).toBe('required')
        expect(synth.toolChoice).toBe('none')
    })

    it('persists pending → completed assistant turn rows', async () => {
        const ports = makePorts()
        await runOneShotTurn(
            makeArgs({ ports: { ...ports, clock: new FixedClock(FIXED) } })
        )
        const calls = (ports.turnStore.upsert as ReturnType<typeof vi.fn>).mock.calls
        expect(calls.length).toBeGreaterThanOrEqual(2)
        expect((calls[0]?.[0] as { status: string }).status).toBe('pending')
        const finalRow = calls.at(-1)?.[0] as { status: string; content: unknown }
        expect(finalRow.status).toBe('completed')
        expect(finalRow.content).toBe('Hello! How can I help you today?')
    })

    it('propagates abortSignal to generateText and marks the turn aborted on AbortError', async () => {
        const controller = new AbortController()
        const ports = makePorts()
        const abortError = new Error('aborted')
        abortError.name = 'AbortError'
        generateTextMock.mockRejectedValueOnce(abortError)

        controller.abort()

        await expect(
            runOneShotTurn(
                makeArgs({
                    abortSignal: controller.signal,
                    ports: { ...ports, clock: new FixedClock(FIXED) },
                })
            )
        ).rejects.toThrow('aborted')

        // generateText received the same abort signal.
        const call = generateTextMock.mock.calls[0]?.[0] as { abortSignal?: AbortSignal }
        expect(call.abortSignal).toBe(controller.signal)

        // turn marked aborted, not failed.
        expect(ports.turnStore.markAborted).toHaveBeenCalledWith(
            expect.any(String),
            'client-abort'
        )
        expect(ports.turnStore.markFailed).not.toHaveBeenCalled()
    })

    it('marks the turn failed on non-abort generateText errors', async () => {
        const ports = makePorts()
        generateTextMock.mockRejectedValueOnce(new Error('provider 500'))

        await expect(
            runOneShotTurn(
                makeArgs({ ports: { ...ports, clock: new FixedClock(FIXED) } })
            )
        ).rejects.toThrow('provider 500')

        expect(ports.turnStore.markFailed).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ code: 'generate_error', message: 'provider 500' })
        )
        expect(ports.turnStore.markAborted).not.toHaveBeenCalled()
    })
})

describe('runOneShotTurn → quota gate', () => {
    function makeQuotaStore(overrides: Partial<QuotaStore> = {}): QuotaStore {
        return {
            check: vi.fn().mockResolvedValue({
                ceilings: {},
                used: { tokensIn: 0, tokensOut: 0, calls: 0, usdMicro: 0 },
                windowEnd: new Date('2026-05-20T00:00:00.000Z'),
            }),
            record: vi.fn().mockResolvedValue(undefined),
            ...overrides,
        }
    }

    it('throws AiQuotaDeniedError when the pre-call check trips a ceiling', async () => {
        const quotaStore = makeQuotaStore({
            check: vi.fn().mockResolvedValue({
                ceilings: { maxTokensIn: 100 },
                used: { tokensIn: 150, tokensOut: 0, calls: 0, usdMicro: 0 },
                windowEnd: new Date('2026-05-20T00:00:00.000Z'),
            }),
        })

        const { AiQuotaDeniedError } = await import('./quota.js')
        await expect(
            runOneShotTurn(
                makeArgs({
                    ports: {
                        ...makePorts(),
                        clock: new FixedClock(FIXED),
                        quotaStore,
                    },
                })
            )
        ).rejects.toBeInstanceOf(AiQuotaDeniedError)

        // generateText must NOT fire when quota denied.
        expect(generateTextMock).not.toHaveBeenCalled()
    })

    it('fails open on quotaStore.check errors by default', async () => {
        const warn = vi.fn()
        const logger: Logger = {
            debug: () => {},
            info: () => {},
            warn,
            error: () => {},
        }
        const quotaStore = makeQuotaStore({
            check: vi.fn().mockRejectedValue(new Error('redis blip')),
        })

        await runOneShotTurn(
            makeArgs({
                ports: {
                    ...makePorts(),
                    clock: new FixedClock(FIXED),
                    quotaStore,
                    logger,
                },
            })
        )

        expect(generateTextMock).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls.some(([msg]) => msg.includes('failing open'))).toBe(true)
    })
})

describe('runOneShotTurn → empty-recovery', () => {
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

    it('does NOT emit turn.empty_recovery when the turn has text', async () => {
        const { sink, events } = makeTelemetry()
        const result = await runOneShotTurn(
            makeArgs({
                ports: { ...makePorts(), clock: new FixedClock(FIXED), telemetry: sink },
            })
        )

        expect(events.filter((e) => e.type === 'turn.empty_recovery')).toHaveLength(0)
        expect(events.some((e) => e.type === 'turn.finalized')).toBe(true)
        expect(result.emptyRecovery.triggered).toBe(false)
        expect(result.emptyRecovery.attempted).toBe(false)
    })

    it('emits turn.empty_recovery + telemetry-only when log_only mode + empty text + tools', async () => {
        const { sink, events } = makeTelemetry()
        generateTextMock.mockResolvedValueOnce(
            defaultPrimary({
                text: '',
                toolCalls: [{ toolName: 'lookup', toolCallId: 'c1', input: { q: 'x' } }],
                toolResults: [{ toolCallId: 'c1', output: { answered: true } }],
                usage: { inputTokens: 10, outputTokens: 0 },
                totalUsage: { inputTokens: 10, outputTokens: 0 },
            })
        )

        const result = await runOneShotTurn(
            makeArgs({
                emptyRecoveryMode: 'log_only',
                ports: { ...makePorts(), clock: new FixedClock(FIXED), telemetry: sink },
            })
        )

        // Only ONE generateText call — no synthesis when mode is log_only.
        expect(generateTextMock).toHaveBeenCalledTimes(1)
        expect(result.text).toBe('')
        expect(result.emptyRecovery).toEqual({
            triggered: true,
            attempted: false,
            mode: 'log_only',
        })

        const recovery = events.filter((e) => e.type === 'turn.empty_recovery')
        expect(recovery).toHaveLength(1)
        const evt = recovery[0] as Extract<TelemetryEvent, { type: 'turn.empty_recovery' }>
        expect(evt.decision.mode).toBe('log_only')
        expect(evt.decision.persistedErrorCode).toBe('tool_loop_no_text_logged')
    })

    it('fires a SECOND generateText call in enforce mode + appends synthesised text to result.text', async () => {
        const { sink, events } = makeTelemetry()
        const ports = makePorts()

        // Primary: empty text, one tool call, response messages present
        // so the synthesis call has the tool exchange to summarise.
        generateTextMock.mockResolvedValueOnce(
            defaultPrimary({
                text: '',
                toolCalls: [{ toolName: 'lookup', toolCallId: 'c1', input: { q: 'x' } }],
                toolResults: [{ toolCallId: 'c1', output: { answered: true } }],
                usage: { inputTokens: 100, outputTokens: 0 },
                totalUsage: { inputTokens: 100, outputTokens: 0 },
                response: {
                    messages: [
                        { role: 'assistant', content: [{ type: 'tool-call', toolName: 'lookup' }] },
                        { role: 'tool', content: [{ type: 'tool-result', toolName: 'lookup', output: { answered: true } }] },
                    ],
                },
            })
        )
        // Synthesis: produces a real summary the kernel should append.
        generateTextMock.mockResolvedValueOnce(
            defaultPrimary({
                text: 'Encontrei um resultado para você.',
                toolCalls: [],
                toolResults: [],
                usage: { inputTokens: 50, outputTokens: 12 },
                totalUsage: { inputTokens: 50, outputTokens: 12 },
                finishReason: 'stop',
            })
        )

        const result = await runOneShotTurn(
            makeArgs({
                emptyRecoveryMode: 'enforce',
                emptyRecoveryFallback: 'Desculpe, tive um problema. Pode tentar de novo?',
                ports: {
                    ...ports,
                    clock: new FixedClock(FIXED),
                    telemetry: sink,
                },
            })
        )

        // Two generateText calls — the synthesis fired.
        expect(generateTextMock).toHaveBeenCalledTimes(2)

        // Result.text contains the synthesised string (primary was empty,
        // so just the synthesis).
        expect(result.text).toBe('Encontrei um resultado para você.')
        expect(result.emptyRecovery).toEqual({
            triggered: true,
            attempted: true,
            mode: 'enforce',
        })

        // Combined token totals: 100+50 in, 0+12 out.
        expect(result.usage.tokensIn).toBe(150)
        expect(result.usage.tokensOut).toBe(12)

        // The synthesis call re-used the cached system + tools object identity
        // (so Anthropic prompt cache hits).
        const firstCall = generateTextMock.mock.calls[0]?.[0] as {
            system?: unknown
            tools?: unknown
        }
        const synthCall = generateTextMock.mock.calls[1]?.[0] as {
            system?: unknown
            tools?: unknown
            toolChoice?: unknown
            stopWhen?: unknown
            messages?: Array<{ role: string }>
        }
        expect(synthCall.system).toBe(firstCall.system)
        expect(synthCall.tools).toBe(firstCall.tools)
        expect(synthCall.toolChoice).toBe('none')
        expect(synthCall.stopWhen).toBeDefined()
        // Last message is the synthesis instruction (user-shaped prompt).
        expect(synthCall.messages?.at(-1)?.role).toBe('user')

        // Final upsert row carries combined totals + recovery metadata.
        const upsertCalls = (ports.turnStore.upsert as ReturnType<typeof vi.fn>).mock.calls
        const finalRow = upsertCalls.at(-1)?.[0] as {
            status: string
            tokensIn: number
            tokensOut: number
            content: unknown
            metadata?: Record<string, unknown>
        }
        expect(finalRow.status).toBe('completed')
        expect(finalRow.tokensIn).toBe(150)
        expect(finalRow.tokensOut).toBe(12)
        expect(finalRow.content).toBe('Encontrei um resultado para você.')
        expect(finalRow.metadata).toMatchObject({
            empty_recovery_code: 'tool_loop_no_text_recovered_fallback',
        })

        // turn.empty_recovery telemetry fired with enforce decision.
        const recovery = events.filter((e) => e.type === 'turn.empty_recovery')
        expect(recovery).toHaveLength(1)
        const evt = recovery[0] as Extract<TelemetryEvent, { type: 'turn.empty_recovery' }>
        expect(evt.decision.mode).toBe('enforce')
    })

    it('falls back to the fallback string when enforce synthesis returns empty text', async () => {
        generateTextMock.mockResolvedValueOnce(
            defaultPrimary({
                text: '',
                toolCalls: [{ toolName: 'lookup', toolCallId: 'c1', input: { q: 'x' } }],
                toolResults: [{ toolCallId: 'c1', output: { answered: true } }],
                usage: { inputTokens: 10, outputTokens: 0 },
                totalUsage: { inputTokens: 10, outputTokens: 0 },
            })
        )
        generateTextMock.mockResolvedValueOnce(
            defaultPrimary({
                text: '   ',
                toolCalls: [],
                toolResults: [],
                usage: { inputTokens: 5, outputTokens: 0 },
                totalUsage: { inputTokens: 5, outputTokens: 0 },
            })
        )

        const result = await runOneShotTurn(
            makeArgs({
                emptyRecoveryMode: 'enforce',
                emptyRecoveryFallback: 'fallback copy',
                ports: { ...makePorts(), clock: new FixedClock(FIXED) },
            })
        )
        expect(result.text).toBe('fallback copy')
        expect(result.emptyRecovery.attempted).toBe(true)
    })

    it('does nothing when emptyRecoveryMode is "off"', async () => {
        const { sink, events } = makeTelemetry()
        generateTextMock.mockResolvedValueOnce(
            defaultPrimary({
                text: '',
                toolCalls: [{ toolName: 'lookup', toolCallId: 'c1', input: { q: 'x' } }],
                toolResults: [{ toolCallId: 'c1', output: { answered: true } }],
                usage: { inputTokens: 10, outputTokens: 0 },
                totalUsage: { inputTokens: 10, outputTokens: 0 },
            })
        )

        const result = await runOneShotTurn(
            makeArgs({
                emptyRecoveryMode: 'off',
                ports: { ...makePorts(), clock: new FixedClock(FIXED), telemetry: sink },
            })
        )

        expect(generateTextMock).toHaveBeenCalledTimes(1)
        expect(events.filter((e) => e.type === 'turn.empty_recovery')).toHaveLength(0)
        expect(result.emptyRecovery.triggered).toBe(false)
        expect(result.emptyRecovery.attempted).toBe(false)
    })

    it('recovers gracefully when the enforce synthesis call itself throws', async () => {
        generateTextMock.mockResolvedValueOnce(
            defaultPrimary({
                text: '',
                toolCalls: [{ toolName: 'lookup', toolCallId: 'c1', input: { q: 'x' } }],
                toolResults: [{ toolCallId: 'c1', output: { answered: true } }],
                usage: { inputTokens: 10, outputTokens: 0 },
                totalUsage: { inputTokens: 10, outputTokens: 0 },
            })
        )
        generateTextMock.mockRejectedValueOnce(new Error('synthesis 503'))

        const errorLog = vi.fn()
        const logger: Logger = {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: errorLog,
        }
        const result = await runOneShotTurn(
            makeArgs({
                emptyRecoveryMode: 'enforce',
                emptyRecoveryFallback: 'safety-net copy',
                ports: {
                    ...makePorts(),
                    clock: new FixedClock(FIXED),
                    logger,
                },
            })
        )

        // The primary turn still succeeds; synthesis failure logged.
        expect(result.text).toBe('safety-net copy')
        expect(result.emptyRecovery.attempted).toBe(true)
        expect(
            errorLog.mock.calls.some(([msg]) =>
                typeof msg === 'string' && msg.includes('synthesis call failed')
            )
        ).toBe(true)
    })
})

describe('runOneShotTurn → cost + telemetry', () => {
    it('emits a turn.finalized event with combined usage when synthesis fires', async () => {
        const events: TelemetryEvent[] = []
        const sink: TelemetrySink = {
            emit: async (batch) => {
                events.push(...batch)
            },
        }

        generateTextMock.mockResolvedValueOnce(
            defaultPrimary({
                text: '',
                toolCalls: [{ toolName: 'lookup', toolCallId: 'c1', input: { q: 'x' } }],
                toolResults: [{ toolCallId: 'c1', output: { answered: true } }],
                usage: { inputTokens: 80, outputTokens: 0 },
                totalUsage: { inputTokens: 80, outputTokens: 0 },
            })
        )
        generateTextMock.mockResolvedValueOnce(
            defaultPrimary({
                text: 'Synthesised summary.',
                toolCalls: [],
                toolResults: [],
                usage: { inputTokens: 40, outputTokens: 10 },
                totalUsage: { inputTokens: 40, outputTokens: 10 },
            })
        )

        await runOneShotTurn(
            makeArgs({
                emptyRecoveryMode: 'enforce',
                emptyRecoveryFallback: 'safety',
                ports: { ...makePorts(), clock: new FixedClock(FIXED), telemetry: sink },
            })
        )

        const finalised = events.filter((e) => e.type === 'turn.finalized')
        expect(finalised).toHaveLength(1)
        const evt = finalised[0] as Extract<TelemetryEvent, { type: 'turn.finalized' }>
        expect(evt.tokensIn).toBe(120)
        expect(evt.tokensOut).toBe(10)
    })
})
