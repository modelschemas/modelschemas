import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '../db/index.ts'
import { createAuth } from './auth.ts'

const TEST_SECRET = 'vitest-only-better-auth-secret'

describe('better auth on D1 (real binding, migrated schema)', () => {
  it('signs up a user and retrieves the session via bearer token', async () => {
    const auth = createAuth(getDb(env), { secret: TEST_SECRET })

    const signUp = await auth.api.signUpEmail({
      body: {
        name: 'Worker Tester',
        email: 'worker-tester@example.com',
        password: 'correct-horse-battery',
      },
    })
    expect(signUp.user.email).toBe('worker-tester@example.com')
    expect(signUp.token).toBeTruthy()

    // The bearer plugin accepts the session token as an Authorization header.
    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${signUp.token}` }),
    })
    expect(session?.user.email).toBe('worker-tester@example.com')
  })

  it('persists the user row in D1', async () => {
    const auth = createAuth(getDb(env), { secret: TEST_SECRET })
    await auth.api.signUpEmail({
      body: {
        name: 'Row Tester',
        email: 'row-tester@example.com',
        password: 'correct-horse-battery',
      },
    })

    const row = await env.DB.prepare('SELECT email FROM user WHERE email = ?')
      .bind('row-tester@example.com')
      .first<{ email: string }>()
    expect(row?.email).toBe('row-tester@example.com')
  })
})
