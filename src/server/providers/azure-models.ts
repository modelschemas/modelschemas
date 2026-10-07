/**
 * Azure OpenAI catalog facts from two Microsoft Learn articles, read as
 * their markdown twins (`Accept: text/markdown`), plus the chat request
 * body in Azure's v1 OpenAPI document.
 *
 * The models article has one `Model ID` table per family under a `## `
 * heading; the heading and the table's columns give the activity, and the
 * row gives the token limits and a capability list. The reasoning article
 * has a feature matrix with one column per model; where a model has a
 * column there, its ✅ / - cells win over the capability list.
 *
 * Accepted `reasoning_effort` values are the feature table's options, cut
 * down by the "works only with" clauses and footnote 7. A model the matrix
 * marks as supporting reasoning effort and whose rules do not name gets
 * `low`, `medium`, and `high`.
 */
import type { Activity } from '#/db/schema.ts'

import { MODALITIES_SOURCE_SILENT } from './fact-sources.ts'
import { markdownTableRows, tokenCount } from './model-facts.ts'
import type { ChatRequestMap, EffortLevelMap } from './request-map.ts'
import type {
  FactSource,
  ModelFactSources,
  ModelInfo,
  ModelReasoning,
} from './types.ts'

export const AZURE_MODELS_URL =
  'https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure'
export const AZURE_REASONING_URL =
  'https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning'

/** `## ` headings whose `Model ID` tables are not chat models. */
const SECTION_ACTIVITY: Array<[RegExp, Activity]> = [
  [/^Embeddings/i, 'embeddings'],
  [/^Image generation/i, 'image'],
  [/^Video generation/i, 'video'],
  [/^Audio/i, 'audio'],
]

/** Tables that repeat ids from the family sections with no model facts. */
const SKIPPED_SECTION = /^(Fine-tuning|Assistants|Model retirement)/i

export interface AzureModelRow {
  rawId: string
  /**
   * False for an id the article names only in running text. Such a row
   * carries no facts, and the caller lists it only when the price list
   * meters it: `o3-deep-research` is served, `gpt-5.6` is a family name.
   */
  tabulated: boolean
  /** `YYYY-MM-DD` of the row's model version, when the row dates it. */
  version: string | null
  retired: boolean
  activity: Activity | null
  contextWindow: number | null
  maxOutput: number | null
  modalities: { input: Array<string>; output: Array<string> } | null
  capabilities: Array<string>
  chatCompletions: boolean
  responses: boolean
  /**
   * The models article says this id uses a fixed reasoning level and
   * rejects `reasoning_effort`.
   */
  fixedReasoningEffort: boolean
  /** The models article says `reasoning_effort` `none` is not supported. */
  noneExcluded: boolean
}

/** One model's column in the reasoning article's feature matrix. */
export interface AzureFeatureColumn {
  capabilities: Array<string>
  modalities: { input: Array<string>; output: Array<string> } | null
  chatCompletions: boolean | null
  responses: boolean | null
  /** The reasoning-effort cell is ✅. */
  effort: boolean
  /** The row label says the accepted values include `none`. */
  effortIncludesNone: boolean
  /** Null when that matrix has no Developer Messages row. */
  developerMessages: boolean | null
  /** Null when that matrix has no `max_completion_tokens` row. */
  maxCompletionTokens: boolean | null
}

/** Link targets hold words like `reasoning` that are not statements. */
function plain(cell: string): string {
  return cell.replace(/\]\([^)]*\)/g, ']')
}

function descriptionModalities(text: string): AzureModelRow['modalities'] {
  const output = /text output|text only|text out\b|input\/output/i.test(text)
    ? ['text']
    : []
  if (
    /text and image (?:processing|input)|input\*\*: text\/image|image \(input\)/i.test(
      text,
    )
  ) {
    return { input: ['text', 'image'], output }
  }
  if (/text in\/text out only|text-only processing/i.test(text)) {
    return { input: ['text'], output }
  }
  return null
}

function descriptionCapabilities(text: string): Array<string> {
  const caps: Array<string> = []
  if (/\bfunctions?\b|\btools\b/i.test(text)) caps.push('tools')
  if (/\breasoning\b/i.test(text)) caps.push('reasoning')
  if (/structured outputs/i.test(text)) {
    caps.push('structured_outputs', 'response_format')
  }
  return caps
}

