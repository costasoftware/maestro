import { describe, expect, it } from 'vitest'

import { ANTI_TOOL_NARRATION_RULE } from './anti-narration.js'

describe('ANTI_TOOL_NARRATION_RULE', () => {
    it('explicitly forbids the XML tokens that models leak', () => {
        // The model leaks specifically `<function_calls>` and
        // `<invoke>`. The rule must mention both by name so the
        // instruction is unambiguous.
        expect(ANTI_TOOL_NARRATION_RULE).toContain('<function_calls>')
        expect(ANTI_TOOL_NARRATION_RULE).toContain('<invoke>')
    })

    it('tells the model the tool runs structurally', () => {
        // Sets the model's expectation that the call has ALREADY been
        // emitted via the structured tool_use protocol — no need to
        // also narrate.
        expect(ANTI_TOOL_NARRATION_RULE.toLowerCase()).toContain('structurally')
    })

    it('is one self-contained line of guidance, not a paragraph', () => {
        // Composability matters — hosts splice this into their prompt.
        // Newlines would force the host to think about formatting; keep
        // it inline.
        expect(ANTI_TOOL_NARRATION_RULE).not.toContain('\n')
    })
})
