import { describe, expect, it } from 'vitest'

import { estimateBodyFromFile } from './index.ts'

describe('estimateBodyFromFile', () => {
  it('treats a bare usage object as usage (SKILL.md usage.json)', () => {
    expect(
      estimateBodyFromFile({ input_tokens: 1200, output_tokens: 400 }),
    ).toEqual({
      usage: { input_tokens: 1200, output_tokens: 400 },
    })
  })

  it('forwards a { request, usage } wrapper', () => {
    expect(
      estimateBodyFromFile({
        request: { duration: 5 },
        usage: { input_tokens: 1 },
      }),
    ).toEqual({
      request: { duration: 5 },
      usage: { input_tokens: 1 },
    })
  })

  it('rejects non-objects and non-object request/usage slots', () => {
    expect(estimateBodyFromFile(null)).toBeNull()
    expect(estimateBodyFromFile([])).toBeNull()
    expect(estimateBodyFromFile({ request: [] })).toBeNull()
    expect(estimateBodyFromFile({ usage: 'nope' })).toBeNull()
  })
})
