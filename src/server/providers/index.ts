import { anthropicProvider } from './anthropic.ts'
import { elevenlabsProvider } from './elevenlabs.ts'
import { falProvider } from './fal.ts'
import { geminiProvider } from './gemini.ts'
import { grokProvider } from './grok.ts'
import { openaiProvider } from './openai.ts'
import { openrouterProvider } from './openrouter.ts'
import type { ProviderConfig } from './types.ts'

export const providerRegistry: Array<ProviderConfig> = [
  openaiProvider,
  anthropicProvider,
  geminiProvider,
  grokProvider,
  elevenlabsProvider,
  openrouterProvider,
  falProvider,
]

export function getProvider(id: string): ProviderConfig | undefined {
  return providerRegistry.find((p) => p.id === id)
}
