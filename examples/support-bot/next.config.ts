import type { NextConfig } from 'next'

const config: NextConfig = {
    reactStrictMode: true,
    // Treat workspace package as a regular dep — transpile when needed.
    transpilePackages: ['maestro-core'],
}

export default config
