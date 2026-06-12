#!/usr/bin/env bun
/**
 * modelschemas CLI (PLAN.md task 7.5) — thin command layer over
 * @modelschemas/client. `--json` everywhere (default when stdout is not a
 * TTY) so the CLI is itself agent-friendly.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  createModelschemasClient,
  getModel,
  getSchema,
  listChanges,
  listModels,
  listProviderSchemas,
  validatePayload,
} from '@modelschemas/client'

import {
  pull,
  readManifest,
  verify,
  verifyIntegrity,
} from '@modelschemas/codegen'
import type { OptionalStyle, PullConfig } from '@modelschemas/codegen'

import { mintAgentJwt, registerAgent, waitForActivation } from './agent-auth.ts'
import {
  credentialsPath,
  loadCredentials,
  saveCredentials,
} from './credentials.ts'
import type { Credentials } from './credentials.ts'

const HELP = `modelschemas — live AI model schemas

Usage: modelschemas <command> [options]

Commands:
  login [--name <n>] [--delegated] [--api-key]   register this machine
  whoami                                         show identity, grants, usage
  models list [--activity a] [--provider p] [--q text]
  models get <provider> <modelId>
  schema get <provider> <endpointId> [--kind input|output]
  validate <provider/endpointId> <file> [--kind input|output]
  changes [--since <epoch>] [--provider p] [--type t]
  subscribe <url> [--events e1,e2] [--provider p]
  pull <selection...> [--out dir] [--no-types] [--optional exact|undefined]
                                                 generate schema/type modules
                                                 (e.g. anthropic/v1/messages#request, gemini/*)
  update [--out dir]                             refresh pulled modules (selection
                                                 comes from the manifest)
  verify [--out dir]                             verify pulled modules: files match
                                                 the manifest AND the service still
                                                 serves bytes matching each pinned
                                                 content hash (reports provenance)

Options:
  --base-url <url>   service origin (default: $MODELSCHEMAS_URL or http://localhost:3100)
  --json             force JSON output (default when piped)
  -h, --help         this help
`

interface Ctx {
  baseUrl: string
  json: boolean
  values: Record<string, string | boolean | undefined>
  positionals: Array<string>
}

function output(ctx: Ctx, value: unknown): void {
  const pretty = !ctx.json && process.stdout.isTTY
  console.log(JSON.stringify(value, null, pretty ? 2 : 0))
}

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

async function authHeader(
  credentials: Credentials | null,
): Promise<string | undefined> {
  if (!credentials) return undefined
  if (credentials.type === 'api-key') return `Bearer ${credentials.apiKey}`
  return `Bearer ${await mintAgentJwt(credentials)}`
}

function makeClient(ctx: Ctx) {
  return createModelschemasClient({ baseUrl: ctx.baseUrl })
}

async function authedFetch(
  ctx: Ctx,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const header = await authHeader(loadCredentials())
  return fetch(`${ctx.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(header ? { Authorization: header } : {}),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
}

async function cmdLogin(ctx: Ctx): Promise<void> {
  const name = String(ctx.values.name ?? 'modelschemas-cli')
  if (ctx.values['api-key']) {
    const response = await fetch(`${ctx.baseUrl}/v1/agents/register-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!response.ok) fail(`register-key failed: ${await response.text()}`)
    const body = (await response.json()) as { key: string }
    const path = saveCredentials({
      type: 'api-key',
      baseUrl: ctx.baseUrl,
      apiKey: body.key,
    })
    output(ctx, { ok: true, type: 'api-key', credentials: path })
    return
  }

  const mode = ctx.values.delegated ? 'delegated' : 'autonomous'
  const registered = await registerAgent(ctx.baseUrl, { name, mode })
  const credentials: Credentials = {
    type: 'agent',
    baseUrl: ctx.baseUrl,
    ...registered.credentials,
  }
  const path = saveCredentials(credentials)

  if (mode === 'delegated' && registered.status !== 'active') {
    console.error(
      `approve this agent: ${registered.approval?.verificationUri ?? 'see your dashboard'}` +
        (registered.approval?.userCode
          ? ` (code: ${registered.approval.userCode})`
          : ''),
    )
    const activated = await waitForActivation(
      ctx.baseUrl,
      registered.credentials,
    )
    if (!activated) fail('approval timed out — re-run login once approved')
  }
  output(ctx, {
    ok: true,
    type: 'agent',
    mode,
    agentId: registered.credentials.agentId,
    status: registered.status,
    credentials: path,
  })
}

async function cmdWhoami(ctx: Ctx): Promise<void> {
  const credentials = loadCredentials()
  if (!credentials) fail("not logged in — run 'modelschemas login' first")
  const response = await authedFetch(ctx, '/v1/agents/me')
  if (!response.ok) fail(`whoami failed: ${await response.text()}`)
  output(ctx, await response.json())
}

async function cmdModels(ctx: Ctx): Promise<void> {
  const [sub, provider, modelId] = ctx.positionals
  const client = makeClient(ctx)
  if (sub === 'get') {
    if (!provider || !modelId) fail('usage: models get <provider> <modelId>')
    const result = await getModel({
      client,
      path: { provider, modelId },
    })
    if (result.error !== undefined) fail(JSON.stringify(result.error))
    output(ctx, result.data)
    return
  }
  const result = await listModels({
    client,
    query: {
      activity: ctx.values.activity as never,
      provider: ctx.values.provider as string | undefined,
      capability: ctx.values.capability as string | undefined,
      q: ctx.values.q as string | undefined,
    },
  })
  if (result.error !== undefined) fail(JSON.stringify(result.error))
  output(ctx, result.data)
}

async function resolveActivity(
  ctx: Ctx,
  provider: string,
  endpointId: string,
): Promise<string> {
  const client = makeClient(ctx)
  const index = await listProviderSchemas({ client, path: { provider } })
  if (index.error !== undefined) fail(JSON.stringify(index.error))
  const activities = (
    index.data as { activities: Record<string, Array<string>> }
  ).activities
  for (const [activity, ids] of Object.entries(activities)) {
    if (ids.includes(endpointId)) return activity
  }
  fail(
    `endpoint '${endpointId}' not found for ${provider}. Known: ${Object.values(activities).flat().join(', ')}`,
  )
}

async function cmdSchema(ctx: Ctx): Promise<void> {
  const [sub, provider, endpointId] = ctx.positionals
  if (sub !== 'get' || !provider || !endpointId) {
    fail('usage: schema get <provider> <endpointId> [--kind input|output]')
  }
  const activity = await resolveActivity(ctx, provider, endpointId)
  const result = await getSchema({
    client: makeClient(ctx),
    path: { provider, activity: activity as never, endpointId },
    query: { kind: (ctx.values.kind ?? 'input') as never },
  })
  if (result.error !== undefined) fail(JSON.stringify(result.error))
  output(ctx, result.data)
}

async function cmdValidate(ctx: Ctx): Promise<void> {
  const [target, file] = ctx.positionals
  if (!target?.includes('/') || !file) {
    fail('usage: validate <provider/endpointId> <payload.json>')
  }
  const slash = target.indexOf('/')
  const provider = target.slice(0, slash)
  const endpointId = target.slice(slash + 1)
  let payload: unknown
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`could not read payload file: ${String(error)}`)
  }
  const result = await validatePayload({
    client: makeClient(ctx),
    body: {
      provider,
      endpointId,
      kind: ctx.values.kind as never,
      payload,
    },
  })
  if (result.error !== undefined) fail(JSON.stringify(result.error))
  const verdict = result.data as { valid: boolean }
  output(ctx, result.data)
  // Agent-friendly: invalid payloads exit non-zero.
  if (!verdict.valid) process.exit(2)
}

async function cmdChanges(ctx: Ctx): Promise<void> {
  const result = await listChanges({
    client: makeClient(ctx),
    query: {
      since: ctx.values.since ? Number(ctx.values.since) : undefined,
      provider: ctx.values.provider as string | undefined,
      type: ctx.values.type as never,
    },
  })
  if (result.error !== undefined) fail(JSON.stringify(result.error))
  output(ctx, result.data)
}

async function cmdSubscribe(ctx: Ctx): Promise<void> {
  const [url] = ctx.positionals
  if (!url) fail('usage: subscribe <url> [--events e1,e2] [--provider p]')
  const events = String(ctx.values.events ?? 'model.added,model.removed')
    .split(',')
    .map((event) => event.trim())
  const response = await authedFetch(ctx, '/v1/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      url,
      events,
      provider: ctx.values.provider as string | undefined,
    }),
  })
  if (!response.ok) fail(`subscribe failed: ${await response.text()}`)
  output(ctx, await response.json())
}

export interface PullFlags {
  outDir: string
  types: boolean
  optionalStyle: OptionalStyle | undefined
}

/** Shared flag parsing for `pull`/`update` — exported for tests. */
export function parsePullFlags(
  values: Record<string, string | boolean | undefined>,
): PullFlags {
  const optional = values.optional
  if (
    optional !== undefined &&
    optional !== 'exact' &&
    optional !== 'undefined'
  ) {
    fail(`invalid --optional '${String(optional)}' — use exact or undefined`)
  }
  return {
    outDir: typeof values.out === 'string' ? values.out : 'src/modelschemas',
    types: values['no-types'] !== true,
    optionalStyle: optional,
  }
}

