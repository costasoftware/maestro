/**
 * Per-test cleanup + jsdom shims shared by the component test files.
 *
 * Vitest does NOT enable `test.globals` by default, so RTL's auto
 * cleanup-on-import path doesn't fire. We register it manually, plus
 * stub the DOM APIs jsdom omits that our auto-scroll hook needs.
 *
 * Imported with side-effects at the top of every `*.test.tsx` file.
 */

import { afterEach, beforeEach, vi } from 'vitest'

// Node-env tests share this setup file but don't have a DOM —
// guard everything below so they don't crash on `Element` /
// `document` references.
const hasDom = typeof document !== 'undefined' && typeof Element !== 'undefined'

beforeEach(() => {
    if (!hasDom) return
    // jsdom doesn't implement IntersectionObserver — provide a no-op so
    // useAutoScroll can instantiate without throwing. Real scroll
    // pinning is exercised by a story/e2e environment, not jsdom.
    class FakeIO {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
        takeRecords(): unknown[] {
            return []
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        constructor(_cb: unknown) {}
    }
    Object.defineProperty(globalThis, 'IntersectionObserver', {
        value: FakeIO,
        configurable: true,
        writable: true,
    })
    // jsdom doesn't implement scrollIntoView. Stub as a no-op so the
    // pinned-to-bottom layout effect doesn't crash.
    Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView']
})

afterEach(async () => {
    if (!hasDom) return
    // Lazy import so this file is safe to load in the node env (it
    // wouldn't crash from the import alone, but defensive coding here
    // costs nothing).
    const { cleanup } = await import('@testing-library/react')
    cleanup()
})
