import type { providers } from './schema.ts'

export type ProviderSeed = typeof providers.$inferInsert

/**
 * Spec-source config for the 7 monitored providers, ported from TanStack AI
 * PR #622 (`packages/ai-schemas/scripts/providers/*`):
 *
 * - OpenAI's and Anthropic's spec URLs are not fetched directly: the seeded
 *   URL is the Stainless `.stats.yml` for each TypeScript SDK, whose
 *   `openapi_spec_url` field points at the current spec revision (resolved
 *   at sync time). The Stainless artifact leads the public spec exports.
 * - Gemini publishes a Google Discovery document, converted to OpenAPI during
 *   sync.
 * - FAL lists per-model OpenAPI specs from its models API via the
 *   `expand=openapi-3.0` query param; output schemas use the PR's
 *   `sibling-get` strategy rather than `post-200`.
 * - OpenRouter also exposes `/api/v1/videos/models` for synthesized
 *   per-model video endpoints.
 */
export const providerSeeds: Array<ProviderSeed> = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    // Stainless .stats.yml; resolve `openapi_spec_url` at sync time.
    specSourceUrl:
      'https://raw.githubusercontent.com/openai/openai-node/master/.stats.yml',
    modelsEndpoint: 'https://api.openai.com/v1/models',
    authEnvVar: 'OPENAI_API_KEY',
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    // Stainless .stats.yml; resolve `openapi_spec_url` at sync time.
    specSourceUrl:
      'https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/.stats.yml',
    modelsEndpoint: 'https://api.anthropic.com/v1/models',
    authEnvVar: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    // Discovery document; converted to OpenAPI at sync time.
    specSourceUrl:
      'https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta',
    modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    authEnvVar: 'GEMINI_API_KEY',
  },
  {
    id: 'grok',
    displayName: 'xAI Grok',
    specSourceUrl: 'https://docs.x.ai/openapi.json',
    modelsEndpoint: 'https://api.x.ai/v1/models',
    authEnvVar: 'XAI_API_KEY',
  },
  {
    id: 'elevenlabs',
    displayName: 'ElevenLabs',
    specSourceUrl: 'https://api.elevenlabs.io/openapi.json',
    modelsEndpoint: 'https://api.elevenlabs.io/v1/models',
    authEnvVar: 'ELEVENLABS_API_KEY',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    specSourceUrl: 'https://openrouter.ai/openapi.json',
    // No key required — OpenRouter is the keyless smoke-test provider.
    modelsEndpoint: 'https://openrouter.ai/api/v1/models',
    authEnvVar: null,
  },
  {
    id: 'fal',
    displayName: 'FAL',
    // Per-model specs via expand=openapi-3.0; paginated.
    specSourceUrl: 'https://api.fal.ai/v1/models?expand=openapi-3.0',
    modelsEndpoint: 'https://api.fal.ai/v1/models',
    authEnvVar: 'FAL_KEY',
  },
]
