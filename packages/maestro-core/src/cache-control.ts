/**
 * Anthropic prompt-cache breakpoint helper.
 *
 * The model provider supports `cacheControl: { type: 'ephemeral' }`
 * markers — content BEFORE the breakpoint is hashed into the cache key,
 * content AFTER is rendered as a separate uncached segment. Cold call pays
 * cache-write; hot call pays cache-read (≈10% input rate).
 *
 * ## TTL
 *
 * `ttl` selects the cache lifetime and defaults to `'5m'`. It is a COST
 * decision, not a correctness one, and the two rates differ: a 5m write
 * costs ≈1.25× the input rate, a 1h write ≈2×. Which one wins is decided
 * by the gap between consecutive turns that share a prefix, so it belongs
 * to the host — the kernel cannot know a consumer's traffic shape.
 *
 * The measurement that produced this option, from one production host over
 * 7 days (614 turns, all on the hardcoded 5m):
 *
 *   gap since previous turn   turns   miss rate
 *   ≤ 5min                      437       12.4%
 *   5–60min                     147       67.3%   ← the TTL expiring
 *   > 60min                      29       51.7%
 *
 * The step at the 5-minute line is the whole finding. Turns landing in the
 * 5–60min band cost 3.2× per token what a cache-hit turn costs, and a 1h
 * TTL converts them. A host whose turns are sparser than an hour should
 * stay on `'5m'`: it would pay the 2× write and still never read.
 *
 * The default stays `'5m'` so this is opt-in — flipping it for a sparse
 * consumer is the same defect inverted.
 *
 * The TS-typed boundary between `static` and `dynamic` is the discipline.
 * A developer physically can't put `business.name` into the cached block
 * because the `static` slot only accepts the documented stable fields.
 * Cross-tenant cache reuse is deliberate: tenant-invariant static block
 * means many tenants share the same cache entry; per-tenant data lives
 * in the dynamic segment that the cache key ignores.
 *
 * This helper deals only with the system-prompt + tools shape. The
 * caller passes the result straight to `streamText` / `generateText`
 * (AI SDK) as `system: [...]` and `tools: {...}`.
 *
 * The tools map is kept opaque (`Record<string, unknown>`) so this
 * module has no `ai` dependency; the AI-SDK adapter feeds a properly
 * typed `ToolSet` in, and TypeScript flows the type through.
 */
export interface CacheableBlock<TTools extends Record<string, unknown>> {
    /**
     * Tenant-stable content — hashed for the cache key. MUST NOT
     * contain user/business names or any per-tenant interpolated
     * strings. Integer ids inside tool parameter descriptions are
     * fine; rendered-into-prose strings are not.
     */
    static: {
        /** Fixed introduction / persona block (surface-level instructions). */
        intro: string
        /** Help corpus or business catalog static reference block. */
        corpus: string
        /** Tool registry for this surface. The last tool receives the cacheControl marker. */
        tools: TTools
    }
    /**
     * Tenant-specific content. Rendered as a separate uncached system
     * segment so it never influences the cache key.
     */
    dynamic: {
        /** Tenant id as an integer-safe shape — never interpolated into cached strings. */
        tenant: { id: string; timezone: string }
        principal?: { id: string }
        /** ISO timestamp for "now" context — varies per turn; must NOT be cached. */
        nowIso: string
    }
    /**
     * Cache lifetime for every breakpoint this call emits. Defaults to
     * `'5m'`. See the module header for why the default is the short one
     * and when a host should pass `'1h'`.
     */
    ttl?: CacheTtl
}

/**
 * Anthropic ephemeral-cache lifetimes. Mirrors the provider's own union so
 * a host reading a config value can be typed against this and fail at the
 * boundary rather than at the API call.
 */
export type CacheTtl = '5m' | '1h'

export interface CachedMessages<TTools extends Record<string, unknown>> {
    /**
     * Two-element array:
     *   [0] static system message — carries the Anthropic ephemeral cacheControl marker.
     *   [1] dynamic system message — no marker; rendered after the breakpoint.
     */
    system: Array<{
        role: 'system'
        content: string
        providerOptions?: {
            anthropic?: { cacheControl?: { type: 'ephemeral'; ttl: CacheTtl } }
        }
    }>
    /** Tool registry — the last tool carries the cacheControl marker. */
    tools: TTools
}

export function applyCacheBreakpoints<TTools extends Record<string, unknown>>(
    input: CacheableBlock<TTools>
): CachedMessages<TTools> {
    const { static: st, dynamic: dyn, ttl = '5m' } = input

    // One directive object, reused by both breakpoints. Deriving them from
    // a single value means a request never mixes lifetimes: mixed-TTL
    // breakpoints carry their own ordering rules at the provider, and a
    // kernel with one knob has no reason to go near them.
    const cacheControl = { type: 'ephemeral' as const, ttl }

    // ── Static system message (cached) ──────────────────────────────────
    const staticContent = st.corpus ? `${st.intro}\n\n${st.corpus}` : st.intro
    const staticMessage = {
        role: 'system' as const,
        content: staticContent,
        providerOptions: { anthropic: { cacheControl } },
    }

    // ── Dynamic system message (uncached) ───────────────────────────────
    const dynamicLines: string[] = [
        `Tenant context: tenant_id=${dyn.tenant.id}, timezone=${dyn.tenant.timezone}`,
    ]
    if (dyn.principal?.id !== undefined) {
        dynamicLines.push(`Principal context: principal_id=${dyn.principal.id}`)
    }
    dynamicLines.push(`Current time (ISO): ${dyn.nowIso}`)
    const dynamicMessage = {
        role: 'system' as const,
        content: dynamicLines.join('\n'),
    }

    // ── Tools (cached) ──────────────────────────────────────────────────
    // Clone the registry to avoid mutating the caller's object. Apply the
    // cacheControl marker to the last tool in iteration order. Strip any
    // pre-existing providerOptions on non-last tools so a previously
    // marked registry coming back through here doesn't double-mark.
    const toolKeys = Object.keys(st.tools)
    const markedTools = {} as Record<string, unknown>

    for (let i = 0; i < toolKeys.length; i++) {
        const key = toolKeys[i]
        if (key === undefined) continue
        const original = st.tools[key]
        if (original === undefined) continue
        const isLast = i === toolKeys.length - 1

        if (isLast) {
            markedTools[key] = {
                ...(original as object),
                providerOptions: { anthropic: { cacheControl } },
            }
        } else {
            const { providerOptions: _drop, ...rest } = original as {
                providerOptions?: unknown
            } & Record<string, unknown>
            markedTools[key] = rest
        }
    }

    return {
        system: [staticMessage, dynamicMessage],
        tools: markedTools as TTools,
    }
}
