/**
 * Reconcile production Worker secrets against a Doppler config.
 *
 * Runs entirely on a trusted machine using credentials that are already
 * there — your Doppler CLI login and your wrangler login. Nothing new is
 * stored anywhere, no token is added to CI, and the blast radius stays
 * exactly what it is today: this laptop. That is the whole reason to prefer
 * it over a CI job, which would need a long-lived Doppler service token AND a
 * Cloudflare API token sitting in GitHub.
 *
 * Handling rules, because a careless version of this script is how secrets
 * leak:
 * - Values are held in memory only. Never written to disk, never passed as
 *   argv (visible in `ps`), never echoed. They reach wrangler over stdin.
 * - Only an ALLOWLIST derived from the code is pushed. Doppler configs carry
 *   `DOPPLER_*` context variables that are not application secrets; pushing
 *   those is how the deployed Worker ended up with three junk bindings.
 * - Nothing is ever deleted. `wrangler secret bulk` can delete via null, but
 *   this script never emits one — removing a secret stays a deliberate
 *   manual act.
 * - Dry run unless `--push` is passed.
 *
 * Secrets are written into a new Worker version rather than the live one;
 * the next deploy inherits them. See the push call at the bottom for why.
 *
 * Usage:
 *   bun scripts/push-secrets.ts                # reconcile + report
 *   bun scripts/push-secrets.ts --push         # apply
 *   bun scripts/push-secrets.ts --config stg   # non-prod target
 */
import { spawnSync } from 'node:child_process'

import { providerRegistry } from '../src/server/providers/index.ts'

/** Secrets the service needs that are not a provider credential. */
const SERVICE_SECRETS = ['ADMIN_KEY', 'BETTER_AUTH_SECRET'] as const

/**
 * Doppler injects these into every config to describe itself. They are not
 * application secrets and must never become Worker bindings — they are
 * already on the deployed Worker by mistake and pollute the generated `Env`
 * type.
 */
const NEVER_PUSH = /^DOPPLER_/

const args = new Set(process.argv.slice(2))
const push = args.has('--push')
const configIndex = process.argv.indexOf('--config')
const dopplerConfig =
  configIndex !== -1 ? (process.argv[configIndex + 1] ?? 'prd') : 'prd'

/**
 * The canonical set of secrets production should hold, derived from the
 * provider registry so it stays correct as providers are added.
 */
function expectedSecrets(): Array<string> {
  const fromProviders = providerRegistry
    .map((p) => p.authEnvVar)
    .filter((name): name is NonNullable<typeof name> => Boolean(name))
  return [...new Set<string>([...SERVICE_SECRETS, ...fromProviders])].sort()
}

function run(
  command: string,
  commandArgs: Array<string>,
  stdin?: string,
): string {
  const result = spawnSync(command, commandArgs, {
    input: stdin,
    encoding: 'utf8',
    // Inherit stderr so auth prompts and errors are visible, but capture
    // stdout so secret payloads never reach the terminal.
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs[0] ?? ''} failed`)
  }
  return result.stdout
}

/** Secret names currently bound to the deployed Worker (names only). */
function workerSecretNames(): Set<string> {
  const raw = run('bunx', ['wrangler', 'secret', 'list'])
  const parsed = JSON.parse(raw) as Array<{ name: string }>
  return new Set(parsed.map((s) => s.name))
}

/** Every secret in the Doppler config. Held in memory; never persisted. */
function dopplerSecrets(config: string): Record<string, string> {
  const raw = run('doppler', [
    'secrets',
    'download',
    '--no-file',
    '--format',
    'json',
    '--config',
    config,
  ])
  return JSON.parse(raw) as Record<string, string>
}

const expected = expectedSecrets()
const doppler = dopplerSecrets(dopplerConfig)
const onWorker = workerSecretNames()

const dopplerNames = Object.keys(doppler).filter((n) => !NEVER_PUSH.test(n))
const payload: Record<string, string> = {}
const rows: Array<[string, string]> = []

for (const name of expected) {
  const inDoppler = name in doppler
  const deployed = onWorker.has(name)
  if (inDoppler) {
    const value = doppler[name]
    if (value !== undefined && value !== '') payload[name] = value
    rows.push([name, deployed ? 'update' : 'CREATE'])
  } else {
    rows.push([name, deployed ? 'worker-only (not in Doppler)' : 'MISSING'])
  }
}

const width = Math.max(...rows.map(([name]) => name.length))
console.log(
  `\nDoppler config: ${dopplerConfig}   Worker: modelschemas   mode: ${
    push ? 'PUSH' : 'dry run'
  }\n`,
)
for (const [name, action] of rows) {
  console.log(`  ${name.padEnd(width)}  ${action}`)
}

// Anything in Doppler that the code does not expect: reported, never pushed.
const unexpected = dopplerNames.filter((n) => !expected.includes(n))
if (unexpected.length > 0) {
  console.log(`\n  not in the allowlist, skipped: ${unexpected.join(', ')}`)
}
const contextVars = Object.keys(doppler).filter((n) => NEVER_PUSH.test(n))
if (contextVars.length > 0) {
  console.log(`  Doppler context vars, never pushed: ${contextVars.join(', ')}`)
}

const missing = rows.filter(([, a]) => a === 'MISSING').map(([n]) => n)
const workerOnly = rows
  .filter(([, a]) => a.startsWith('worker-only'))
  .map(([n]) => n)
if (workerOnly.length > 0) {
  console.log(
    `\n  ${workerOnly.length} secret(s) live on the Worker but not in Doppler,` +
      ` so Doppler is not yet the source of truth:\n    ${workerOnly.join(', ')}` +
      `\n  Add them to the '${dopplerConfig}' config before relying on this script.`,
  )
}
if (missing.length > 0) {
  console.log(
    `\n  ${missing.length} expected secret(s) absent from BOTH:\n    ${missing.join(', ')}`,
  )
}

const count = Object.keys(payload).length
if (!push) {
  console.log(
    `\nDry run — nothing sent. ${count} secret(s) would be written.` +
      ` Re-run with --push to apply.\n`,
  )
  process.exit(0)
}
if (count === 0) {
  console.log('\nNothing to push.\n')
  process.exit(0)
}

/**
 * One API call, over stdin: no temp file, nothing in argv, nothing in shell
 * history. Deletions are impossible here because no key is ever set to null.
 *
 * `wrangler versions secret bulk` rather than the plain `wrangler secret
 * bulk`, which edits the live Worker and refuses with Cloudflare error 10215
 * whenever the newest uploaded version is not the deployed one — the normal
 * state here, since Workers Builds uploads a preview version on every
 * non-production branch push. The versions API has no such precondition, so
 * this always works.
 *
 * It writes the secrets into a NEW version instead of the live one, and
 * that is enough: a version inherits its bindings from the previous one, so
 * the next deploy carries these secrets forward automatically (verified on
 * this Worker — CI-uploaded versions list every secret despite CI never
 * seeing a value). Only the bindings inherit, not the code, so staging from
 * a branch cannot leak unmerged code into a later deploy.
 */
run('bunx', ['wrangler', 'versions', 'secret', 'bulk'], JSON.stringify(payload))
console.log(
  `\nWrote ${count} secret(s) into a new version.` +
    `\nThey go live with the next deploy, which inherits them.\n`,
)
