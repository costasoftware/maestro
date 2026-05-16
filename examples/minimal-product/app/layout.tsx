import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
    title: 'Maestro example — minimal product',
    description: 'Smallest possible host consuming maestro-core.',
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
