/** Shared text helpers for the Agent Platform docs parsers. */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
}

/** Tags stripped, entities decoded, whitespace collapsed. */
export function htmlText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<sup[\s\S]*?<\/sup>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-z]+|#\d+);/gi, (match, name: string) => {
      return ENTITIES[name.toLowerCase()] ?? match
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Display name → comparison key. Drops preview, parentheticals, and a
 * trailing introductory-price window so a card title matches its price row.
 */
export function normModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\*/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:through|starting)\b[\s\S]*$/i, ' ')
    .replace(/\bpreview\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