function pullApiKey(): string | undefined {
  if (process.env.MODELSCHEMAS_API_KEY !== undefined) {
    return process.env.MODELSCHEMAS_API_KEY
  }
  const credentials = loadCredentials()
  return credentials?.type === 'api-key' ? credentials.apiKey : undefined
}

async function runPull(ctx: Ctx, config: PullConfig): Promise<void> {
  const summary = await pull(config)
  output(ctx, summary)
  if (summary.failed.length > 0) process.exit(1)
}

async function cmdPull(ctx: Ctx): Promise<void> {
  if (ctx.positionals.length === 0) {
    fail(
      'usage: pull <selection...> [--out dir] [--no-types] [--optional exact|undefined]',
    )
  }
  const flags = parsePullFlags(ctx.values)
  await runPull(ctx, {
    baseUrl: ctx.baseUrl,
    apiKey: pullApiKey(),
    outDir: flags.outDir,
    selections: ctx.positionals,
    types: flags.types,
    optionalStyle: flags.optionalStyle,
    log: (message) => console.error(message),
  })
}

async function cmdUpdate(ctx: Ctx): Promise<void> {
  const flags = parsePullFlags(ctx.values)
  const manifest = await readManifest(flags.outDir)
  if (manifest === null) {
    fail(
      `no ${flags.outDir}/.manifest.json — run 'modelschemas pull <selection...>' first`,
    )
  }
  await runPull(ctx, {
    // Explicit --base-url wins; otherwise refresh from where we pulled.
    baseUrl:
      typeof ctx.values['base-url'] === 'string'
        ? ctx.baseUrl
        : manifest.baseUrl,
    apiKey: pullApiKey(),
    outDir: flags.outDir,
    selections: manifest.selections,
    types: manifest.types,
    optionalStyle: manifest.optionalStyle,
    log: (message) => console.error(message),
  })
}

