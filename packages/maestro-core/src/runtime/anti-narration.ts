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
 * in the system prompt. Compose this constant into your
 * `systemPrompt.static`:
 *
 *   ```ts
 *   import { ANTI_TOOL_NARRATION_RULE } from 'maestro-core/runtime'
 *
 *   runChatTurn({
 *     systemPrompt: {
 *       static: `${persona}\n\n${ANTI_TOOL_NARRATION_RULE}\n\n${corpus}`,
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
 * See [[ai_sdk_tools_function_calls_xml_in_prose]] memory note for
 * the full trap catalog.
 */
export const ANTI_TOOL_NARRATION_RULE =
    'When you call tools, do NOT narrate the call or include any ' +
    '`<function_calls>`, `<invoke>`, or similar XML in your text ' +
    'output. The tool runs structurally; your reply must contain ' +
    'only the natural-language answer derived from the tool ' +
    'results. Never repeat the tool name, parameters, or any XML ' +
    'markup in prose.'
