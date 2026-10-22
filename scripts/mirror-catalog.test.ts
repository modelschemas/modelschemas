import { describe, expect, it } from 'vitest'

import {
  LOOKBACK_SECONDS,
  commitMessage,
  mirrorFiles,
  newChanges,
  parseExport,
  parseFeedState,
  refuseRun,
} from './mirror-catalog.ts'

const body = {
  latestChange: { id: 'chg-b', createdAt: 20 },
  providers: [{ id: 'fal', displayName: 'FAL' }],
  models: [{ id: 'fal-flux-dev', provider: 'fal', rawId: 'fal-ai/flux/dev' }],
  schemas: [
    { provider: 'fal', endpointId: 'fal-ai/flux/dev', activity: 'image' },
  ],
}

const change = (id: string, createdAt: number) => ({
  id,
  createdAt,
  type: 'model.updated',
  summary: `summary ${id}`,
})

describe('mirrorFiles', () => {
  it('writes one pretty file per entity, the same bytes each run', () => {
    const files = mirrorFiles(body)
    expect([...files.keys()]).toEqual([
      'providers/fal.json',
      'models/fal/fal-flux-dev.json',
      'schemas/fal/fal-ai/flux/dev.json',
    ])
    expect(files.get('providers/fal.json')).toBe(
      '{\n  "id": "fal",\n  "displayName": "FAL"\n}\n',
    )
    expect(mirrorFiles(structuredClone(body))).toEqual(files)
  })

  it('refuses ids that would leave their folder', () => {
    for (const endpointId of ['../x', 'a//b', 'a\\b', '']) {
      expect(() =>
        mirrorFiles({ ...body, schemas: [{ provider: 'fal', endpointId }] }),
      ).toThrow(/unsafe id/)
    }
  })

  it('refuses two entities on one path', () => {
    expect(() =>
      mirrorFiles({ ...body, models: [...body.models, ...body.models] }),
    ).toThrow(/two entities/)
  })
})

describe('parseExport', () => {
  it('refuses a body without latestChange, providers, or array sections', () => {
    const { latestChange: _, ...noLatest } = body
    expect(() => parseExport(noLatest)).toThrow(/no latestChange/)
    expect(() => parseExport({ ...body, providers: [] })).toThrow(
      /no providers/,
    )
    expect(() => parseExport({ ...body, models: {} })).toThrow(/not an array/)
    expect(() => parseExport({ ...body, latestChange: { id: 1 } })).toThrow(
      /latestChange/,
    )
  })
})

describe('refuseRun', () => {
  const a = { id: 'a', createdAt: 10 }
  const b = { id: 'b', createdAt: 20 }
  it('refuses a latestChange that vanished or moved backwards', () => {
    expect(() => refuseRun(b, null, 10, 10, false)).toThrow(/no latestChange/)
    expect(() => refuseRun(b, a, 10, 10, false)).toThrow(/moved backwards/)
    expect(() => refuseRun(a, b, 10, 10, false)).not.toThrow()
  })

  it('refuses dropping more than half the files unless allowed', () => {
    expect(() => refuseRun(a, b, 100, 49, false)).toThrow(/MIRROR_ALLOW_SHRINK/)
    expect(() => refuseRun(a, b, 100, 49, true)).not.toThrow()
    expect(() => refuseRun(null, b, 0, 3, false)).not.toThrow()
  })
})

describe('newChanges', () => {
  it('lists a change a running poll inserted late with an earlier createdAt and smaller id', () => {
    // Run 1 saw chg-m at T=100. The poll that started at T=100 then wrote
    // chg-a (same createdAt, smaller random id): a keyset cursor skips it.
    const run1 = newChanges(parseFeedState(null), [change('chg-m', 100)], {
      id: 'chg-m',
      createdAt: 100,
    })
    const run2 = newChanges(
      run1.state,
      [change('chg-m', 100), change('chg-a', 100), change('chg-z', 150)],
      { id: 'chg-z', createdAt: 150 },
    )
    expect(run2.listed.map((c) => c.id)).toEqual(['chg-a', 'chg-z'])
    expect(run2.state.highWater).toBe(150)
    expect(run2.state.listed).toEqual([
      { id: 'chg-a', createdAt: 100 },
      { id: 'chg-m', createdAt: 100 },
      { id: 'chg-z', createdAt: 150 },
    ])
  })

  it('forgets listed ids once they fall behind the window', () => {
    const later = 100 + LOOKBACK_SECONDS + 1
    const { state } = newChanges(
      {
        latestChange: null,
        highWater: 100,
        listed: [{ id: 'old', createdAt: 100 }],
      },
      [change('new', later)],
      null,
    )
    expect(state.listed).toEqual([{ id: 'new', createdAt: later }])
  })

  it('round-trips through feed.json', () => {
    const { state } = newChanges(parseFeedState(null), [change('x', 5)], null)
    expect(parseFeedState(JSON.stringify(state))).toEqual(state)
    expect(() => parseFeedState('{"highWater":1}')).toThrow(/listed/)
  })
})

describe('commitMessage', () => {
  it('lists every new id', () => {
    expect(
      commitMessage(false, { id: 'c', createdAt: 3 }, [
        change('c', 3),
        change('b', 2),
      ]),
    ).toBe(
      'Catalog: 2 changes\n\n/v1/changes ids recorded since the last mirror commit:\n- c model.updated: summary c\n- b model.updated: summary b\n',
    )
  })

  it('names the first snapshot without listing the feed', () => {
    expect(
      commitMessage(true, { id: 'c', createdAt: 3 }, [change('c', 3)]),
    ).toBe('Catalog snapshot up to change c\n')
  })
})
