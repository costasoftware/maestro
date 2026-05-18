/**
 * Pure assertion primitives shared by every eval runner.
 *
 * Each function maps to a documented Anthropic tool-calling trap from
 * the `maestro-core` README. Assertions throw `EvalAssertionError` on
 * failure — the runner catches and packages them into the report.
 *
 * The functions are pure and dependency-free so they can be reused
 * outside the eval harness (custom integration tests, replay tooling,
 * one-off scripts). Nothing here imports `maestro-core` directly.
 *
 * See [[ai_sdk_tools_function_calls_xml_in_prose]] for the failure
 * mode catalog these guard against.
 */

/**
 * Thrown by every `assert*` helper on failure. Carries a stable
 * `code` so the runner can group / filter without parsing messages.
 */
export class EvalAssertionError extends Error {
    constructor(
        public readonly code: EvalAssertionCode,
        message: string,
        public readonly details?: Record<string, unknown>
    ) {
        super(message)
        this.name = 'EvalAssertionError'
    }
}

export type EvalAssertionCode =
    | 'xml_in_prose'
    | 'tool_fired_no_text'
    | 'empty_tool_registry'
    | 'missing_tool_call'
    | 'unexpected_tool_call'
    | 'text_too_short'
    | 'forbidden_phrase'

/**
 * The legacy Anthropic tool-call XML tokens. Anything containing
 * either of these substrings in the final assistant prose means
 * the model fell back to its pre-tool-use training corpus — one of
 * traps #1 (system mixed into messages), #3 (anti-narration off),
 * or #4 (empty tool registry) is firing.
 *
 * Exported so callers can compose their own regexes / lint rules.
 */
export const TOOL_NARRATION_XML_TOKENS = [
    '<function_calls>',
    '<invoke>',
    '</invoke>',
    '</function_calls>',
] as const

/**
 * Asserts the model's final text does NOT contain any of the
 * legacy `<function_calls>` / `<invoke>` XML tokens.
 *
 * Guards traps #1 (system position), #3 (anti-narration), #4
 * (empty registry). All three surface as the same symptom.
 */
export function assertNoToolNarrationXml(text: string): void {
    for (const token of TOOL_NARRATION_XML_TOKENS) {
        if (text.includes(token)) {
            throw new EvalAssertionError(
                'xml_in_prose',
                `Assistant text contains legacy tool-call XML token "${token}". This means Anthropic fell back to its pre-tool-use training corpus — check (a) system passed at top level, (b) anti-narration rule in system prompt, (c) tool registry non-empty.`,
                { token, textSample: text.slice(0, 200) }
            )
        }
    }
}

/**
 * Asserts that when the turn invoked at least one tool, the
 * assistant text is non-empty. The classic "tool fired but the
 * bubble ends with no answer" failure mode — trap #2 (default
 * `stopWhen: stepCountIs(1)` means the tool-result follow-up
 * step never runs).
 *
 * `toolCalls` is typed as `unknown[]` so the helper accepts any
 * shape (AI SDK `ToolCallPart`, kernel-internal shapes, fixture
 * stand-ins). Only `length` is consulted.
 */
export function assertToolFiredHasText(toolCalls: unknown[], text: string): void {
    if (toolCalls.length > 0 && text.trim().length === 0) {
        throw new EvalAssertionError(
            'tool_fired_no_text',
            `Assistant invoked ${toolCalls.length} tool(s) but produced zero user-visible text. Likely missing or wrong \`stopWhen\` — AI SDK defaults to \`stepCountIs(1)\` and never re-prompts with the tool result.`,
            { toolCallCount: toolCalls.length }
        )
    }
}

/**
 * Asserts the tool registry that was registered with the model is
 * non-empty. Empty registry → Anthropic receives `tools: {}` → model
 * narrates from its training corpus instead of issuing real tool
 * calls. Trap #4.
 *
 * Most often hit by the surface-vs-transport drift documented in the
 * `help_chat_surface_vs_transport` memory note — a `HelpSurface` value
 * passed where a `ToolTransport` was expected silently drops every
 * tool from the filter.
 */
export function assertToolsRegistered(tools: unknown[]): void {
    if (tools.length === 0) {
        throw new EvalAssertionError(
            'empty_tool_registry',
            'Tool registry is empty — model will be given `tools: {}` and likely emit <function_calls> XML in prose. Check eligibility filter (transport / actor / isAvailable) and the surface→transport translation at the call site.'
        )
    }
}

/**
 * Asserts every name in `expectedNames` appears in `toolCalls`.
 *
 * `toolCalls` is duck-typed: each element MAY expose `toolName`,
 * `name`, or be a bare string. The helper accepts any of those so it
 * works against AI SDK v6 (`toolName`), legacy v4 (`name`), and the
 * mock shapes used by `runner-static`.
 */
export function assertToolsCalled(
    toolCalls: unknown[],
    expectedNames: readonly string[]
): void {
    const calledNames = toolCalls.map(extractToolName).filter((n): n is string => n !== null)
    for (const expected of expectedNames) {
        if (!calledNames.includes(expected)) {
            throw new EvalAssertionError(
                'missing_tool_call',
                `Expected tool "${expected}" to be called but it was not. Actually called: [${calledNames.join(', ') || '(none)'}].`,
                { expected, actuallyCalled: calledNames }
            )
        }
    }
}

/**
 * Asserts NO unexpected tool calls fired. Useful for refusal
 * fixtures — an off-scope prompt should produce a polite reply
 * with zero tool invocations.
 */
export function assertNoToolsCalled(toolCalls: unknown[]): void {
    if (toolCalls.length > 0) {
        const names = toolCalls.map(extractToolName).filter((n): n is string => n !== null)
        throw new EvalAssertionError(
            'unexpected_tool_call',
            `Expected zero tool calls but ${toolCalls.length} fired: [${names.join(', ')}].`,
            { actuallyCalled: names }
        )
    }
}

/**
 * Asserts the final assistant text is at least `minLength` characters
 * (after trimming). Catches degenerate one-word replies on refusal
 * fixtures.
 */
export function assertTextMinLength(text: string, minLength: number): void {
    const len = text.trim().length
    if (len < minLength) {
        throw new EvalAssertionError(
            'text_too_short',
            `Assistant text is ${len} chars after trim; expected at least ${minLength}.`,
            { actualLength: len, minLength }
        )
    }
}

/**
 * Asserts none of the substrings in `forbidden` appear in the text.
 * Case-sensitive substring match. Use for jailbreak-style negative
 * regression (e.g. "I am a large language model").
 */
export function assertNoForbiddenPhrases(
    text: string,
    forbidden: readonly string[]
): void {
    for (const phrase of forbidden) {
        if (text.includes(phrase)) {
            throw new EvalAssertionError(
                'forbidden_phrase',
                `Assistant text contains forbidden phrase "${phrase}".`,
                { phrase }
            )
        }
    }
}

/**
 * Extract a tool name from a heterogeneous tool-call shape. Returns
 * null when the input doesn't look like a tool call at all. Kept
 * internal because the surface is intentionally tolerant — public
 * callers should stick to the `assert*` helpers above.
 */
function extractToolName(call: unknown): string | null {
    if (typeof call === 'string') return call
    if (call && typeof call === 'object') {
        const c = call as Record<string, unknown>
        if (typeof c.toolName === 'string') return c.toolName
        if (typeof c.name === 'string') return c.name
    }
    return null
}
