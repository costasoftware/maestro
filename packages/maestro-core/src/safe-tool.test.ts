import { describe, expect, it, vi } from 'vitest'

import { captureToolException, type ToolExceptionTags } from './safe-tool.js'

const tags: ToolExceptionTags = {
    toolName: 'doThing',
    transport: 'chat',
    actor: 'human',
    tenantId: 't1',
    principalId: 'u1',
    requestId: 'req_42',
}

describe('captureToolException', () => {
    it('invokes onError with the exception and tags', () => {
        const onError = vi.fn()
        const err = new Error('boom')

        captureToolException(err, tags, onError)

        expect(onError).toHaveBeenCalledTimes(1)
        expect(onError).toHaveBeenCalledWith(err, tags)
    })

    it('is a no-op when onError is not provided', () => {
        // Just shouldn't throw.
        captureToolException(new Error('boom'), tags)
    })

    it('swallows errors thrown by the host handler', () => {
        const onError = vi.fn(() => {
            throw new Error('observer crashed')
        })

        expect(() =>
            captureToolException(new Error('boom'), tags, onError)
        ).not.toThrow()
        expect(onError).toHaveBeenCalledOnce()
    })
})
