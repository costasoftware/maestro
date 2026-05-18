# @costasoftware/maestro-evals

Golden-prompt regression guard for [`@costasoftware/maestro-core`](https://www.npmjs.com/package/@costasoftware/maestro-core). Catches the four documented Anthropic tool-calling traps before they hit production — the ones invisible to type checks that only surface as `<function_calls>` XML in user-facing prose.

Two tiers:

| Tier | Cost | Cadence | What it catches |
| --- | --- | --- | --- |
| **Static** | $0 | Every CI run | Call-shape traps + fixture contract checks against a declared simulated response |
| **Live** | ~$0.001 / fixture on haiku | Scheduled + pre-release | Same checks, but against real Anthropic output |

## Why this exists

Over a single week of `@costasoftware/maestro-core` development we burned multiple sessions diagnosing the same prod incident in four different forms. All four are individually invisible to TypeScript:

| Trap | Symptom | Assertion that catches it |
| --- | --- | --- |
| 1. `system` mixed into `messages` | Model emits `<function_calls>` XML in prose | `assertNoToolNarrationXml` + shape-phase top-level-system check |
| 2. Missing `stopWhen` | Tool fires, bubble ends with no text | `assertToolFiredHasText` |
| 3. Anti-narration rule missing | Both real tool_use AND XML in prose | `assertNoToolNarrationXml` |
| 4. Tool registry resolves empty (surface-vs-transport drift) | Anthropic gets `tools: {}` → narrates from training corpus | `assertToolsRegistered` |

A 30-second smoke eval would have caught any of them.

## Install

```bash
pnpm add -D @costasoftware/maestro-evals
```

Peer deps: `@costasoftware/maestro-core ^1.0.0`, `ai ^6.0.0`, `zod ^3.25.0`. For live mode, also `@ai-sdk/anthropic ^3.0.0` and `ANTHROPIC_API_KEY`.

## Author a fixture

A fixture is a TypeScript module with a default export — same authoring shape as a `@costasoftware/maestro-core` tool:

```ts
// fixtures/basic-tool-call.fixture.ts
import { defineAgentTool, ok } from '@costasoftware/maestro-core'
import { z } from 'zod'
import type { EvalFixture } from '@costasoftware/maestro-evals'

const lookupBooking = defineAgentTool({
    name: 'lookupBooking',
    description: 'Look up a booking by reference.',
    transports: ['chat'],
    inputSchema: z.object({ ref: z.string() }),
    execute: async ({ ref }) => ok({ ref, status: 'confirmed' }),
})

const fixture: EvalFixture = {
    name: 'basic-tool-call',
    prompt: 'Check booking B-1234.',
    tools: [lookupBooking],
    simulated: {
        text: 'Booking B-1234 is confirmed.',
        toolCalls: [{ name: 'lookupBooking' }],
    },
    expect: {
        toolCalls: ['lookupBooking'],
        noXmlInProse: true,
        nonEmptyText: true,
    },
}

export default fixture
```

The `simulated` block is the model's "declared" response — the **static** runner asserts against that as if Anthropic returned it. The **live** runner ignores `simulated` and asserts against the real reply.

## Run

### Static (every CI)

```bash
maestro-evals run --dir ./fixtures
```

Exits non-zero on any fixture failure. No API key required.

### Live (scheduled + pre-release)

```bash
ANTHROPIC_API_KEY=sk-... maestro-evals run --dir ./fixtures --live
```

Defaults to `claude-haiku-4-5-20251001` for cost. Override with `--model`.

### Reporter formats

```bash
maestro-evals run --reporter json
maestro-evals run --reporter tap
maestro-evals run --reporter console   # default
```

## Programmatic use

```ts
import { runStaticEvals, runLiveEvals, type EvalFixture } from '@costasoftware/maestro-evals'
import myFixture from './fixtures/basic-tool-call.fixture.js'

const fixtures: EvalFixture[] = [myFixture]

// In CI:
const staticReport = await runStaticEvals(fixtures)
if (!staticReport.passed) process.exit(1)

// In a release-gate job:
const liveReport = await runLiveEvals(fixtures, {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-haiku-4-5-20251001',
})
if (!liveReport.passed) process.exit(1)
```

## Assertion library

Reusable outside the runners — pure functions, no AI SDK dependency:

```ts
import {
    assertNoToolNarrationXml,
    assertToolFiredHasText,
    assertToolsRegistered,
    assertToolsCalled,
    assertNoToolsCalled,
    assertTextMinLength,
    assertNoForbiddenPhrases,
    EvalAssertionError,
    TOOL_NARRATION_XML_TOKENS,
} from '@costasoftware/maestro-evals/assertions'
```

Each helper throws `EvalAssertionError` with a stable `.code` (`xml_in_prose`, `tool_fired_no_text`, `empty_tool_registry`, etc.) so callers can group / filter without parsing messages.

## CI wiring (GitHub Actions)

```yaml
# .github/workflows/evals.yml
name: evals

on:
  pull_request:
  schedule:
    - cron: '0 14 * * 1'   # Monday 14:00 UTC

jobs:
  static:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter your-app build
      - run: npx maestro-evals run --dir ./dist/fixtures

  live:
    if: github.event_name == 'schedule' || contains(github.event.pull_request.labels.*.name, 'release-gate')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter your-app build
      - run: npx maestro-evals run --dir ./dist/fixtures --live --reporter tap
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`static` runs on every PR. `live` runs on the weekly schedule plus PRs tagged `release-gate`.

## Sample report

```
maestro-evals (static)  2026-05-18T15:02:11.123Z
─────────────────────────────────────────────────
  PASS  basic-tool-call
        Single-tool happy path — user asks for a booking, model invokes lookup and summarises.
  PASS  refusal
        Off-scope ask — model should refuse politely without inventing a tool call.
  FAIL  multi-tool
        Two sequential tool calls — find customer, then list their bookings.
        ✗ missing_tool_call: Expected tool "listBookings" to be called but it was not. Actually called: [findCustomer].

Summary: 2/3 passed
```

## Limitations

- **Single-turn only** today. Multi-turn fixtures (assistant + user + assistant) are a future extension.
- **No streaming-shape assertions**. We assert the finalised text + tool-calls; mid-stream delta shape is not checked.
- **Static fixtures don't catch model-specific narration leaks**. That's the point of running live evals on a schedule.
- **The static runner does not invoke `runChatTurn` directly**. It mirrors the `applyCacheBreakpoints` + tool-registry handoff so any change to runChatTurn that breaks the call-shape contract surfaces here. `runChatTurn` has its own regression suite in `@costasoftware/maestro-core` covering the per-turn lifecycle.

## License

Apache-2.0
