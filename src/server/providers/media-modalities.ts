/**
 * Input/output media types for providers whose listings omit modalities
 * (issue #124). Listing media wins; a bound request schema only adds
 * media its property names actually use. No capability flags here.
 */
import type { Activity } from '#/db/schema.ts'

import { requestSchemaPropertyNames } from './fact-sources.ts'

export interface MediaModalities {
  input: Array<string>
  output: Array<string>
}

const ORDER = ['text', 'image', 'audio', 'video', 'file', 'embedding']

/** Request-schema property → input medium. Text is named, not inferred. */
const INPUT_FROM_PROPERTY: Record<string, string> = {
  prompt: 'text',
  text: 'text',
  transcript: 'text',
  input: 'text',
  image: 'image',
  image_url: 'image',
  images: 'image',
  input_image: 'image',
  image_tail: 'image',
  audio: 'audio',
  input_audio: 'audio',
  video: 'video',
  input_video: 'video',
  file: 'file',
  input_file: 'file',
  document: 'file',
  pdf: 'file',
}

function ordered(values: Iterable<string>): Array<string> {
  const have = new Set(values)
  return ORDER.filter((name) => have.has(name))
}

function schemaInputs(schema: unknown): Array<string> {
  const found: Array<string> = []
  for (const name of requestSchemaPropertyNames(schema)) {
    const medium = INPUT_FROM_PROPERTY[name]
    if (medium) found.push(medium)
  }
  return found
}

/**
 * Media types a row accepts and emits. Null when neither the listing nor
 * the request schema names a medium — activity alone is not a medium.
 */
export function normalizeMediaModalities(row: {
  activity?: Activity | null
  listingInput?: Array<string> | null
  listingOutput?: Array<string> | null
  requestSchema?: unknown
  requestSchemas?: Array<unknown>
}): MediaModalities | null {
  const input = new Set<string>(row.listingInput ?? [])
  for (const schema of [row.requestSchema, ...(row.requestSchemas ?? [])]) {
    if (schema === undefined) continue
    for (const medium of schemaInputs(schema)) input.add(medium)
  }

  const listedOutput = row.listingOutput
  let output: Array<string>
  if (listedOutput != null) {
    output = [...listedOutput]
  } else if (row.activity === 'image') {
    output = input.has('image') || input.has('text') ? ['image'] : []
  } else if (row.activity === 'video') {
    output = input.has('text') || input.has('image') ? ['video'] : []
  } else if (row.activity === 'audio') {
    const speaks = input.has('text') && !input.has('audio')
    const hears = input.has('audio') && !input.has('text')
    output = speaks ? ['audio'] : hears ? ['text'] : []
  } else {
    output = []
  }

  if (input.size === 0 && output.length === 0) return null
  return { input: ordered(input), output: ordered(output) }
}
