// Regenerates skill/modelschemas/SKILL.md from src/server/skill.ts (task
// 7.6). The committed file is pinned to the module by a unit test.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { skillMd } from '../src/server/skill.ts'

const dir = join(import.meta.dirname, '..', 'skill', 'modelschemas')
mkdirSync(dir, { recursive: true })
const out = join(dir, 'SKILL.md')
writeFileSync(out, skillMd)
console.log(`wrote ${out}`)
