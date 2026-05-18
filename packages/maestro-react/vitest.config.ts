import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        // Default to node for protocol/reducer/transport tests. The
        // hook tests opt into jsdom via the `@vitest-environment jsdom`
        // file-level docblock — jsdom is slower to boot than node so
        // we only pay for it where React rendering is needed.
        environment: 'node',
    },
})
