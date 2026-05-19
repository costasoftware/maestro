/**
 * Post-build step that copies CSS source files into `dist/styles/`.
 *
 * tsc only emits `.js` + `.d.ts` for `.ts` / `.tsx` files; CSS would
 * otherwise be dropped. We deliberately keep this as a separate
 * step rather than a bundler (tsup / unbuild / vite-lib) so the
 * package stays buildable with a stock tsc invocation — every
 * downstream that vendors the source tree can reproduce it.
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(here, '..', 'src', 'styles')
const OUT = resolve(here, '..', 'dist', 'styles')

if (!existsSync(SRC)) {
    console.warn(`[copy-styles] no styles dir at ${SRC} — nothing to copy`)
    process.exit(0)
}

mkdirSync(OUT, { recursive: true })

const entries = readdirSync(SRC)
for (const name of entries) {
    const srcPath = join(SRC, name)
    if (!statSync(srcPath).isFile()) continue
    if (!name.endsWith('.css')) continue
    const dstPath = join(OUT, name)
    copyFileSync(srcPath, dstPath)
    console.log(`[copy-styles] ${name}`)
}
