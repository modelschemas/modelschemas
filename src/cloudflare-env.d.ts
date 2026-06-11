// Typing for the `cloudflare:workers` env module (provided by workerd /
// the @cloudflare/vite-plugin). Declared locally for the same reason as
// cloudflare-test.d.ts: keeping Workers globals out of the DOM-flavoured
// app tsconfig. Extend WorkerBindings as wrangler.jsonc grows.
declare module 'cloudflare:workers' {
  import type { D1Database, KVNamespace } from '@cloudflare/workers-types'

  export interface WorkerBindings {
    DB: D1Database
    SCHEMA_CACHE: KVNamespace
    BETTER_AUTH_SECRET: string
    BETTER_AUTH_URL?: string
    ADMIN_KEY?: string
    OPENAI_API_KEY?: string
    ANTHROPIC_API_KEY?: string
    GEMINI_API_KEY?: string
    XAI_API_KEY?: string
    ELEVENLABS_API_KEY?: string
    FAL_KEY?: string
  }

  export const env: WorkerBindings

  /** Extends the current request's lifetime past the response (workerd-native). */
  export function waitUntil(promise: Promise<unknown>): void
}
