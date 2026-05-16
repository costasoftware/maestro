import { describe, expect, it } from 'vitest'

import { applyCacheBreakpoints } from './cache-control.js'

const baseInput = {
    static: {
        intro: 'You are a helpful agent.',
        corpus: 'Reference: see the docs.',
        tools: { alpha: { description: 'a' }, beta: { description: 'b' }, gamma: { description: 'g' } },
    },
    dynamic: {
        tenant: { id: '42', timezone: 'America/Sao_Paulo' },
        principal: { id: '7' },
        nowIso: '2026-05-16T13:00:00.000Z',
    },
}

describe('applyCacheBreakpoints', () => {
    it('returns 2 system messages: static (cached) + dynamic (uncached)', () => {
        const result = applyCacheBreakpoints(baseInput)

        expect(result.system).toHaveLength(2)

        const [staticMsg, dynamicMsg] = result.system
        expect(staticMsg?.role).toBe('system')
        expect(staticMsg?.content).toBe('You are a helpful agent.\n\nReference: see the docs.')
        expect(staticMsg?.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' })

        expect(dynamicMsg?.role).toBe('system')
        expect(dynamicMsg?.providerOptions).toBeUndefined()
        expect(dynamicMsg?.content).toContain('tenant_id=42')
        expect(dynamicMsg?.content).toContain('principal_id=7')
        expect(dynamicMsg?.content).toContain('2026-05-16T13:00:00.000Z')
    })

    it('marks only the last tool with cacheControl, strips others', () => {
        const result = applyCacheBreakpoints(baseInput)

        const alpha = result.tools.alpha as { providerOptions?: unknown }
        const beta = result.tools.beta as { providerOptions?: unknown }
        const gamma = result.tools.gamma as { providerOptions?: { anthropic?: { cacheControl?: object } } }

        expect(alpha.providerOptions).toBeUndefined()
        expect(beta.providerOptions).toBeUndefined()
        expect(gamma.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' })
    })

    it('produces byte-identical static content for the same static input across tenants', () => {
        // Cross-tenant cache reuse depends on this. If two tenants hit the same
        // static block, Anthropic should serve the same cache entry — only the
        // dynamic segment changes.
        const tenantA = applyCacheBreakpoints({
            ...baseInput,
            dynamic: { ...baseInput.dynamic, tenant: { id: '1', timezone: 'UTC' } },
        })
        const tenantB = applyCacheBreakpoints({
            ...baseInput,
            dynamic: { ...baseInput.dynamic, tenant: { id: '999', timezone: 'America/Sao_Paulo' } },
        })

        expect(tenantA.system[0]?.content).toBe(tenantB.system[0]?.content)
        expect(tenantA.system[0]?.providerOptions).toEqual(tenantB.system[0]?.providerOptions)
    })

    it('omits corpus join when corpus is empty string', () => {
        const result = applyCacheBreakpoints({
            ...baseInput,
            static: { ...baseInput.static, corpus: '' },
        })
        expect(result.system[0]?.content).toBe('You are a helpful agent.')
    })
})
