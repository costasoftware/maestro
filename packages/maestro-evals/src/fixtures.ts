import type { AgentToolDefinition, BaseToolContext } from 'maestro-core'

/**
 * Shape of an expected tool-call invocation as it appears in the
 * simulated `streamText` response under the static runner. Drives
 * what the mock returns AND what `runStaticEvals` asserts after the
 * fact — keeping the two in lockstep means the mock can never lie
 * about what the model did.
 */
export interface ExpectedToolCall {
    /** Tool name that should be invoked. */
    name: string
    /**
     * Stand-in result the mock returns from `execute`. Static evals
     * never actually call the tool body — the mock short-circuits
     * with whatever you put here so the assertion under test is the
     * streamText handoff, not the tool implementation. Defaults to
     * `{ ok: true, data: {} }` shape.
     */
    mockOutput?: unknown
}

/**
 * What an eval fixture asserts about the model's output for one
 * golden prompt. Every flag here maps to a specific Anthropic
 * tool-calling trap. See README for the trap → assertion table.
 */
export interface EvalExpectations {
    /**
     * Names of tools that MUST be invoked. Empty array (default)
     * means no expectation either way; use `expect.noToolCalls: true`
     * to assert NO tools were called (refusal fixtures).
     */
    toolCalls?: readonly string[]
    /**
     * Assert NO tools were called. Mutually exclusive with
     * `toolCalls` having entries — refusal-style fixtures only.
     */
    noToolCalls?: boolean
    /**
     * When true (default), the final assistant text MUST contain
     * none of `<function_calls>`, `<invoke>`, etc. Set false ONLY
     * for fixtures that are intentionally testing legacy-XML
     * handling and you know what you're doing.
     */
    noXmlInProse?: boolean
    /**
     * When true (default whenever `toolCalls` is non-empty), the
     * final text MUST be non-empty after trimming. Catches the
     * missing-`stopWhen` trap.
     */
    nonEmptyText?: boolean
    /**
     * Minimum trimmed text length. Useful for refusal fixtures that
     * need to actually explain the refusal, not just say "no".
     */
    minTextLength?: number
    /**
     * Substring blacklist. Each entry causes a failure when it
     * appears in the final text. Substring match, not regex.
     */
    forbiddenPhrases?: readonly string[]
}

/**
 * A complete eval fixture — one prompt, its tool set, and the
 * contract its result must satisfy.
 *
 * Fixtures are TypeScript modules (not JSON) so they can hold real
 * `AgentToolDefinition` objects with closures, zod schemas, and
 * imports. Authoring a fixture is the same shape as authoring a
 * `maestro-core` tool, just with a static `mockOutput` for offline
 * runs.
 */
export interface EvalFixture<TCtx extends BaseToolContext<string> = BaseToolContext> {
    /**
     * Stable identifier. Used as the row key in reports and as the
     * dedup key when loading the same file twice. Conventionally
     * kebab-case matching the file basename.
     */
    name: string
    /** Free-form one-line description for the report header. */
    description?: string
    /**
     * The user message that drives the turn. Single string for now —
     * multi-turn fixtures are a future extension.
     */
    prompt: string
    /**
     * Tool registry exposed to the model. Same shape as what a host
     * would build in production. The static runner mocks each tool's
     * `execute` with the matching `ExpectedToolCall.mockOutput`; the
     * live runner runs the real body so any side effects must be safe.
     *
     * Typed with `any, any` in the input/output slots (matching
     * maestro-core's `BuildAiSdkToolsArgs.registry`) so heterogeneous
     * tool arrays unify — without it, TS rejects every multi-tool
     * fixture because `AgentToolDefinition` is invariant in its
     * input/output schemas.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: readonly AgentToolDefinition<any, any, TCtx>[]
    /** Optional per-fixture system prompt override. */
    systemPrompt?: { static: string; dynamic?: string }
    /**
     * What the static runner should pretend Anthropic returned. The
     * tool-call shapes here are what the assertions check against.
     * The live runner ignores this entirely — it asserts against
     * whatever the real model produced.
     */
    simulated?: {
        text: string
        toolCalls?: readonly ExpectedToolCall[]
    }
    /** The contract. See `EvalExpectations`. */
    expect: EvalExpectations
}

/**
 * Container shape for a set of fixtures. The CLI loader normalises
 * a glob match into this shape; programmatic callers can build one
 * by hand and hand it to the runners directly.
 */
export interface FixtureSet<TCtx extends BaseToolContext<string> = BaseToolContext> {
    fixtures: readonly EvalFixture<TCtx>[]
}

/**
 * Loose duck-type — a fixture file's default export. Accepts either
 * a single fixture or an array. The loader normalises both.
 */
export type FixtureModuleExport<TCtx extends BaseToolContext<string> = BaseToolContext> =
    | EvalFixture<TCtx>
    | readonly EvalFixture<TCtx>[]

/**
 * Lift a heterogeneous module shape into a flat fixture list. Pure;
 * the file-system glob piece lives in `cli.ts` to keep this module
 * Node-free for browser-side test harnesses.
 */
export function normaliseFixtureModule<TCtx extends BaseToolContext<string>>(
    mod: FixtureModuleExport<TCtx>
): readonly EvalFixture<TCtx>[] {
    return Array.isArray(mod) ? mod : [mod as EvalFixture<TCtx>]
}
