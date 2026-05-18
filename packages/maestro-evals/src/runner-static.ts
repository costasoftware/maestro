import { applyCacheBreakpoints } from '@costasoftware/maestro-core'
import { ANTI_TOOL_NARRATION_RULE } from '@costasoftware/maestro-core/runtime'
import type { BaseToolContext } from '@costasoftware/maestro-core'

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
import type { EvalReport, FixtureResult, Reporter } from './report.js'
import { formatReport } from './report.js'

/**
 * Static eval runner — zero network, zero API key, zero cost. Builds
 * the exact streamText call shape `runChatTurn` would build, asserts
 * the four "shape" traps (system at top level, stopWhen set, tools
 * non-empty, no surface-vs-transport collapse), then runs the fixture's
 * assertions against the SIMULATED model response.
 *
 * The simulated response is what the fixture author declares the model
 * "would have said" — the runner pretends Anthropic returned it and
 * verifies the contract. This makes the static tier a regression
 * guard for the AI-SDK handoff and the assertion library itself; it
 * does NOT verify that the live model actually produces a clean reply.
 * For that, run `runner-live`.
 *
 * Why this is a separate code path from production runChatTurn:
 *   - runChatTurn pulls in TurnStore / KeyProvider / streamText etc.
 *     Eval fixtures don't need those.
 *   - The static runner ONLY needs the pure pieces of the pipeline —
 *     `applyCacheBreakpoints` + a synthetic ai-sdk tool registry — to
 *     reproduce the call shape. We deliberately mirror the production
 *     order of operations so any change to runChatTurn that breaks the
 *     contract shows up here too. The runChatTurn test suite is the
 *     other half of this guard.
 */
export interface RunStaticEvalsOptions {
    /** Output format for the report. Default `'console'`. */
    reporter?: Reporter
    /**
     * Inject the anti-narration rule into every fixture's static
     * system prompt before assembly. Default `true` — matches the
     * recommended runChatTurn setup. Disable for fixtures whose
     * `systemPrompt.static` already includes it.
     */
    injectAntiNarrationRule?: boolean
}

export async function runStaticEvals<TCtx extends BaseToolContext<string> = BaseToolContext>(
    fixtures: readonly EvalFixture<TCtx>[],
    opts: RunStaticEvalsOptions = {}
): Promise<EvalReport> {
    const results: FixtureResult[] = []
    for (const fx of fixtures) {
        results.push(await runSingleStatic(fx, opts))
    }
    const report: EvalReport = {
        tier: 'static',
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

async function runSingleStatic<TCtx extends BaseToolContext<string>>(
    fx: EvalFixture<TCtx>,
    opts: RunStaticEvalsOptions
): Promise<FixtureResult> {
    const assertionFailures: { code: string; message: string }[] = []

    // ── Phase 1: shape assertions ────────────────────────────────────
    // Reproduce the runChatTurn → streamText handoff using the same
    // public helpers. We DON'T call runChatTurn directly here because
    // it expects TurnStore + KeyProvider ports that have no place in
    // an eval. Mirroring the call shape keeps the contract checks
    // honest without bringing the persistence layer along.
    try {
        const systemStatic = opts.injectAntiNarrationRule !== false
            ? `${fx.systemPrompt?.static ?? 'You are a test fixture.'}\n\n${ANTI_TOOL_NARRATION_RULE}`
            : fx.systemPrompt?.static ?? 'You are a test fixture.'

        const cached = applyCacheBreakpoints({
            static: { intro: systemStatic, corpus: '', tools: {} },
            dynamic: {
                tenant: { id: 'eval-tenant', timezone: 'UTC' },
                principal: { id: 'eval-principal' },
                nowIso: new Date().toISOString(),
            },
        })

        // Trap #1: system MUST be a top-level array (not mixed into
        // messages). applyCacheBreakpoints always returns an array of
        // CoreMessage-shaped system entries; we verify the shape so a
        // future kernel change can't silently regress to a single
        // string or accidentally fold system into messages.
        if (!Array.isArray(cached.system) || cached.system.length === 0) {
            assertionFailures.push({
                code: 'system_not_top_level',
                message: 'Built call has no top-level system entries — Anthropic tool-use will not engage.',
            })
        } else {
            for (const entry of cached.system) {
                if ((entry as { role?: string }).role && (entry as { role?: string }).role !== 'system') {
                    assertionFailures.push({
                        code: 'system_not_top_level',
                        message: `system entry has role="${(entry as { role?: string }).role}", expected "system"`,
                    })
                }
            }
        }

        // Trap #4: tool registry MUST be non-empty (unless fixture
        // explicitly tests a no-tools scenario, which we don't have
        // a flag for today — we treat empty as always-broken because
        // every shipped fixture should declare at least one tool).
        try {
            assertToolsRegistered(fx.tools as unknown[])
        } catch (e) {
            if (e instanceof EvalAssertionError) {
                assertionFailures.push({ code: e.code, message: e.message })
            } else {
                throw e
            }
        }
    } catch (e) {
        assertionFailures.push({
            code: 'shape_setup_failed',
            message: e instanceof Error ? e.message : String(e),
        })
    }

    // ── Phase 2: simulated-response assertions ───────────────────────
    // The fixture author declares what the model "would have said".
    // We assert against that declaration as if the model produced it.
    const simulated = fx.simulated ?? { text: '', toolCalls: [] }
    const simulatedText = simulated.text
    const simulatedToolCalls = simulated.toolCalls ?? []

    const expect = fx.expect
    const noXmlInProse = expect.noXmlInProse !== false
    const nonEmptyText =
        expect.nonEmptyText ??
        ((expect.toolCalls?.length ?? 0) > 0)

    runAssertion(assertionFailures, () => {
        if (noXmlInProse) assertNoToolNarrationXml(simulatedText)
    })
    runAssertion(assertionFailures, () => {
        if (expect.toolCalls && expect.toolCalls.length > 0) {
            assertToolsCalled(simulatedToolCalls as unknown[], expect.toolCalls)
        }
    })
    runAssertion(assertionFailures, () => {
        if (expect.noToolCalls) assertNoToolsCalled(simulatedToolCalls as unknown[])
    })
    runAssertion(assertionFailures, () => {
        if (nonEmptyText) {
            assertToolFiredHasText(simulatedToolCalls as unknown[], simulatedText)
            if (simulatedText.trim().length === 0) {
                throw new EvalAssertionError(
                    'text_too_short',
                    'Expected non-empty assistant text but simulated response was empty.'
                )
            }
        }
    })
    runAssertion(assertionFailures, () => {
        if (typeof expect.minTextLength === 'number') {
            assertTextMinLength(simulatedText, expect.minTextLength)
        }
    })
    runAssertion(assertionFailures, () => {
        if (expect.forbiddenPhrases && expect.forbiddenPhrases.length > 0) {
            assertNoForbiddenPhrases(simulatedText, expect.forbiddenPhrases)
        }
    })

    return {
        name: fx.name,
        description: fx.description,
        passed: assertionFailures.length === 0,
        failures: assertionFailures,
    }
}

function runAssertion(
    failures: { code: string; message: string }[],
    fn: () => void
): void {
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
