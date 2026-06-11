/**
 * Sitemap + robots (PLAN.md task 10.1). Generated per request so they are
 * always current on publish; origin comes from BETTER_AUTH_URL, lastmod from
 * the newest change row.
 */
import { desc } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { changes } from '#/db/schema.ts'

export const CANONICAL_PATHS = [
  '/',
  '/docs',
  '/login',
  '/account',
  '/llms.txt',
  '/openapi.json',
  '/skill',
] as const

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export async function sitemapXml(db: Db, origin: string): Promise<string> {
  const latest = await db
    .select({ createdAt: changes.createdAt })
    .from(changes)
    .orderBy(desc(changes.createdAt))
    .limit(1)
  const lastmod = latest[0]
    ? new Date(latest[0].createdAt * 1000).toISOString().slice(0, 10)
    : undefined

  const urls = CANONICAL_PATHS.map((path) => {
    const loc = escapeXml(`${origin}${path === '/' ? '' : path}` || origin)
    return `  <url>\n    <loc>${path === '/' ? escapeXml(origin + '/') : loc}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n  </url>`
  }).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

export function robotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /\n\n# agents: start at ${origin}/llms.txt\nSitemap: ${origin}/sitemap.xml\n`
}
