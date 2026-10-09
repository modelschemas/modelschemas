import { expect, it } from 'vitest'
import docs from './fixtures/bedrock-native-honored-effort.json'
import { parseBedrockCard } from './bedrock-cards.ts'

const source = {
  url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-4-31b.md',
  hash: 'h',
  extractedAt: 't',
}
it('reads native honored effort behavior without manufacturing enum or Converse support', () => {
  for (const markdown of Object.values(docs)) {
    const model = parseBedrockCard(markdown, source)
    expect(model?.reasoning).toEqual({ mode: 'effort', mandatory: null })
    expect(model?.schemaEndpointId).toBeNull()
  }
})
it('does not read fenced or negative honored-effort descriptions as positive contracts', () => {
  const text = docs['31b']
  expect(
    parseBedrockCard(
      text.replace(
        'Reasoning effort is honored on both',
        'Reasoning effort is not honored on both',
      ),
      source,
    )?.reasoning,
  ).toBeNull()
  const negative = text.replace(
    /\+ \*\*Reasoning mode\*\*[^\n]+/,
    (line) => '```\n' + line + '\n```',
  )
  expect(parseBedrockCard(negative, source)?.reasoning).toBeNull()
})
