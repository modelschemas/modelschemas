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

/**
 * Like `run`, but captures stderr so the caller can inspect a failure. Only
 * used for the push itself: wrangler never echoes secret values, and we need
 * to recognise Cloudflare error 10215 (see `pushSecrets`).
 */
function runCapturing(
  command: string,
  commandArgs: Array<string>,
  stdin: string,
): { ok: boolean; stderr: string } {
  const result = spawnSync(command, commandArgs, {
    input: stdin,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return { ok: result.status === 0, stderr: result.stderr }
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
 * Two APIs exist and they are not interchangeable:
 *
 * - `wrangler secret bulk` edits the LIVE Worker. It refuses with Cloudflare
 *   error 10215 whenever the newest uploaded version is not the deployed one
 *   — which is the normal state here, because Workers Builds uploads a
 *   preview version for every non-production branch push.
 * - `wrangler versions secret bulk` sidesteps that by creating a NEW version
 *   carrying the secrets. It does not deploy, and it inherits from the newest
 *   version — which on a branch is unmerged code. So the secrets are staged,
 *   not live, and whoever deploys that version ships that code with it.
 *
 * The live path is the default because it is the one with no surprises. The
 * versions path is opt-in via `--versions` so that staging secrets against
 * undeployed code is always a deliberate choice.
 */
const body = JSON.stringify(payload)
const useVersions = args.has('--versions')
const pushArgs = useVersions
  ? ['wrangler', 'versions', 'secret', 'bulk']
  : ['wrangler', 'secret', 'bulk']

const attempt = runCapturing('bunx', pushArgs, body)
if (!attempt.ok) {
  process.stderr.write(attempt.stderr)
  if (!useVersions && attempt.stderr.includes('10215')) {
    console.error(
      `\nCloudflare refused the edit: the newest uploaded version of the Worker` +
        `\nis not the one currently deployed, so the live-secret API is blocked.` +
        `\nThat is expected while branch preview builds are uploading versions.` +
        `\n\nPick one:` +
        `\n  1. Deploy first, then re-run this. Merging to main triggers a` +
        `\n     Workers Builds deploy, after which latest == deployed and this` +
        `\n     command works unchanged. Best option in almost every case.` +
        `\n  2. Re-run with --versions to stage the secrets into a NEW version` +
        `\n     without deploying. Note it inherits the newest version's code,` +
        `\n     which on a branch is unmerged — the secrets go live only when` +
        `\n     that version is deployed.\n`,
    )
  }
  process.exit(1)
}

if (useVersions) {
  console.log(
    `\nStaged ${count} secret(s) into a new (undeployed) version.` +
      `\nThey are not live until that version is deployed.\n`,
  )
} else {
  console.log(`\nPushed ${count} secret(s) to the modelschemas Worker.\n`)
}
