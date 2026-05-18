# Maestro — Design

> Status: **approved 2026-05-16**. P1 (this repo) in progress. Subsequent phases require explicit go-ahead per phase.

## TL;DR

In-process tool-calling agent runtime extracted from `barbeiro-app/lib/ai/*`. Ships as `@maestro/core` (kernel) + `@maestro/react` (UI hooks, future). Host products implement 7 ports (TurnStore, AuditStore, MemoryStore, QuotaStore, ModelKeyProvider, TelemetrySink, Clock + Logger).

Provider keys stay per-product. Tools stay in host product. Hybrid tool protocol: in-process via SDK as the fast path, MCP-over-HTTP via the same registry for external callers.

A separate `maestro-plane` (control plane = server + DB receiving async telemetry) is documented but **deferred to v1.5**. It is not built or required for v1.

## Why this exists

- Multiple SaaS products in the same portfolio need user-support chat + tool calling.
- Duplicating the runtime / quota / cost / audit / cache / model-routing machinery (~1900 LoC in barbeiro) across N products is the cost we are avoiding.
- The 102 tools in barbeiro are 95% barbeiro-domain. They stay in barbeiro. We extract the orchestration, not the tools.

## Real-problem framing

Stated: "extract AI to standalone reusable platform."

Real: prevent silent runtime drift across N products, get one cost story and one kill-switch story, keep tool definitions co-located with the data they mutate.

Counter-frame (acknowledged risk): this is borderline platform-extraction-too-early. If no sibling product ships in 6 months, this becomes gold-plating barbeiro. Mitigation: phases 1–8 + 10 are 100% reversible. Real validation = phase 11 (second product onboards in <2 weeks).

## Locked decisions

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | In-process npm kernel (not remote gateway) | Tools touch product DB; remote gateway adds 80–150ms per tool hop + provider key custody on platform. |
| 2 | Provider keys per-product | Simpler billing isolation, no key custody risk on platform, latency-neutral. |
| 3 | Hybrid tool protocol (in-process SDK + MCP-over-HTTP) | Single `defineAgentTool` source of truth, two adapters at the boundary. |
| 4 | Generic `TCtx` param for context (not module augmentation) | Scopes extensions per tool definition; module augmentation is project-global and contaminates siblings. |
| 5 | Control plane (P9) deferred to v1.5 | No second product yet → no consumer for cross-product cost rollup. NoopTelemetrySink keeps kernel functional without plane. |
| 6 | Barbeiro AI Prisma tables stay in barbeiro | No DB migration risk; port adapters wrap existing Prisma client. |

## Package taxonomy

### Day 1 published

| Package | What it ships |
| --- | --- |
| `@maestro/core` | envelope, defineAgentTool, BaseToolContext, runtime state machine, adapters (ai-sdk + mcp-server), cache-control, model router, empty-recovery, safe-tool, port interfaces, default impls (NoopTelemetrySink, InMemoryQuotaStore for tests) |
| `@maestro/react` | `useMaestroChat()` hook + tool-result rendering helpers — separate package because of React peer dep |

### Day 1 internal-only

| Folder | What |
| --- | --- |
| `examples/minimal-product` | Sample Next.js 15 app consuming both packages; doubles as integration-test surface + onboarding template |
| `tooling/eslint-config` | `no-unmetered-ai-client`, `no-direct-turn-mutation` rules. Promoted to published package once a second product needs them. |

### Deferred (named for ADR record; not built)

- `@maestro/mcp-client` — consume external MCP servers as tools
- `@maestro/eval` — promptfoo harness for golden paths + injection (now shipped as the live `@maestro/evals`)
- `@maestro/telemetry` — typed plane client (v1 ships as `@maestro/core` subpath)
- `@maestro/cli` — scaffold / eval-run / cost-report

### Semver policy

- `0.x` until barbeiro + 1 sibling consume in production for 30 days. All releases potentially breaking.
- `1.0` after that. Breaking changes to `ToolEnvelope`, `BaseToolContext`, `defineAgentTool` signature, any Port interface = MAJOR.
- Adding port methods with default no-op impls = MINOR. New adapters = MINOR. Bug fixes = PATCH.
- Public API explicitly excludes `internal/` subpath and any `*_unstable` named exports.

## Port interfaces