/**
 * The `Context Window` cell: `400,000Input: 272,000Output: 128,000` is
 * 400,000. A cell that lists a limit per deployment type gives the
 * `standard deployments` one, the tier prices are read for. Any other
 * mix of limits is not guessed at.
 */
export function azureContextWindow(cell: string): number | null {
  const limits = [
    ...(cell.split(/Input:/i)[0] ?? '').matchAll(
      /([\d,]*\d)\s*(?:\(([^)]*)\))?/g,
    ),
  ]
  const only = limits.length === 1 ? limits[0] : undefined
  if (only && only[2] === undefined) return tokenCount(only[1])
  const standard = limits.filter((limit) =>
    /^standard deployments$/i.test(limit[2]?.trim() ?? ''),
  )
  return standard.length === 1 ? tokenCount(standard[0]?.[1]) : null
}

/** Newest non-retired row wins; a model with only retired rows keeps one. */
function better(next: AzureModelRow, current: AzureModelRow): boolean {
  if (next.retired !== current.retired) return !next.retired
  return (next.version ?? '') > (current.version ?? '')
}

/**
 * Every model the Azure OpenAI pivot tabulates, by id, then the ids it names
 * only in running text.
 */
export function parseAzureModels(markdown: string): Map<string, AzureModelRow> {
  // Learn serves the twin with CRLF line ends in places.
  const text = markdown.replace(/\r/g, '')
  const start = text.indexOf('::: zone pivot="azure-openai"')
  const end = text.indexOf('::: zone-end', start)
  const zone = start < 0 ? '' : text.slice(start, end < 0 ? undefined : end)

  const out = new Map<string, AzureModelRow>()
  for (const section of zone.split(/\n## /).slice(1)) {
    const heading = section.slice(0, section.indexOf('\n')).trim()
    if (SKIPPED_SECTION.test(heading)) continue
    const sectionActivity = SECTION_ACTIVITY.find(([pattern]) =>
      pattern.test(heading),
    )?.[1]
    const listedChat = /listed models support the Chat Completions API/i.test(
      section,
    )
    const responseVersions = listedResponses(section)

    let columns: Array<string> | null = null
    for (const cells of markdownTableRows(section)) {
      if (cells[0] === 'Model ID') {
        columns = cells.map((cell) => cell.toLowerCase())
        continue
      }
      if (!columns) continue
      const cell = (name: string): string | undefined => {
        const index = columns?.indexOf(name) ?? -1
        return index < 0 ? undefined : cells[index]
      }
      const window = cell('context window')
      const request = cell('max request (tokens)')
      // Without a token-limit column the family is not a chat family.
      const activity =
        sectionActivity ?? (window != null || request != null ? 'chat' : null)
      const input = request?.match(/Input:\s*([\d,]+)/)?.[1]
      const description = plain(cell('description') ?? '')

      const idCell = cells[0] ?? ''
      const retired = /\*\*Retired/.test(idCell)
      const trailing = idCell.replace(/`[^`]+`|\^\d+\^|\([^)]*\)/g, ' ')
      const described = descriptionModalities(description)
      const vision = /\bwith vision\b/i.test(trailing)
        ? { input: ['text', 'image'], output: [] }
        : null
      for (const match of idCell.matchAll(
        /`([^`]+)`(?:\^\d+\^)?\s*(?:\(([^)]*)\))?/g,
      )) {
        const rawId = match[1]?.trim()
        if (!rawId) continue
        const version = match[2]?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null
        const row: AzureModelRow = {
          rawId,
          tabulated: true,
          version,
          retired,
          activity,
          contextWindow:
            window != null
              ? azureContextWindow(window)
              : tokenCount(
                  input ?? (/^[\d,]+$/.test(request ?? '') ? request : ''),
                ),
          maxOutput: tokenCount(
            cell('max output tokens') ??
              request?.match(/Output:\s*([\d,]+)/)?.[1],
          ),
          modalities: described ?? vision,
          capabilities: descriptionCapabilities(description),
          chatCompletions:
            listedChat || /chat completions api/i.test(description),
          responses:
            (responseVersions.get(rawId)?.has(version ?? '') ?? false) ||
            /responses api/i.test(description),
          fixedReasoningEffort: false,
          noneExcluded: false,
        }
        const current = out.get(rawId)
        if (!current || better(row, current)) out.set(rawId, row)
      }
    }
  }
  if (out.size === 0) return out

  for (const match of zone.matchAll(
    /`([^`]+)` uses a fixed, nonzero reasoning level[\s\S]{0,320}?`reasoning_effort`/g,
  )) {
    const namedRow = out.get(match[1] ?? '')
    if (namedRow) namedRow.fixedReasoningEffort = true
  }
  for (const match of zone.matchAll(
    /Reasoning effort `none` is not supported with `([^`]+)`/g,
  )) {
    const namedRow = out.get(match[1] ?? '')
    if (namedRow) namedRow.noneExcluded = true
  }

  const prose = zone
    .split('\n')
    .filter((line) => !line.startsWith('|'))
    .join('\n')
  for (const match of prose.matchAll(/`([a-z][a-z0-9.-]*)`/g)) {
    const rawId = match[1]
    if (!rawId || out.has(rawId)) continue
    out.set(rawId, {
      rawId,
      tabulated: false,
      version: null,
      retired: false,
      activity: null,
      contextWindow: null,
      maxOutput: null,
      modalities: null,
      capabilities: [],
      chatCompletions: false,
      responses: false,
      fixedReasoningEffort: false,
      noneExcluded: false,
    })
  }
  return out
}

