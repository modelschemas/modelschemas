import { describe, expect, it } from 'vitest'

import { llmsTxt } from './llms-txt.ts'

// /docs renders this exact content (task 7.3) and the skill (7.6) embeds it —
// pin the load-bearing sections so edits can't silently hollow them out.
describe('llms.txt content', () => {
  it('keeps the sections the docs page and skill depend on', () => {
    for (const heading of [
      '# modelschemas',
      '## Quickstart',
      '## Caching',
      '## Auth',
      '## Machine-readable spec',
      '## Errors',
    ]) {
      expect(llmsTxt).toContain(heading)
    }
    for (const path of [
      '/v1/models',
      '/v1/schemas/',
      '/v1/openapi/',
      '/v1/validate',
      '/v1/changes',
      '/openapi.json',
      '/.well-known/agent-configuration',
      '/v1/agents/register-key',
    ]) {
      expect(llmsTxt).toContain(path)
    }
  })
})