```ts
export interface TurnStore {
    upsert(turn: TurnRecord): Promise<void>
    loadHistory(threadId: string, limit?: number): Promise<TurnRecord[]>
    markFailed(turnId: string, error: { code: string; message: string }): Promise<void>
    markAborted(turnId: string, reason: string): Promise<void>
}

export interface AuditStore {
    recordToolCall(audit: ToolCallAudit): Promise<void> // fire-and-forget OK
}

export interface MemoryStore {
    load(scope: MemoryScope): Promise<MemoryRecord[]>
    save(scope: MemoryScope, fact: string, source: string): Promise<MemoryRecord>
    forget(scope: MemoryScope, factId: string): Promise<void>
}

export interface QuotaStore {
    getCeilings(query: {
        tenantId: string
        surface: string
        window: 'min' | 'hour' | 'day' | 'month'
    }): Promise<Ceilings>
    check(query: { tenantId: string; surface: string }): Promise<QuotaState>
    record(usage: QuotaUsage): Promise<void>
}

export interface ModelKeyProvider {
    getKey(provider: 'anthropic' | 'openai', tenantId?: string): Promise<string>
}

export interface TelemetrySink {
    emit(events: TelemetryEvent[]): Promise<void> // batched async, retries inside
}

export interface Clock {
    now(): Date
}

export interface Logger {
    debug(msg: string, meta?: object): void
    info(msg: string, meta?: object): void
    warn(msg: string, meta?: object): void
    error(msg: string, meta?: object): void
}
```

**7 ports total** (4 storage, 1 secret, 1 telemetry, 2 utility).

**Why not inject Prisma directly:**
1. Locks consumers to Prisma + a fixed schema. Barbeiro's `HelpChatMessage` has fields no sibling product needs.
2. Ports are the **test seam.** Unit tests get fakes; integration tests get in-memory impls. Prisma-direct = every test needs a DB.
3. Ports are the **observability seam.** A `TelemetryWrappedTurnStore` middleware is trivial. Prisma proxy is not.

## BaseToolContext + tool definition

```ts
export interface BaseToolContext {
    tenantId: string
    principal: { id: string; kind: string } | null
    actor: string
    transport: string
    locale: string
    timezone: string
    requestId: string
}

export function defineAgentTool<
    TInput,
    TOutput,
    TCtx extends BaseToolContext = BaseToolContext,
>(def: AgentToolDefinition<TInput, TOutput, TCtx>): AgentTool<TInput, TOutput, TCtx>
```

Host extends via intersection at the definition site:

```ts
type BarbeiroCtx = BaseToolContext & {
    businessSlug?: string
    guestPhone?: string
    role: HelpRole | null
}

export const checkAvailabilityTool = defineAgentTool<Input, Output, BarbeiroCtx>({
    name: 'checkAvailability',
    transports: ['chat', 'mcp'], // product owns the string vocabulary
    isAvailable: (ctx) => ctx.role === 'business_admin',
    execute: async (input, ctx) => {
        /* ctx.role typed */
    },
})
```

## Streaming contract

```ts
export async function runChatTurn<TCtx extends BaseToolContext>(args: {
    threadId: string
    ctx: TCtx
    messages: ModelMessage[]
    tools: AgentTool<any, any, TCtx>[]
    systemPrompt: { static: string; dynamic: string }
    modelHint?: { tier?: 'fast' | 'smart'; force?: string }
    abortSignal?: AbortSignal
    ports: {
        turnStore: TurnStore
        auditStore: AuditStore
        memoryStore?: MemoryStore
        quotaStore: QuotaStore
        keyProvider: ModelKeyProvider
        telemetry?: TelemetrySink
        clock?: Clock
        logger?: Logger
    }
    onTurnFinalized?: (turn: TurnRecord) => void | Promise<void>
}): Promise<Response> // SSE response, return directly from a Next.js route
```

Barbeiro route shrinks from ~300 LoC to ~25 LoC. Rate-limit, help-context loading, tool selection stay in barbeiro (product concerns); generic orchestration moves.

## Quota injection

Kernel owns the **window arithmetic.** Barbeiro owns the **plan → ceiling mapping** inside its `BarbeiroQuotaStore.getCeilings` impl. No coupling to plan tier names in the kernel.

## Control plane (v1.5, deferred)

Documented but not built. When added:

- Async-only writes (kernel → plane). No sync reads from kernel.
- Events: `turn.finalized`, `tool.called`, `quota.consumed`, `model.failover`, `empty.recovery`
- Batched in-memory, flush every 1 s or 50 events, max 3 retries with backoff, circuit-break for 60 s after 3 failures
- Kernel **never blocks on plane.** Plane outage = degraded telemetry, not chat downtime.
- v1.5 trigger: second product ships in production OR centralized abuse detection becomes a real need.

## Migration sequencing

Each phase ships independently, has a feature flag where applicable, and is independently revertable.

