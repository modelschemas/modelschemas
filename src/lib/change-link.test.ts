import { describe, expect, it } from 'vitest'

import { modelChangeHref } from './change-link.ts'

describe('modelChangeHref', () => {
  it('links a model change to the catalog page', () => {
    expect(
      modelChangeHref({
        type: 'model.updated',
        providerId: 'replicate',
        subjectId: 'replicate-krea-krea-2-large',
      }),
    ).toBe('/models/replicate/replicate-krea-krea-2-large')
  })

  it('leaves schema changes unlinked', () => {
    expect(
      modelChangeHref({
        type: 'schema.updated',
        providerId: 'openai',
        subjectId: 'openai/v1/chat/completions',
      }),
    ).toBeNull()
  })
})
