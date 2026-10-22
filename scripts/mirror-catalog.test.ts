import { describe, expect, it } from 'vitest'

import { commitMessage, coveredChanges, mirrorFiles } from './mirror-catalog.ts'

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

async function* pages(...list: Array<Array<ReturnType<typeof change>>>) {
  yield* list
}

describe('mirrorFiles', () => {
  it('writes one pretty file per entity, the same bytes each run', () => {
    const files = mirrorFiles(body)
    expect([...files.keys()]).toEqual([
      'providers/fal.json',
      'models/fal/fal-flux-dev.json',
      'schemas/fal/fal-ai/flux/dev.json',
      'latest-change.json',
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

describe('coveredChanges', () => {
  it('keeps (previous, latest], skipping newer rows and stopping at previous', async () => {
    const covered = await coveredChanges(
      pages(
        [change('z-newer', 30), change('chg-b', 20), change('chg-a2', 10)],
        [change('chg-a1', 10), change('never-read', 5)],
      ),
      { id: 'chg-a1', createdAt: 10 },
      { id: 'chg-b', createdAt: 20 },
    )
    expect(covered.map((c) => c.id)).toEqual(['chg-b', 'chg-a2'])
  })
})

describe('commitMessage', () => {
  it('lists every covered id', () => {
    const message = commitMessage(
      { id: 'a', createdAt: 1 },
      { id: 'c', createdAt: 3 },
      [change('c', 3), change('b', 2)],
    )
    expect(message).toBe(
      'Catalog: 2 changes up to c\n\n/v1/changes ids covered:\n- c model.updated: summary c\n- b model.updated: summary b\n',
    )
  })

  it('names the first snapshot without listing the whole feed', () => {
    expect(commitMessage(null, { id: 'c', createdAt: 3 }, [])).toBe(
      'Catalog snapshot up to change c\n',
    )
  })
})
