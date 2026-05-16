/**
 * Time-source port. The kernel routes every "now" through this so
 * tests can advance time deterministically without mocking
 * `global.Date`. Production hosts wire `SystemClock`.
 *
 * Hard rule: NO code under `src/` may call `new Date()` /
 * `Date.now()` directly outside of `SystemClock`. Use the injected
 * clock or accept a `Date` argument.
 */
export interface Clock {
    now(): Date
}

export class SystemClock implements Clock {
    now(): Date {
        return new Date()
    }
}

/** Test helper — returns a fixed instant, never advances. */
export class FixedClock implements Clock {
    constructor(private readonly fixed: Date) {}

    now(): Date {
        return this.fixed
    }
}
