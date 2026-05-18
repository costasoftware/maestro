import { createAnthropic } from '@ai-sdk/anthropic'
import { stepCountIs, streamText, tool, type ToolSet } from 'ai'
import { applyCacheBreakpoints } from '@maestro/core'
import { ANTI_TOOL_NARRATION_RULE } from '@maestro/core/runtime'
import type { AnyAgentToolDefinition, BaseToolContext } from '@maestro/core'

import {
    assertNoForbiddenPhrases,
    assertNoToolNarrationXml,
    assertNoToolsCalled,
    assertTextMinLength,
    assertToolFiredHasText,
    assertToolsCalled,
    assertToolsRegistered,
    EvalAssertionError,
} from './assertions.js'
import type { EvalFixture } from './fixtures.js'
import type { EvalReport, FixtureFailure, FixtureResult, Reporter } from './report.js'
import { formatReport } from './report.js'

/**
 * Live eval runner — hits the real Anthropic API with the fixture's
 * tools and asserts against the model's actual output. Use this in
 * scheduled CI + before releases. Static evals catch the call-shape
 * traps; live evals catch the cases where the call shape is right but
 * the model misbehaves anyway (narration leak, refusal collapse,
 * tool-result hallucination).
 *
 * Cost: a single fixture against claude-haiku-4-5 is roughly
 * $0.001 — 5–10 fixtures per run is in the noise. NOT designed for
 * per-commit CI. Document the scheduled cadence in your repo.
 *
 * Implementation note: this deliberately mirrors the production
 * runChatTurn streamText setup (system top-level, stopWhen set,
 * anti-narration injected) instead of calling runChatTurn. The
 * eval is verifying the contract holds end-to-end against the live
 * API; reusing runChatTurn would only verify that runChatTurn calls
 * itself, and would force fixtures to provide TurnStore /
 * KeyProvider ports for no real benefit.
 */
