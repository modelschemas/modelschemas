import { describe, expect, it } from 'vitest'

import { parseGrokAgenticModels, parseGrokServerTools } from './grok.ts'
import { openrouterServerTools } from './openrouter.ts'
import {
  parseByteplusServerTools,
  parseGroqBuiltinTools,
  parseMistralPageTools,
} from './server-tools.ts'

const GROQ_TOOLS = `# Groq Built-In Tools

### GPT-OSS Models

**Models:**

* \`openai/gpt-oss-120b\`
* \`openai/gpt-oss-20b\`

**Available Tools:**

| Tool | Identifier |
| --- | --- |
| Browser Search | browser\\_search |
| Code Execution | code\\_interpreter |

### Something else

Llama stays on the models page and is not listed here.
`

const MISTRAL_TOOLS = `<html><body>
<h2>Supported tools</h2>
<p>This model accepts <code>web_search</code> and <code>code_interpreter</code>.</p>
<p>Client <code>function</code> tools are not hosted.</p>
</body></html>`

const BYTEPLUS_TOOLS = `# Image generation API

## Seedream 4.5

Model ID: \`seedream-4-5-251128\`

tools: [{"type": "web_search"}]

## Seedream 5.0 pro

Model ID: \`seedream-5-0-pro-260115\`

Sequential image generation, web search, and streaming output are not currently supported.
`

describe('server tools from docs (issue #123)', () => {
  it('reads Groq tool type ids only for models the built-in tools page names', () => {
    const tools = parseGroqBuiltinTools(GROQ_TOOLS)
    expect(tools.get('openai/gpt-oss-120b')).toEqual([
      'browser_search',
      'code_interpreter',
    ])
    expect(tools.get('openai/gpt-oss-20b')).toEqual([
      'browser_search',
      'code_interpreter',
    ])
    expect(tools.has('llama-3.3-70b-versatile')).toBe(false)
  })

  it('reads Mistral tool type ids from a model page and ignores a page that names none', () => {
    expect(parseMistralPageTools(MISTRAL_TOOLS)).toEqual([
      'web_search',
      'code_interpreter',
    ])
    expect(
      parseMistralPageTools(
        '<html><p>No tool section.</p><script>"web_search"</script></html>',
      ),
    ).toEqual([])
  })

  it('reads a BytePlus tool type only next to the model the section names', () => {
    const tools = parseByteplusServerTools(BYTEPLUS_TOOLS)
    expect(tools.get('seedream-4-5-251128')).toEqual(['web_search'])
    expect(tools.has('seedream-5-0-pro-260115')).toBe(false)
  })

  it('reads xAI tool ids from the pricing table, first name per row', () => {
    // docs.x.ai/developers/pricing.md as served on 2026-10-22, cut down.
    const pricing = [
      '### Tool Invocation Costs',
      '',
      '| Tool | Tool Name | Description | Cost / 1k Calls |',
      '| --- | --- | --- | --- |',
      '| Web Search | `web_search` | Search the internet and browse web pages | $5 |',
      '| Code Execution | `code_execution`, `code_interpreter`† | Run Python code in a sandboxed environment | $5 |',
      '| Collections Search | `collections_search`, `file_search`† | Query your uploaded document collections (RAG) | $2.50 |',
      '| Image Understanding | `view_image` | Analyze images found during Web Search and X Search\\* | Token-based |',
      '| Remote MCP Tools | Set by MCP server | Connect and use custom MCP tool servers | Token-based |',
      '† All tool names work in the Responses API.',
      '',
      '## Other',
      '| Tool | Tool Name | Description |',
      '| X | `not_a_tool` | elsewhere |',
    ].join('\n')
    expect(parseGrokServerTools(pricing)).toEqual([
      'web_search',
      'code_execution',
      'collections_search',
    ])
    expect(() => parseGrokServerTools('# Pricing')).toThrow(
      'no Tool Invocation Costs table',
    )
  })

  it('reads the files page list of agentic models, or throws', () => {
    const files =
      '* **Agentic models only**: Requires models that support agentic tool calling (e.g., `grok-4.20`, `grok-4.5`, `grok-4.6`, `grok-4.7`)'
    expect(parseGrokAgenticModels(`## Limitations\n\n${files}\n`)).toEqual([
      'grok-4.20',
      'grok-4.5',
      'grok-4.6',
      'grok-4.7',
    ])
    expect(() => parseGrokAgenticModels('## Limitations')).toThrow(
      'no Agentic models only list',
    )
  })

  it('leaves OpenRouter null', () => {
    expect(
      openrouterServerTools({
        supported_parameters: ['tools', 'tool_choice', 'web_search'],
      }),
    ).toBeNull()
  })
})
