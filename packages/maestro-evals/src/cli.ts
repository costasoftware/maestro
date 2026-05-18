#!/usr/bin/env node
/* eslint-disable no-console */
import { readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

import { normaliseFixtureModule, type EvalFixture } from './fixtures.js'
import type { Reporter } from './report.js'
import { runLiveEvals } from './runner-live.js'
import { runStaticEvals } from './runner-static.js'

/**
 * Tiny argv parser — avoids pulling commander/yargs in for a 4-flag
 * CLI. Recognised flags:
 *
 *   maestro-evals run [--dir <path>] [--live] [--model <id>] [--reporter <json|tap|console>]
 *
 * Exit codes:
 *   0 — all fixtures passed
 *   1 — at least one fixture failed
 *   2 — usage error / no fixtures found / live without API key
 */
interface ParsedArgs {
    cmd: 'run' | 'help'
    dir: string
    live: boolean
    model?: string
    reporter: Reporter
}

function parseArgs(argv: readonly string[]): ParsedArgs {
    const args = [...argv]
    const cmd = (args.shift() ?? 'help') as ParsedArgs['cmd']
    const parsed: ParsedArgs = {
        cmd: cmd === 'run' ? 'run' : 'help',
        dir: './fixtures',
        live: false,
        reporter: 'console',
    }
    while (args.length > 0) {
        const flag = args.shift()
        switch (flag) {
            case '--dir':
                parsed.dir = args.shift() ?? parsed.dir
                break
            case '--live':
                parsed.live = true
                break
            case '--model':
                parsed.model = args.shift()
                break
            case '--reporter': {
                const r = args.shift()
                if (r === 'json' || r === 'tap' || r === 'console') parsed.reporter = r
                break
            }
            case '--help':
            case '-h':
                parsed.cmd = 'help'
                break
            default:
                // Unknown flag — skip silently to keep the parser tolerant
                // of host-specific wrapping (e.g. extra CI flags).
                break
        }
    }
    return parsed
}

function printHelp(): void {
    console.log(`maestro-evals — golden-prompt regression guard

Usage:
  maestro-evals run [options]

Options:
  --dir <path>        Directory containing fixture files (default: ./fixtures)
  --live              Hit real Anthropic instead of the static runner
  --model <id>        Model id for live mode (default: claude-haiku-4-5-20251001)
  --reporter <fmt>    json | tap | console (default: console)
  --help              Show this message

Environment:
  ANTHROPIC_API_KEY   Required when --live is set

Exit codes:
  0  all fixtures passed
  1  at least one fixture failed
  2  usage error / no fixtures found / missing live key`)
}

async function loadFixtures(dir: string): Promise<EvalFixture[]> {
    const absDir = resolve(process.cwd(), dir)
    let entries: string[]
    try {
        entries = await readdir(absDir)
    } catch (e) {
        throw new Error(
            `Failed to read fixtures dir "${absDir}": ${e instanceof Error ? e.message : String(e)}`
        )
    }
    const files = entries.filter(
        (n) => n.endsWith('.fixture.js') || n.endsWith('.fixture.mjs')
    )
    if (files.length === 0) {
        // Helpful hint — most users author .ts and forget to build.
        const tsFiles = entries.filter((n) => n.endsWith('.fixture.ts'))
        if (tsFiles.length > 0) {
            throw new Error(
                `Found ${tsFiles.length} .fixture.ts file(s) in ${absDir} but no compiled .fixture.js — build your fixtures first (tsc) or point --dir at the dist output.`
            )
        }
        throw new Error(`No *.fixture.js files found in ${absDir}`)
    }
    const out: EvalFixture[] = []
    for (const f of files) {
        const url = pathToFileURL(resolve(absDir, f)).href
        const mod = (await import(url)) as { default?: unknown }
        if (!mod.default) {
            console.warn(`  skip: ${f} has no default export`)
            continue
        }
        out.push(
            ...(normaliseFixtureModule(
                mod.default as Parameters<typeof normaliseFixtureModule>[0]
            ) as EvalFixture[])
        )
    }
    return out
}

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2))
    if (args.cmd === 'help') {
        printHelp()
        return 0
    }

    let fixtures: EvalFixture[]
    try {
        fixtures = await loadFixtures(args.dir)
    } catch (e) {
        console.error(e instanceof Error ? e.message : String(e))
        return 2
    }
    if (fixtures.length === 0) {
        console.error('No fixtures to run.')
        return 2
    }

    if (args.live) {
        const key = process.env.ANTHROPIC_API_KEY
        if (!key) {
            console.error('--live requires ANTHROPIC_API_KEY to be set.')
            return 2
        }
        const report = await runLiveEvals(fixtures, {
            anthropicApiKey: key,
            model: args.model,
            reporter: args.reporter,
        })
        return report.passed ? 0 : 1
    }

    const report = await runStaticEvals(fixtures, { reporter: args.reporter })
    return report.passed ? 0 : 1
}

main()
    .then((code) => {
        process.exit(code)
    })
    .catch((e: unknown) => {
        console.error(e instanceof Error ? e.stack : String(e))
        process.exit(2)
    })
