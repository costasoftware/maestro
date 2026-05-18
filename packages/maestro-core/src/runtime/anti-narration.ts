/**
 * Anti-narration system-prompt fragment.
 *
 * Anthropic models sometimes emit BOTH structured `tool_use` blocks
 * AND a prose narration of the same call using the legacy
 * `<function_calls>` / `<invoke>` XML format from their training
 * corpus. Tools execute correctly either way — the AI SDK only acts
 * on the structured blocks — but the XML leaks into the user-visible
 * answer and the chat bubble looks broken.
 *
 * The default behaviour can be suppressed by an explicit instruction
 * in the system prompt. Compose this fragment into your
 * `systemPrompt.static`:
 *
 *   ```ts
 *   import { antiToolNarrationRule } from 'maestro-core/runtime'
 *
 *   runChatTurn({
 *     systemPrompt: {
 *       static: `${persona}\n\n${antiToolNarrationRule()}\n\n${corpus}`,
 *     },
 *     // ...
 *   })
 *   ```
 *
 * Hosts that already have a long multi-segment system prompt with
 * explicit guidance on tool/UI rendering (barbeiro's legacy route,
 * for example) often don't need this — the existing prose pre-empts
 * the narration bias. Short prompts (the common case when extracting
 * a kernel) re-surface it.
 *
 * Two shapes are exported:
 *   - `antiToolNarrationRule()` — function form, future-proof for
 *     locale-aware or stricter variants. Use this.
 *   - `ANTI_TOOL_NARRATION_RULE` — bare constant, same content. Kept
 *     for backwards-compat with consumers who prefer string literals.
 *
 * See [[ai_sdk_tools_function_calls_xml_in_prose]] memory note for
 * the full three-trap catalog (system position, stopWhen, narration).
 */

const RULE =
    'When you call tools, do NOT narrate the call or include any ' +
    '`<function_calls>`, `<invoke>`, or similar XML in your text ' +
    'output. The tool runs structurally; your reply must contain ' +
    'only the natural-language answer derived from the tool ' +
    'results. Never repeat the tool name, parameters, or any XML ' +
    'markup in prose.'

/**
 * Returns the anti-narration instruction string. Function form so
 * future variants (locale-specific copy, stricter wording for
 * jailbreak-resistant deployments) can be added without breaking
 * the call signature.
 */
export function antiToolNarrationRule(): string {
    return RULE
}

/**
 * Bare constant form of the same instruction. Same content as
 * `antiToolNarrationRule()`. Kept for inline template-literal use.
 */
export const ANTI_TOOL_NARRATION_RULE = RULE
