import { describe, expect, it } from 'vitest'

import {
  ELEVENLABS_RELEASE_DATES,
  GEMINI_RELEASE_DATES,
  curatedReleasedAt,
  dateToEpoch,
  geminiIdSuffixDate,
  isoToEpochSeconds,
} from './release-dates.ts'

describe('release date helpers', () => {
  it('converts YYYY-MM-DD to UTC-midnight epoch seconds', () => {
    expect(dateToEpoch('2025-11-20')).toBe(1_763_596_800)
    expect(dateToEpoch('2015-01-01')).toBe(1_420_070_400)
  })

  it('parses ISO timestamps and rejects garbage', () => {
    expect(isoToEpochSeconds('2025-11-20T14:27:03.344Z')).toBe(1_763_648_823)
    expect(isoToEpochSeconds('2026-06-29T00:00:00Z')).toBe(1_782_691_200)
    expect(isoToEpochSeconds('not-a-date')).toBeNull()
    expect(isoToEpochSeconds(undefined)).toBeNull()
    expect(isoToEpochSeconds(null)).toBeNull()
  })

  it('extracts the MM-YYYY month embedded in Gemini preview ids', () => {
    expect(geminiIdSuffixDate('gemini-2.5-computer-use-preview-10-2025')).toBe(
      dateToEpoch('2025-10-01'),
    )
    expect(geminiIdSuffixDate('antigravity-preview-05-2026')).toBe(
      dateToEpoch('2026-05-01'),
    )
    // Version-suffixed ids must not parse as dates.
    expect(geminiIdSuffixDate('gemini-2.0-flash-001')).toBeNull()
    expect(geminiIdSuffixDate('gemini-2.5-pro')).toBeNull()
    // Month out of range.
    expect(geminiIdSuffixDate('model-preview-13-2025')).toBeNull()
  })

  it('resolves curated dates and misses to null', () => {
    expect(curatedReleasedAt({ 'my-model': '2024-07-01' }, 'my-model')).toBe(
      dateToEpoch('2024-07-01'),
    )
    expect(curatedReleasedAt({}, 'unknown-model')).toBeNull()
  })

  it('keeps curated maps parseable', () => {
    for (const [rawId, date] of [
      ...Object.entries(GEMINI_RELEASE_DATES),
      ...Object.entries(ELEVENLABS_RELEASE_DATES),
    ]) {
      expect(date, rawId).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isNaN(dateToEpoch(date)), rawId).toBe(false)
    }
  })
})