export interface RunLiveEvalsOptions {
    /** Anthropic API key. Required. */
    anthropicApiKey: string
    /**
     * Model id. Defaults to claude-haiku-4-5 for cost. Override for
     * release-gate runs that should also check sonnet.
     */
    model?: string
    /** Reporter format. Default `'console'`. */
    reporter?: Reporter
    /**
     * Inject the anti-narration rule (default `true`). Match this to
     * how the host invokes runChatTurn — if the host doesn't inject
     * the rule in prod, the eval shouldn't either.
     */
    injectAntiNarrationRule?: boolean
    /**
     * Max tool-use steps. Default `5`, same as runChatTurn default.
     */
    maxSteps?: number
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

export async function runLiveEvals<TCtx extends BaseToolContext<string> = BaseToolContext>(
    fixtures: readonly EvalFixture<TCtx>[],
    opts: RunLiveEvalsOptions
): Promise<EvalReport> {
    if (!opts.anthropicApiKey) {
        throw new Error(
            'runLiveEvals requires opts.anthropicApiKey. The live tier hits real Anthropic — there is no key-less fallback. Use runStaticEvals for keyless CI.'
        )
    }

    const modelId = opts.model ?? DEFAULT_MODEL
    const anthropic = createAnthropic({ apiKey: opts.anthropicApiKey })
    const model = anthropic(modelId)

    const results: FixtureResult[] = []
    for (const fx of fixtures) {
        results.push(await runSingleLive(fx, model, modelId, opts))
    }

    const report: EvalReport = {
        tier: 'live',
        startedAt: new Date(),
        results,
        passed: results.every((r) => r.passed),
    }
    const formatted = formatReport(report, opts.reporter ?? 'console')
    if (formatted) {
        // eslint-disable-next-line no-console
        console.log(formatted)
    }
    return report
}

async function runSingleLive<TCtx extends BaseToolContext<string>>(
    fx: EvalFixture<TCtx>,
    model: unknown,
    modelId: string,
    opts: RunLiveEvalsOptions
): Promise<FixtureResult> {
    const failures: FixtureFailure[] = []
    const startedAt = Date.now()

    // ── Shape guard (cheap, fail-fast before spending tokens) ────────
    try {
        assertToolsRegistered(fx.tools as unknown[])
    } catch (e) {
        if (e instanceof EvalAssertionError) {
            failures.push({ code: e.code, message: e.message })
            return {
                name: fx.name,
                description: fx.description,
                passed: false,
                failures,
                durationMs: Date.now() - startedAt,
                modelId,
            }
        }
        throw e
    }

    // Build the same system + tools handoff runChatTurn would build.
    const systemStatic = opts.injectAntiNarrationRule !== false
        ? `${fx.systemPrompt?.static ?? 'You are a helpful assistant for an eval fixture.'}\n\n${ANTI_TOOL_NARRATION_RULE}`
        : fx.systemPrompt?.static ?? 'You are a helpful assistant for an eval fixture.'

    const aiSdkTools = buildLiveToolset(fx.tools as unknown as readonly AnyAgentToolDefinition[])

    const cached = applyCacheBreakpoints({
        static: { intro: systemStatic, corpus: '', tools: aiSdkTools },
        dynamic: {
            tenant: { id: 'eval-tenant', timezone: 'UTC' },
            principal: { id: 'eval-principal' },
            nowIso: new Date().toISOString(),
        },
    })

    let finalText = ''
    const toolCallNames: string[] = []
    let tokensIn = 0
    let tokensOut = 0

    try {
        // streamText accepts ModelMessage directly via `messages`; for
        // a single-turn fixture there's no need to round-trip through
        // UIMessage conversion. Synthetic message id is irrelevant.
        const stream = streamText({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            model: model as any,
            system: cached.system,
            messages: [
                {
                    role: 'user' as const,
                    content: fx.prompt,
                },
            ],
            tools: cached.tools,
            // CRITICAL: never let stopWhen default to stepCountIs(1) —
            // trap #2. Even an eval needs the tool-result follow-up
            // step so we observe the final user-visible text.
            stopWhen: stepCountIs(opts.maxSteps ?? 5),
            onFinish: (event) => {
                finalText = typeof event.text === 'string' ? event.text : ''
                const tcs = Array.isArray((event as { toolCalls?: unknown }).toolCalls)
                    ? (event as { toolCalls: unknown[] }).toolCalls
                    : []
                for (const tc of tcs) {
                    const name =
                        tc && typeof tc === 'object' && 'toolName' in tc
                            ? String((tc as { toolName: unknown }).toolName)
                            : undefined
                    if (name) toolCallNames.push(name)
                }
                const usage = (event.usage ?? null) as {
                    inputTokens?: number
                    outputTokens?: number
                } | null
                tokensIn = usage?.inputTokens ?? 0
                tokensOut = usage?.outputTokens ?? 0
            },
        })
        // Drain the stream so onFinish runs.
        for await (const _chunk of stream.fullStream) {
            void _chunk
        }
    } catch (e) {
        failures.push({
            code: 'stream_error',
            message: e instanceof Error ? e.message : String(e),
        })
        return {
            name: fx.name,
            description: fx.description,
            passed: false,
            failures,
            durationMs: Date.now() - startedAt,
            modelId,
            tokensIn,
            tokensOut,
        }
    }

    // ── Fixture-level assertions ────────────────────────────────────
    const expect = fx.expect
    const noXmlInProse = expect.noXmlInProse !== false
    const nonEmptyText =
        expect.nonEmptyText ?? ((expect.toolCalls?.length ?? 0) > 0)

    runAssertion(failures, () => {
        if (noXmlInProse) assertNoToolNarrationXml(finalText)
    })
    runAssertion(failures, () => {
        if (expect.toolCalls && expect.toolCalls.length > 0) {
            assertToolsCalled(toolCallNames, expect.toolCalls)
        }
    })
    runAssertion(failures, () => {
        if (expect.noToolCalls) assertNoToolsCalled(toolCallNames)
    })
    runAssertion(failures, () => {
        if (nonEmptyText) {
            assertToolFiredHasText(toolCallNames, finalText)
            if (finalText.trim().length === 0) {
                throw new EvalAssertionError(
                    'text_too_short',
                    'Live model returned empty assistant text.'
                )
            }
        }
    })
    runAssertion(failures, () => {
        if (typeof expect.minTextLength === 'number') {
            assertTextMinLength(finalText, expect.minTextLength)
        }
    })
    runAssertion(failures, () => {
        if (expect.forbiddenPhrases && expect.forbiddenPhrases.length > 0) {
            assertNoForbiddenPhrases(finalText, expect.forbiddenPhrases)
        }
    })

    return {
        name: fx.name,
        description: fx.description,
        passed: failures.length === 0,
        failures,
        durationMs: Date.now() - startedAt,
        modelId,
        tokensIn,
        tokensOut,
    }
}

/**
 * Build an AI-SDK-shaped tool registry from a fixture's tools. We
 * don't reuse @maestro/core's `buildAiSdkTools` because that helper
 * pulls in the audit / clock / exception ports that have no place
 * in an eval. Each tool's `execute` is invoked with a synthetic
 * context that satisfies the BaseToolContext interface so the body
 * runs without surprises if the fixture's tool reads `ctx`.
 */
function buildLiveToolset(defs: readonly AnyAgentToolDefinition[]): ToolSet {
    // AI SDK's `tool()` factory is invariant in its input/output
    // generic params (`Tool<TInput, TOutput>`). A heterogeneous
    // registry can't be widened cleanly, so we build the record as
    // `unknown` and cast at the return boundary. The runtime shape
    // is correct; the cast only loosens TS variance.
    const out: Record<string, unknown> = {}
    for (const def of defs) {
        out[def.name] = tool({
            description: def.description,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            inputSchema: def.inputSchema as any,
            execute: async (input: unknown) => {
                const ctx: BaseToolContext = {
                    tenantId: 'eval-tenant',
                    principal: { id: 'eval-principal', kind: 'eval' },
                    actor: 'eval-runner',
                    transport: String(def.transports[0] ?? 'chat'),
                    locale: 'en-US',
                    timezone: 'UTC',
                    requestId: `eval_${Date.now()}`,
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return def.execute(input as any, ctx as any)
            },
        })
    }
    return out as unknown as ToolSet
}

function runAssertion(failures: FixtureFailure[], fn: () => void): void {
    try {
        fn()
    } catch (e) {
        if (e instanceof EvalAssertionError) {
            failures.push({ code: e.code, message: e.message })
        } else {
            failures.push({
                code: 'unknown',
                message: e instanceof Error ? e.message : String(e),
            })
        }
    }
}
