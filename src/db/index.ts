import { drizzle } from 'drizzle-orm/d1'

import * as schema from './schema.ts'

export interface DbEnv {
  DB: D1Database
}

// Workers have no module-scope env: the D1 binding only exists on the env
// object passed to fetch/scheduled handlers, so the db client is built per
// request rather than exported as a singleton.
export function getDb(env: DbEnv) {
  return drizzle(env.DB, { schema })
}

export type Db = ReturnType<typeof getDb>
