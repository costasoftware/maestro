import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        // Default to node for protocol/reducer/transport tests. Hook
        // + component tests opt into jsdom via the `@vitest-environment
        // jsdom` file-level docblock — jsdom is slower to boot than
        // node so we only pay for it where React rendering is needed.
        environment: 'node',
        // Component tests (.test.tsx) all share the same RTL cleanup
        // + jsdom shim setup. Node-only tests (.test.ts) ignore this
        // file because it imports DOM APIs (Element) — vitest only
        // loads setupFiles for files matching the test file pattern
        // anyway, but the shim is defensive against accidental imports
        // from node-env tests.
        setupFiles: ['./src/components/test-setup.ts'],
    },
    esbuild: {
        // tsx files use the automatic JSX runtime so test files don't
        // need to import React explicitly.
        jsx: 'automatic',
    },
})
