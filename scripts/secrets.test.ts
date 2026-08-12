import { describe, expect, it } from 'vitest'

import {
  PUSH_REMOVE_LIST,
  formatEnvFile,
  isRemoved,
  parseConfigFlag,
  parseEnvFile,
  withoutRemoved,
} from './secrets.ts'

describe('remove list', () => {
  it('drops Doppler context vars and nothing else on pull', () => {
    expect(isRemoved('DOPPLER_CONFIG')).toBe(true)
    expect(isRemoved('DOPPLER_ENVIRONMENT')).toBe(true)
    expect(isRemoved('DOPPLER_PROJECT')).toBe(true)
    expect(isRemoved('ADMIN_KEY')).toBe(false)
    expect(isRemoved('MISTRAL_API_KEY')).toBe(false)
    expect(isRemoved('BETTER_AUTH_URL')).toBe(false)
    expect(isRemoved('SEED_SPEECH_API_KEY')).toBe(false)
  })

  it('also skips BETTER_AUTH_URL on push (already a wrangler var)', () => {
    expect(isRemoved('BETTER_AUTH_URL', PUSH_REMOVE_LIST)).toBe(true)
    expect(isRemoved('ADMIN_KEY', PUSH_REMOVE_LIST)).toBe(false)
    expect(
      withoutRemoved(
        { ADMIN_KEY: 'x', BETTER_AUTH_URL: 'http://localhost:3100' },
        PUSH_REMOVE_LIST,
      ),
    ).toEqual({ ADMIN_KEY: 'x' })
  })

  it('strips removed names and empty values, keeps the rest', () => {
    expect(
      withoutRemoved({
        ADMIN_KEY: 'x',
        DOPPLER_CONFIG: 'dev',
        DOPPLER_PROJECT: 'modelschemas',
        MISTRAL_API_KEY: 'm',
        EMPTY: '',
      }),
    ).toEqual({
      ADMIN_KEY: 'x',
      MISTRAL_API_KEY: 'm',
    })
  })
})

describe('parseConfigFlag', () => {
  it('falls back when --config is absent or valueless', () => {
    expect(parseConfigFlag([], 'dev')).toBe('dev')
    expect(parseConfigFlag(['--write'], 'dev')).toBe('dev')
    expect(parseConfigFlag(['--config'], 'dev')).toBe('dev')
  })

  it('reads the value after --config', () => {
    expect(parseConfigFlag(['--config', 'stg', '--write'], 'dev')).toBe('stg')
  })
})

describe('env file codec', () => {
  it('round-trips plain, quoted, and escaped values', () => {
    const secrets = {
      PLAIN: 'sk-abc',
      SPACES: 'hello world',
      QUOTES: `say "hi"`,
      DOLLAR: 'pre$fix',
    }
    const text = formatEnvFile(secrets, ['header'])
    expect(text.startsWith('# header\n\n')).toBe(true)
    expect(parseEnvFile(text)).toEqual(secrets)
  })

  it('skips comments and unknown lines', () => {
    expect(parseEnvFile('# comment\nFOO=1\n\nnot-a-key\nBAR=2\n')).toEqual({
      FOO: '1',
      BAR: '2',
    })
  })
})