/**
 * Versions the GPT-4 section names as also serving the Responses API.
 * Empty when that sentence is absent.
 */
function listedResponses(section: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const clause =
    /GPT-4o versions ([\s\S]*?), and GPT-4o-mini version `(\d{4}-\d{2}-\d{2})`/.exec(
      section,
    )
  const dates = clause?.[1]
  if (dates) {
    out.set(
      'gpt-4o',
      new Set(
        [...dates.matchAll(/`(\d{4}-\d{2}-\d{2})`/g)]
          .map((match) => match[1])
          .filter((date): date is string => date !== undefined),
      ),
    )
  }
  const mini = clause?.[2]
  if (mini) out.set('gpt-4o-mini', new Set([mini]))
  return out
}

const MATRIX_CAPABILITIES: Array<[RegExp, Array<string>]> = [
  [/^functions\/tools/i, ['tools']],
  [/^structured outputs/i, ['structured_outputs', 'response_format']],
]

function modalityWords(cell: string): Array<string> {
  return ['text', 'image'].filter((word) => cell.toLowerCase().includes(word))
}

/** The `Feature` matrices of the reasoning article, by model id. */
export function parseAzureFeatureMatrix(
  markdown: string,
): Map<string, AzureFeatureColumn> {
  const out = new Map<string, AzureFeatureColumn>()
  let ids: Array<string | null> = []
  for (const cells of markdownTableRows(markdown.replace(/\r/g, ''))) {
    const label = plain(cells[0] ?? '')
      .replace(/[*[\]`]|\^[^^]*\^/g, '')
      .trim()
    if (label === 'Feature') {
      // `**gpt-5.4**,**2026-03-05**` → `gpt-5.4`. The plain
      // `Feature | Description` table has no model columns.
      ids = cells.map((cell, index) =>
        index === 0 || !cell.startsWith('**')
          ? null
          : (cell.replace(/\*/g, '').split(',')[0]?.trim() ?? null),
      )
      for (const id of ids) {
        if (!id || out.has(id)) continue
        out.set(id, {
          capabilities: [],
          modalities: null,
          chatCompletions: null,
          responses: null,
          effort: false,
          effortIncludesNone: false,
          developerMessages: null,
          maxCompletionTokens: null,
        })
      }
      continue
    }
    for (const [index, id] of ids.entries()) {
      const column = id ? out.get(id) : undefined
      const cell = cells[index]
      if (!column || cell == null) continue
      const yes = cell.startsWith('✅')
      const caps = MATRIX_CAPABILITIES.find(([pattern]) => pattern.test(label))
      if (/^reasoning effort/i.test(label)) {
        if (yes) {
          column.capabilities.push('reasoning')
          column.effort = true
          if (/including none/i.test(label)) column.effortIncludesNone = true
        }
      } else if (caps && yes) column.capabilities.push(...caps[1])
      else if (/^developer messages/i.test(label)) {
        column.developerMessages = yes
      } else if (/^max_completion_tokens/i.test(label)) {
        column.maxCompletionTokens = yes
      } else if (/^image input/i.test(label)) {
        column.modalities = {
          input: yes ? ['text', 'image'] : ['text'],
          output: column.modalities?.output ?? [],
        }
      } else if (/^input modalities/i.test(label)) {
        column.modalities = {
          input: modalityWords(cell),
          output: column.modalities?.output ?? [],
        }
      } else if (/^output modalities/i.test(label)) {
        column.modalities = {
          input: column.modalities?.input ?? [],
          output: modalityWords(cell),
        }
      } else if (/^chat completions api/i.test(label)) {
        column.chatCompletions = yes
      } else if (/^responses api/i.test(label)) {
        column.responses = yes
      }
    }
  }
  return out
}

function docsSource(sourceUrl: string, sourceHash: string) {
  return (path: string): FactSource => ({
    derivation: 'docs-derived',
    sourceUrl,
    sourceHash,
    path,
  })
}

const EFFORT_ORDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

/** Constraints the reasoning article states once for every matrix column. */
export interface AzureEffortRules {
  maxFamilies: Array<string>
  /** `max` is stated for the Responses API. */
  maxNeedsResponses: boolean
  xhighFamilies: Array<string>
  /** `minimal` is limited to the original GPT-5 ids, minus `minimalExcluded`. */
  minimalOriginalGpt5: true
  minimalExcluded: Array<string>
  /** Footnote 7, plus a matrix label that says "including none". */
  noneFamilies: Array<string>
  /** An id the article says supports only one level. */
  onlySupports: Array<{ id: string; level: string }>
}

function articleClause(text: string, label: string, pattern: RegExp): string {
  const match = pattern.exec(text)
  const clause = match?.[1]
  if (!clause) {
    throw new Error(`azure reasoning article: ${label} did not parse`)
  }
  return clause
}

function familyTokens(clause: string): Array<string> {
  const tokens: Array<string> = []
  for (const match of clause.matchAll(/`([^`]+)`|GPT-(\d[\d.]*)/g)) {
    const token = (match[1] ?? `gpt-${match[2] ?? ''}`).toLowerCase()
    if (token.startsWith('gpt-')) tokens.push(token)
  }
  return tokens
}

function requireTokens(clause: string, label: string): Array<string> {
  const tokens = familyTokens(clause)
  if (tokens.length === 0) {
    throw new Error(`azure reasoning article: ${label} names no model`)
  }
  return tokens
}

/**
 * The reasoning article's effort options and the clauses that restrict
 * them. Throws when a clause the catalog depends on is missing, so a
 * reshaped page cannot be read as "every model accepts every option".
 */
export function parseAzureEffortRules(markdown: string): AzureEffortRules {
  const text = markdown.replace(/\r/g, '').replace(/\\([_*])/g, '$1')
  articleClause(
    text,
    'effort options',
    /\*\*Options \(model-dependent\)\*\*:\s*(`none`,\s*`minimal`,\s*`low`,\s*`medium`,\s*`high`,\s*`xhigh`,\s*`max`)/,
  )
  const maxClause = articleClause(
    text,
    'max clause',
    /`max` works only with (.+?)\. `xhigh`/,
  )
  if (!/Responses API/i.test(maxClause)) {
    throw new Error(
      'azure reasoning article: max clause does not name the Responses API',
    )
  }
  const xhighClause = articleClause(
    text,
    'xhigh clause',
    /`xhigh` works only with (.+?)\. `minimal`/,
  )
  if (
    !/`minimal` works only with the original GPT-5 reasoning models/.test(
      text,
    ) ||
    !/`minimal` doesn['’]t work with `gpt-5\.1` or greater/.test(text)
  ) {
    throw new Error('azure reasoning article: minimal clause did not parse')
  }
  const noneClause = articleClause(
    text,
    'none footnote',
    /\^7\^((?:`[^`]+`(?:,\s*|,\s*and\s+|\s+and\s+)?)*)\s*support `'None'`/,
  )
  const minimalExcluded = [
    ...text.matchAll(
      /`([^`]+)` also does not support `reasoning_effort``minimal`/g,
    ),
  ]
    .map((match) => match[1])
    .filter((id): id is string => id !== undefined)
  if (minimalExcluded.length === 0) {
    throw new Error('azure reasoning article: minimal exclusion did not parse')
  }
  const onlySupports = [
    ...text.matchAll(/`([^`]+)` only supports `reasoning_effort``([^`]+)`/g),
  ].map((match) => ({ id: match[1] ?? '', level: match[2] ?? '' }))
  if (
    onlySupports.length === 0 ||
    onlySupports.some(
      (item) =>
        item.id === '' ||
        !(EFFORT_ORDER as ReadonlyArray<string>).includes(item.level),
    )
  ) {
    throw new Error(
      'azure reasoning article: only-supports clause did not parse',
    )
  }
  return {
    maxFamilies: requireTokens(maxClause, 'max clause'),
    maxNeedsResponses: true,
    xhighFamilies: requireTokens(xhighClause, 'xhigh clause'),
    minimalOriginalGpt5: true,
    minimalExcluded,
    noneFamilies: requireTokens(noneClause, 'none footnote'),
    onlySupports,
  }
}

function familyHits(
  tokens: Array<string>,
  id: string,
  columnIds: ReadonlySet<string>,
): boolean {
  return tokens.some((token) => {
    if (token === id) return true
    // A token that is itself a matrix column (`gpt-5.4`) does not cover
    // `gpt-5.4-mini`. A family token (`gpt-5.6`, `gpt-6`) does.
    if (columnIds.has(token)) return false
    return id.startsWith(`${token}-`) || id.startsWith(`${token}.`)
  })
}

/** `gpt-5`, `gpt-5-mini`, `gpt-5-nano`: not a dotted release such as 5.1. */
function originalGpt5(id: string): boolean {
  return id === 'gpt-5' || (/^gpt-5-[a-z]/.test(id) && !id.includes('.'))
}

function levelMap(efforts: Array<string>): EffortLevelMap {
  const has = (level: string) => efforts.includes(level)
  return {
    off: has('none') ? 'none' : null,
    minimal: has('minimal') ? 'minimal' : null,
    low: has('low') ? 'low' : null,
    medium: has('medium') ? 'medium' : null,
    high: has('high') ? 'high' : null,
    xhigh: has('xhigh') ? 'xhigh' : null,
    max: has('max') ? 'max' : null,
  }
}

function effortReasoning(
  row: AzureModelRow,
  column: AzureFeatureColumn,
  rules: AzureEffortRules,
  columnIds: ReadonlySet<string>,
): ModelReasoning {
  const id = row.rawId
  const only = rules.onlySupports.find((item) => item.id === id)
  let efforts: Array<string>
  let mandatory: boolean | null
  if (only) {
    efforts = [only.level]
    mandatory = true
  } else {
    const picked = new Set<string>(['low', 'medium', 'high'])
    if (
      column.effortIncludesNone ||
      familyHits(rules.noneFamilies, id, columnIds)
    ) {
      picked.add('none')
    }
    if (originalGpt5(id) && !rules.minimalExcluded.includes(id)) {
      picked.add('minimal')
    }
    if (familyHits(rules.xhighFamilies, id, columnIds)) picked.add('xhigh')
    const responses = column.responses ?? row.responses
    if (
      familyHits(rules.maxFamilies, id, columnIds) &&
      (!rules.maxNeedsResponses || responses)
    ) {
      picked.add('max')
    }
    if (row.noneExcluded) picked.delete('none')
    efforts = EFFORT_ORDER.filter((level) => picked.has(level))
    if (efforts.includes('none')) mandatory = false
    else if (row.noneExcluded) mandatory = true
    else mandatory = null
  }
  if (efforts.length === 0) {
    throw new Error(`azure: ${id} effort list parsed empty`)
  }
  return { mode: 'effort', mandatory, efforts }
}

function azureRequestMap(
  row: AzureModelRow,
  column: AzureFeatureColumn | undefined,
  reasoning: ModelReasoning | undefined,
  chatMaxTokens: 'max_completion_tokens' | null,
): ChatRequestMap | null {
  const efforts = reasoning?.efforts ?? []
  const chat = column?.chatCompletions ?? row.chatCompletions
  let maxTokensField: ChatRequestMap['maxTokensField'] = null
  if (chat && column?.maxCompletionTokens !== false) {
    if (column?.maxCompletionTokens === true || chatMaxTokens !== null) {
      maxTokensField = 'max_completion_tokens'
    }
  }
  const developerRole =
    column?.developerMessages === true
      ? true
      : column?.developerMessages === false
        ? false
        : null
  const reasoningEffort = reasoning
    ? true
    : row.fixedReasoningEffort
      ? false
      : null
  const onLevel = efforts.includes('high') ? 'high' : efforts.at(-1)
  const thinking =
    reasoning && onLevel
      ? {
          on: { reasoning_effort: onLevel },
          off: efforts.includes('none') ? { reasoning_effort: 'none' } : null,
          levels: levelMap(efforts),
        }
      : null
  if (
    thinking === null &&
    maxTokensField === null &&
    developerRole === null &&
    reasoningEffort === null
  ) {
    return null
  }
  return {
    thinking,
    maxTokensField,
    developerRole,
    replayReasoningContent: null,
    store: null,
    strictTools: null,
    sessionAffinity: null,
    cacheControl: null,
    toolStream: null,
    reasoningEffort,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** First object under `node` whose properties include the chat token fields. */
function findChatBody(node: unknown): Record<string, unknown> | null {
  if (!isRecord(node)) return null
  const props = node.properties
  if (
    isRecord(props) &&
    'max_completion_tokens' in props &&
    'max_tokens' in props &&
    'messages' in props
  ) {
    return props
  }
  for (const value of Object.values(node)) {
    const found = findChatBody(value)
    if (found) return found
  }
  return null
}

/**
 * The chat completions body deprecates `max_tokens` in favor of
 * `max_completion_tokens`. Throws when that statement is absent.
 */
export function azureChatMaxTokensField(
  spec: unknown,
): 'max_completion_tokens' {
  const paths = isRecord(spec) ? spec.paths : undefined
  const chat = isRecord(paths) ? paths['/chat/completions'] : undefined
  const props = findChatBody(chat)
  const maxTokens = props ? props.max_tokens : undefined
  const description = isRecord(maxTokens) ? maxTokens.description : undefined
  if (
    typeof description === 'string' &&
    /deprecated in favor of `max_completion_tokens`/i.test(description)
  ) {
    return 'max_completion_tokens'
  }
  throw new Error(
    'azure spec: chat body does not deprecate max_tokens in favor of max_completion_tokens',
  )
}

/**
 * One catalog row. Where the model has a matrix column, it wins over the
 * models article for capabilities, stated modalities, and the API served.
 * `facts` carries the effort rules and the chat spec's max-token field;
 * without it, reasoning and the request map stay unset.
 */
export function azureModelInfo(
  row: AzureModelRow,
  column: AzureFeatureColumn | undefined,
  hashes: { models: string; reasoning: string },
  facts?: {
    rules: AzureEffortRules
    columnIds: ReadonlySet<string>
    chatMaxTokens: 'max_completion_tokens' | null
  },
): ModelInfo {
  const models = docsSource(AZURE_MODELS_URL, hashes.models)
  const matrix = docsSource(AZURE_REASONING_URL, hashes.reasoning)
  const chat = row.activity === 'chat'

  const capabilities = chat
    ? [...new Set([...(column?.capabilities ?? []), ...row.capabilities])]
    : []
  // Each side from whichever source states it: the GPT-5 matrix has an
  // image-input row and no output row.
  const fromMatrix = (column?.modalities?.input.length ?? 0) > 0
  const input = fromMatrix ? column?.modalities?.input : row.modalities?.input
  const output = column?.modalities?.output.length
    ? column.modalities.output
    : (row.modalities?.output ?? [])
  const modalities = input ? { input, output } : null
  const chatCompletions = column?.chatCompletions ?? row.chatCompletions
  const responses = column?.responses ?? row.responses

  const factSources: ModelFactSources = {}
  if (row.contextWindow != null) {
    factSources.contextWindow = models('contextWindow')
  }
  if (row.maxOutput != null) factSources.maxOutput = models('maxOutput')
  if (modalities) {
    factSources.modalities = (fromMatrix ? matrix : models)('modalities')
  } else if (chat) {
    factSources.modalities = models(MODALITIES_SOURCE_SILENT)
  }
  if (capabilities.length > 0) {
    factSources.capabilities = Object.fromEntries(
      capabilities.map((flag) => [
        flag,
        (column?.capabilities.includes(flag) ? matrix : models)(
          `capabilities.${flag}`,
        ),
      ]),
    )
  }

  const reasoning =
    facts && column?.effort && !row.fixedReasoningEffort
      ? effortReasoning(row, column, facts.rules, facts.columnIds)
      : undefined
  if (reasoning) factSources.reasoning = matrix('reasoning_effort')
  const requestMap = facts
    ? azureRequestMap(row, column, reasoning, facts.chatMaxTokens)
    : undefined

  return {
    rawId: row.rawId,
    activity: row.activity,
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    modalities,
    capabilities: capabilities.length > 0 ? capabilities : null,
    // A chat model that serves only the Responses API binds to that route.
    schemaEndpointId: !chat
      ? null
      : chatCompletions
        ? 'chat/completions'
        : responses
          ? 'responses'
          : null,
    deprecated: row.retired,
    pricing: null,
    ...(reasoning ? { reasoning } : {}),
    ...(requestMap ? { requestMap } : {}),
    factSources,
  }
}
