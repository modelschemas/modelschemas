import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '../db/index.ts'
import { changes, providers } from '../db/schema.ts'
import { CANONICAL_PATHS, robotsTxt, sitemapXml } from './seo.ts'

const ORIGIN = 'https://modelschemas.com'

describe('sitemap + robots (task 10.1)', () => {
  it('renders a sitemaps.org urlset covering every canonical path', async () => {
    const db = getDb(env)
    await db.insert(providers).values({
      id: 'seo-prov',
      displayName: 'SEO Prov',
      specSourceUrl: 'https://example.com/spec.json',
    })
    await db.insert(changes).values({
      id: 'seo-change',
      type: 'model.added',
      providerId: 'seo-prov',
      subjectId: 'm',
      summary: 's',
      createdAt: 1_781_150_000,
    })

    const xml = await sitemapXml(db, ORIGIN)
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    )
    for (const path of CANONICAL_PATHS) {
      const loc = path === '/' ? `${ORIGIN}/` : `${ORIGIN}${path}`
      expect(xml).toContain(`<loc>${loc}</loc>`)
    }
    expect(xml).toContain('<lastmod>')
    // Well-formed-ish: matching url tags.
    expect(xml.match(/<url>/g)?.length).toBe(CANONICAL_PATHS.length)
    expect(xml.match(/<\/url>/g)?.length).toBe(CANONICAL_PATHS.length)
  })

  it('robots.txt allows all and references the sitemap', () => {
    const txt = robotsTxt(ORIGIN)
    expect(txt).toContain('User-agent: *')
    expect(txt).toContain('Allow: /')
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`)
  })
})
