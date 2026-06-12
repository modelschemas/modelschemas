import { describe, expect, it } from 'vitest'

import { globToRegExp, matchTargets, parseSelection } from './selection.ts'

const INDEX = {
  provider: 'anthropic',
  activities: {
    chat: ['v1/messages', 'v1/complete'],
    image: ['v1/images'],
  },
}

describe('parseSelection', () => {
  it('parses the full grammar', () => {
    expect(parseSelection('anthropic')).toEqual({
      provider: 'anthropic',
      endpointPattern: '*',
      kinds: ['input', 'output'],
      explicitKind: false,
      raw: 'anthropic',
    })
    expect(parseSelection('openai/chat/completions#request')).toMatchObject({
      provider: 'openai',
      endpointPattern: 'chat/completions',
      kinds: ['input'],
      explicitKind: true,
    })
    expect(parseSelection('gemini/*#response')).toMatchObject({
      provider: 'gemini',
      endpointPattern: '*',
      kinds: ['output'],
    })
  })

  it('rejects malformed selections with actionable messages', () => {
    expect(() => parseSelection('')).toThrow('Empty selection')
    expect(() => parseSelection('anthropic#body')).toThrow(
      '#request or #response',
    )
    expect(() => parseSelection('*/v1/messages')).toThrow(
      'globs are only supported in the endpoint part',
    )
    expect(() => parseSelection('anthropic/')).toThrow('empty endpoint pattern')
    expect(() => parseSelection('a#request#response')).toThrow(
      "more than one '#'",
    )
  })
})

describe('globToRegExp', () => {
  it('anchors and escapes everything but *', () => {
    expect(globToRegExp('v1/*').test('v1/messages')).toBe(true)
    expect(globToRegExp('v1/*').test('v2/messages')).toBe(false)
    expect(globToRegExp('a.b').test('axb')).toBe(false)
    expect(globToRegExp('*messages').test('v1/messages')).toBe(true)
  })
})

describe('matchTargets', () => {
  it('expands a provider-wide selection to every endpoint × both kinds', () => {
    const targets = matchTargets(parseSelection('anthropic'), INDEX)
    expect(targets).toHaveLength(6)
    expect(targets[0]).toMatchObject({
      provider: 'anthropic',
      activity: 'chat',
      endpointId: 'v1/messages',
      kind: 'input',
      explicitKind: false,
    })
  })

  it('filters by glob and pins kinds', () => {
    const targets = matchTargets(
      parseSelection('anthropic/v1/m*#request'),
      INDEX,
    )
    expect(targets).toEqual([
      expect.objectContaining({
        endpointId: 'v1/messages',
        kind: 'input',
        explicitKind: true,
      }),
    ])
  })

  it('throws for a concrete pattern that matches nothing, listing valid ids', () => {
    expect(() =>
      matchTargets(parseSelection('anthropic/v1/message'), INDEX),
    ).toThrow(/no endpoint 'v1\/message'.*v1\/messages/)
  })

  it('returns [] for an unmatched glob (not an error)', () => {
    expect(matchTargets(parseSelection('anthropic/v9/*'), INDEX)).toEqual([])
  })
})
