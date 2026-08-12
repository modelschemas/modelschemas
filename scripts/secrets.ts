/**
 * Shared Doppler I/O and the remove list used by pull-secrets / push-secrets.
 *
 * Doppler is the source of truth. Every name in a config is synced except
 * those matching {@link REMOVE_LIST} — today just the `DOPPLER_*` context
 * vars Doppler injects to describe itself. Those are not application
 * secrets; pushing them is how the deployed Worker ended up with three
 * junk bindings.
 *
 * Values stay in memory in this module. Callers decide whether they ever
 * hit disk (pull writes `.env.local`; push never does).
 */
import { spawnSync } from 'node:child_process'

/** Names matching any of these are never pulled or pushed. */
export const REMOVE_LIST: ReadonlyArray<RegExp> = [/^DOPPLER_/]

/**
 * Extra names push skips. `BETTER_AUTH_URL` is already a wrangler `vars`
 * binding; a secret of the same name is rejected. Pull still writes it —
 * local JWT audiences are origin-bound to `http://localhost:3100`.
 */
export const PUSH_REMOVE_LIST: ReadonlyArray<RegExp> = [
  ...REMOVE_LIST,
  /^BETTER_AUTH_URL$/,
]

export function isRemoved(
  name: string,
  list: ReadonlyArray<RegExp> = REMOVE_LIST,
): boolean {
  return list.some((pattern) => pattern.test(name))
}

/** Drop remove-listed names and empty values. */
export function withoutRemoved(
  secrets: Record<string, string>,
  list: ReadonlyArray<RegExp> = REMOVE_LIST,
): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(secrets)) {
    if (!isRemoved(name, list) && value !== '') kept[name] = value
  }
  return kept
}

export function parseConfigFlag(argv: Array<string>, fallback: string): string {
  const index = argv.indexOf('--config')
  if (index === -1) return fallback
  return argv[index + 1] ?? fallback
}

export function run(
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

/** Every secret in the Doppler config. Held in memory; never persisted. */
export function dopplerSecrets(config: string): Record<string, string> {
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

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    out[key] = decodeEnvValue(line.slice(eq + 1))
  }
  return out
}

export function formatEnvFile(
  secrets: Record<string, string>,
  header: Array<string>,
): string {
  const lines = header.map((line) => `# ${line}`)
  if (lines.length > 0) lines.push('')
  for (const name of Object.keys(secrets).sort()) {
    const value = secrets[name]
    if (value === undefined) continue
    lines.push(`${name}=${encodeEnvValue(value)}`)
  }
  return lines.join('\n') + '\n'
}

function encodeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=-]*$/.test(value)) return value
  if (!value.includes("'")) return `'${value}'`
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\$/g, '\\$')}"`
}

function decodeEnvValue(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1)
  }
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\\$/g, '$')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  return raw
}
