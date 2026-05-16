/**
 * Structured-logging port. Default `ConsoleLogger` is fine for dev;
 * hosts wire pino / winston / Sentry breadcrumbs in production by
 * implementing this interface.
 */
export interface Logger {
    debug(msg: string, meta?: object): void
    info(msg: string, meta?: object): void
    warn(msg: string, meta?: object): void
    error(msg: string, meta?: object): void
}

export class ConsoleLogger implements Logger {
    debug(msg: string, meta?: object): void {
        meta ? console.debug(msg, meta) : console.debug(msg)
    }
    info(msg: string, meta?: object): void {
        meta ? console.info(msg, meta) : console.info(msg)
    }
    warn(msg: string, meta?: object): void {
        meta ? console.warn(msg, meta) : console.warn(msg)
    }
    error(msg: string, meta?: object): void {
        meta ? console.error(msg, meta) : console.error(msg)
    }
}

/** Test helper — discards everything. */
export class SilentLogger implements Logger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}
