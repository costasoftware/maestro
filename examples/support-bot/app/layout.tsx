import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
    title: 'Maestro example — support-bot',
    description: 'Multi-tenant customer-support bot validating maestro-core generality.',
}

export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
}

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en">
            <body
                style={{
                    fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
                    margin: 0,
                    padding: 0,
                    color: '#111',
                    background: '#fafafa',
                }}
            >
                {children}
            </body>
        </html>
    )
}
