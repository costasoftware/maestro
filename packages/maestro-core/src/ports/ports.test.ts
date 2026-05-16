import { describe, expect, it } from 'vitest'

import { FixedClock, SystemClock } from './clock.js'
import { ConsoleLogger, SilentLogger } from './logger.js'
import { NoopTelemetrySink } from './telemetry-sink.js'

describe('default port implementations', () => {
    it('SystemClock returns a Date instance', () => {
        const clock = new SystemClock()
        expect(clock.now()).toBeInstanceOf(Date)
    })

    it('FixedClock returns the same instant every call', () => {
        const fixed = new Date('2026-05-16T13:00:00.000Z')
        const clock = new FixedClock(fixed)
        expect(clock.now()).toEqual(fixed)
        expect(clock.now()).toEqual(fixed)
    })

    it('NoopTelemetrySink resolves without doing anything', async () => {
        const sink = new NoopTelemetrySink()
        await expect(sink.emit([])).resolves.toBeUndefined()
    })

    it('SilentLogger swallows all levels', () => {
        const log = new SilentLogger()
        expect(() => {
            log.debug('a')
            log.info('b')
            log.warn('c')
            log.error('d')
        }).not.toThrow()
    })

    it('ConsoleLogger can be constructed and called', () => {
        const log = new ConsoleLogger()
        // Just make sure these methods exist and accept the expected shapes.
        expect(typeof log.debug).toBe('function')
        expect(typeof log.info).toBe('function')
        expect(typeof log.warn).toBe('function')
        expect(typeof log.error).toBe('function')
    })
})