async function cmdVerify(ctx: Ctx): Promise<void> {
  const flags = parsePullFlags(ctx.values)
  const manifest = await readManifest(flags.outDir)
  if (manifest === null) {
    fail(
      `no ${flags.outDir}/.manifest.json — run 'modelschemas pull <selection...>' first`,
    )
  }
  const config = {
    // Explicit --base-url wins; otherwise verify against where we pulled.
    baseUrl:
      typeof ctx.values['base-url'] === 'string'
        ? ctx.baseUrl
        : manifest.baseUrl,
    apiKey: pullApiKey(),
    outDir: flags.outDir,
    selections: manifest.selections,
    log: (message: string) => console.error(message),
  }
  const files = await verify(config)
  const integrity = await verifyIntegrity(config)
  const ok = files.ok && integrity.ok
  output(ctx, { ok, files, integrity })
  if (!ok) process.exit(2)
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      'base-url': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      name: { type: 'string' },
      delegated: { type: 'boolean' },
      'api-key': { type: 'boolean' },
      activity: { type: 'string' },
      provider: { type: 'string' },
      capability: { type: 'string' },
      q: { type: 'string' },
      kind: { type: 'string' },
      since: { type: 'string' },
      type: { type: 'string' },
      events: { type: 'string' },
      out: { type: 'string' },
      'no-types': { type: 'boolean' },
      optional: { type: 'string' },
    },
  })

  const [command, ...rest] = positionals
  if (values.help || !command) {
    console.log(HELP)
    process.exit(command ? 0 : 1)
  }

  const stored = loadCredentials()
  const ctx: Ctx = {
    baseUrl:
      values['base-url'] ??
      process.env.MODELSCHEMAS_URL ??
      stored?.baseUrl ??
      'http://localhost:3100',
    json: values.json ?? !process.stdout.isTTY,
    values,
    positionals: rest,
  }

  switch (command) {
    case 'login':
      return cmdLogin(ctx)
    case 'whoami':
      return cmdWhoami(ctx)
    case 'models':
      return cmdModels(ctx)
    case 'schema':
      return cmdSchema(ctx)
    case 'validate':
      return cmdValidate(ctx)
    case 'changes':
      return cmdChanges(ctx)
    case 'subscribe':
      return cmdSubscribe(ctx)
    case 'pull':
      return cmdPull(ctx)
    case 'update':
      return cmdUpdate(ctx)
    case 'verify':
      return cmdVerify(ctx)
    default:
      fail(`unknown command '${command}'.\n${HELP}`)
  }
}

// Only run when executed as the bin — not when imported (e.g. by tests).
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  })
}

// Referenced for help/tests; credentialsPath is part of the public surface.
export { credentialsPath, HELP }