| Phase | Worktree / Repo | Depends on | What ships | Flag |
| --- | --- | --- | --- | --- |
| **P1** | `maestro/` (this repo) | none | Bootstrap: pnpm + turbo + tsconfig + CI. Empty `@maestro/core` skeleton with envelope only. `0.0.1`. | — |
| **P2** | `maestro/` | P1 | Lift `defineAgentTool` factory, `BaseToolContext`, safe-tool, cache-control. Adapter subpath: `@maestro/core/adapters/ai-sdk` + `.../adapters/mcp-server`. Port INTERFACES (no impls). `0.1.0`. | — |
| **P3** | `barbeiro-app/.claude/worktrees/maestro-adapt-p3` | P2 published | Barbeiro consumes `@maestro/core`. `lib/ai/envelope.ts` becomes re-export. 102 tools migrate to `defineAgentTool<I, O, BarbeiroCtx>`. NO behavior change. Behind flag for 2 weeks. | `MAESTRO_ADAPTER_ENABLED` |
| **P4** | `maestro/` | P2 | Kernel ships `runChatTurn` + lifted runtime, empty-recovery, model router, quota wrapper, memory load/store. Default in-memory port impls for tests. `0.2.0`. | — |
| **P5** | `barbeiro-app/.claude/worktrees/maestro-ports-p5` | P3 + P4 | Barbeiro implements all port adapters (BarbeiroTurnStore, BarbeiroQuotaStore, BarbeiroMemoryStore, BarbeiroAuditStore, BarbeiroModelKeyProvider). Wires NoopTelemetrySink. `runChatTurn` callable end-to-end but not yet wired into prod routes. | — |
| **P6** | `barbeiro-app/.claude/worktrees/maestro-guest-chat-p6` | P5 | Flip `/api/business/[slug]/chat` (guest-chat — lowest blast radius). Shadow mode for 7 days; cutover requires 7 consecutive zero-diff days. | `MAESTRO_GUEST_CHAT` |
| **P7** | `barbeiro-app/.claude/worktrees/maestro-help-chat-p7` | P6 cutover | Same shadow → cutover for `/api/help/chat`. | `MAESTRO_HELP_CHAT` |
| **P8** | `barbeiro-app/.claude/worktrees/maestro-whatsapp-p8` | P6 cutover | Same for whatsapp adapter. | `MAESTRO_WHATSAPP` |
| **P9 (deferred to v1.5)** | new `maestro-plane/` repo | P4 | Plane = Next.js or Hono + Postgres. Receives async telemetry. Projects into AiUsageEvent / AiToolCallAudit. Dashboards. Deployed via Dokploy. | — |
| **P10** | `barbeiro-app/.claude/worktrees/maestro-cleanup-p10` | P7 + P8 live ≥30 days | Delete `lib/ai/runtime/*`, `lib/ai/quota/*`, `lib/ai/memory/*`, `lib/ai/cost.ts`, `lib/ai/models.ts`, `lib/ai/cache-control.ts` from barbeiro. ESLint guards repoint at `@maestro/core`. AI Prisma tables stay in barbeiro for now. | — |
| **P11** | second product repo | P10 | Acceptance test for the abstraction. Target: <2 weeks to first chat turn. | — |

## What v1 explicitly doesn't solve

1. **Cross-product user memory.** Memories siloed per product.
2. **Hosted runtime / central provider rotation.** Per-product keys.
3. **Tool marketplace.** No shared tool packages until 3+ products want the same thing.
4. **Multi-provider routing beyond OpenAI fallback.** Anthropic primary + OpenAI fallback only.
5. **Real-time eval gates in CI.** Manual run for now.
6. **MCP client (kernel consuming external MCP servers).** Kernel is an MCP server, not client.
7. **UI rendering component library.** `meta.uiRendered` hint is the only contract.
8. **Per-tenant model selection.** All tenants share the same fast/smart router.
9. **GDPR right-to-delete in plane.** Manual SQL until 2nd product exists.
10. **Voice / Real-time API.** Placeholder.
11. **WhatsApp adapter generality.** Barbeiro-specific until a 2nd product needs WhatsApp.
12. **Plane DB schema for cross-product cost rollup.** No portfolio dashboard.

## Top risks + mitigations

**R1 — Wrong abstraction shape locked in too early.** Mitigation: phase 11 (second-product onboarding) is the acceptance test. >2 weeks of work or kernel changes → abstraction is wrong, pause + redesign. Don't 1.0 until P11 succeeds.

**R2 — Phase 6/7/8 shadow mode silently diverges.** Mitigation: shadow comparator writes both rows; new path tagged `shadow=true`; daily diff cron posts to Slack; cutover requires 7 consecutive zero-diff days.

**R3 — Plane outage degrades silently.** (v1.5 risk.) Mitigation: plane heartbeat cron, Sentry alert on missing events, dashboards labeled "estimativa", no invoicing built on plane data in v1.5.
