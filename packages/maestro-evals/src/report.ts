/**
 * Shared report shape returned by both the static and live runners,
 * plus the formatters the CLI uses to render it.
 */

export type Reporter = 'json' | 'tap' | 'console'

export type RunnerTier = 'static' | 'live'

export interface FixtureFailure {
    code: string
    message: string
}

export interface FixtureResult {
    name: string
    description?: string
    passed: boolean
    failures: FixtureFailure[]
    /** Optional duration in ms — live runner sets it, static usually doesn't. */
    durationMs?: number
    /** Optional model id — live runner sets it. */
    modelId?: string
    /** Optional token usage — live runner sets it. */
    tokensIn?: number
    tokensOut?: number
}

export interface EvalReport {
    tier: RunnerTier
    startedAt: Date
    results: FixtureResult[]
    passed: boolean
}

/**
 * Renders an `EvalReport` as a string for stdout printing. Returns
 * an empty string when no rendering applies (e.g. silent reporters,
 * none of which exist today — every supported reporter renders).
 */
export function formatReport(report: EvalReport, reporter: Reporter): string {
    switch (reporter) {
        case 'json':
            return JSON.stringify(report, dateReplacer, 2)
        case 'tap':
            return formatTap(report)
        case 'console':
        default:
            return formatConsole(report)
    }
}

function dateReplacer(_key: string, value: unknown): unknown {
    return value instanceof Date ? value.toISOString() : value
}

function formatConsole(report: EvalReport): string {
    const lines: string[] = []
    const header = `maestro-evals (${report.tier})  ${report.startedAt.toISOString()}`
    lines.push(header)
    lines.push('─'.repeat(header.length))

    for (const r of report.results) {
        const mark = r.passed ? 'PASS' : 'FAIL'
        const meta: string[] = []
        if (r.modelId) meta.push(r.modelId)
        if (r.tokensIn !== undefined && r.tokensOut !== undefined) {
            meta.push(`${r.tokensIn}in/${r.tokensOut}out`)
        }
        if (r.durationMs !== undefined) meta.push(`${r.durationMs}ms`)
        const metaStr = meta.length > 0 ? `  [${meta.join(' · ')}]` : ''
        lines.push(`  ${mark}  ${r.name}${metaStr}`)
        if (r.description) lines.push(`        ${r.description}`)
        for (const f of r.failures) {
            lines.push(`        ✗ ${f.code}: ${f.message}`)
        }
    }

    const total = report.results.length
    const passed = report.results.filter((r) => r.passed).length
    lines.push('')
    lines.push(`Summary: ${passed}/${total} passed`)
    return lines.join('\n')
}

function formatTap(report: EvalReport): string {
    const lines: string[] = [`TAP version 13`, `1..${report.results.length}`]
    report.results.forEach((r, idx) => {
        const n = idx + 1
        if (r.passed) {
            lines.push(`ok ${n} - ${r.name}`)
        } else {
            lines.push(`not ok ${n} - ${r.name}`)
            lines.push('  ---')
            lines.push(`  failures:`)
            for (const f of r.failures) {
                lines.push(`    - code: ${f.code}`)
                lines.push(`      message: ${JSON.stringify(f.message)}`)
            }
            lines.push('  ...')
        }
    })
    return lines.join('\n')
}
