/**
 * The source-silent ledger (`docs/source-silent/<provider>.md`), bundled at
 * build time so the Worker scores completeness with the same files
 * `bun run gap:report` reads from disk. Vite and vitest transform
 * `import.meta.glob`; bun does not, so the script reads them with `fs`.
 */
import { parseLedger } from '#/lib/completeness.ts'

const files = import.meta.glob<string>(
  ['../../docs/source-silent/*.md', '!**/README.md'],
  { query: '?raw', import: 'default', eager: true },
)

export const sourceSilentLedger = parseLedger(Object.values(files).join('\n'))
