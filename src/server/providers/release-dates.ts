/**
 * Release-date sources for providers whose models API carries no timestamp
 * (issue #1). Two mechanisms, tried in order:
 *
 * 1. A curated per-provider map of rawId → 'YYYY-MM-DD' (public announcement
 *    or first-availability date, UTC). Extend freely — unmapped models simply
 *    keep their poll-time firstSeenAt.
 * 2. For Gemini, a `MM-YYYY` suffix embedded in preview ids
 *    (e.g. `gemini-2.5-computer-use-preview-10-2025`) → first of that month.
 *
 * Providers that DO report a date (OpenAI/xAI/OpenRouter `created`,
 * Anthropic `created_at`, FAL `metadata.date`) parse it in their own
 * listModels; the shared epoch helpers live here.
 */

/** Epoch seconds for a `YYYY-MM-DD` date at UTC midnight. */
export function dateToEpoch(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000)
}

/** Epoch seconds from an ISO 8601 timestamp; null when unparseable. */
export function isoToEpochSeconds(
  iso: string | undefined | null,
): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

/**
 * Gemini preview ids often end in `-MM-YYYY` (announcement month). Returns
 * the first of that month, or null when the id carries no date.
 */
export function geminiIdSuffixDate(rawId: string): number | null {
  const match = /-(\d{2})-(\d{4})$/.exec(rawId)
  if (!match) return null
  const [, month, year] = match
  const m = Number(month)
  if (m < 1 || m > 12) return null
  return dateToEpoch(`${year}-${month}-01`)
}

/**
 * First public availability (preview counts), from ai.google.dev changelog
 * and Google announcement posts. Rolling `-latest` aliases and models with
 * no confirmable date are deliberately unmapped. Ids carrying a `-MM-YYYY`
 * suffix (computer-use, deep-research, native-audio previews, …) resolve
 * via geminiIdSuffixDate and need no entry here.
 */
export const GEMINI_RELEASE_DATES: Record<string, string> = {
  'gemini-2.0-flash': '2024-12-11',
  'gemini-2.0-flash-001': '2025-02-05',
  'gemini-2.0-flash-lite': '2025-02-05',
  'gemini-2.0-flash-lite-001': '2025-02-25',
  'gemini-2.5-pro': '2025-03-25',
  'gemini-2.5-flash': '2025-04-17',
  'gemini-2.5-flash-lite': '2025-07-22',
  'gemini-2.5-flash-image': '2025-08-26',
  'gemini-2.5-flash-preview-tts': '2025-05-20',
  'gemini-2.5-pro-preview-tts': '2025-05-20',
  'gemini-3-pro-preview': '2025-11-18',
  'gemini-3-flash-preview': '2025-12-17',
  'gemini-3-pro-image': '2025-11-20',
  'gemini-3-pro-image-preview': '2025-11-20',
  'nano-banana-pro-preview': '2025-11-20',
  'gemini-3.1-pro-preview': '2026-02-19',
  'gemini-3.1-pro-preview-customtools': '2026-02-19',
  'gemini-3.1-flash-lite-preview': '2026-03-03',
  'gemini-3.1-flash-lite': '2026-05-07',
  'gemini-3.1-flash-image': '2026-05-28',
  'gemini-3.1-flash-image-preview': '2026-05-28',
  'gemini-3.5-flash': '2026-05-19',
  'gemini-omni-flash-preview': '2026-06-30',
  'gemini-embedding-001': '2025-07-14',
  'gemini-embedding-2': '2026-04-22',
  'gemini-embedding-2-preview': '2026-04-22',
  'gemma-4-26b-a4b-it': '2026-04-02',
  'gemma-4-31b-it': '2026-04-02',
  'lyria-3-pro-preview': '2026-03-25',
  'veo-3.1-generate-preview': '2025-10-15',
  'veo-3.1-fast-generate-preview': '2025-10-15',
  'gemini-robotics-er-1.5-preview': '2025-09-25',
  'gemini-robotics-er-1.6-preview': '2026-04-14',
  'imagen-4.0-generate-001': '2025-08-14',
  'imagen-4.0-ultra-generate-001': '2025-08-14',
  'imagen-4.0-fast-generate-001': '2025-08-14',
}

/**
 * From ElevenLabs' own blog posts (public alpha/launch dates). The v1
 * multilingual and speech-to-speech models have no official dated posts
 * and stay unmapped.
 */
export const ELEVENLABS_RELEASE_DATES: Record<string, string> = {
  eleven_monolingual_v1: '2023-01-23',
  eleven_multilingual_v2: '2023-08-22',
  eleven_turbo_v2: '2023-11-09',
  eleven_turbo_v2_5: '2024-07-19',
  eleven_flash_v2: '2024-12-01',
  eleven_flash_v2_5: '2024-12-01',
  eleven_v3: '2025-06-05',
}

/** Curated lookup + (Gemini) id-suffix fallback. */
export function curatedReleasedAt(
  map: Record<string, string>,
  rawId: string,
): number | null {
  const date = map[rawId]
  if (date) return dateToEpoch(date)
  return null
}
