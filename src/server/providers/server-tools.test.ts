import { describe, expect, it } from 'vitest'

import { parseGrokFileTool } from './grok.ts'
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

  it('reads the files page tool id and its agentic models, or throws', () => {
    // docs.x.ai/developers/files.md as served on 2026-10-22, cut down.
    const files = [
      'Grok can search through documents you attach; the system automatically activates the `attachment_search` tool and transforms your request.',
      'When you attach files, the xAI API automatically activates the `attachment_search` [server-side tool](/developers/tools/overview).',
      '',
      '## Limitations',
      '',
      '* **Agentic models only**: Requires models that support agentic tool calling (e.g., `grok-4.20`, `grok-4.5`, `grok-4.6`, `grok-4.7`)',
    ].join('\n')
    expect(parseGrokFileTool(files)).toEqual({
      tool: 'attachment_search',
      models: ['grok-4.20', 'grok-4.5', 'grok-4.6', 'grok-4.7'],
    })
    expect(() =>
      parseGrokFileTool(files.replace(/^\* \*\*Agentic.*$/m, '')),
    ).toThrow('no Agentic models only list')
    expect(() =>
      parseGrokFileTool(
        files.replace('`attachment_search` [server', '`doc_search` [server'),
      ),
    ).toThrow('no single attachment tool id')
  })

  it('leaves OpenRouter null', () => {
    expect(
      openrouterServerTools({
        supported_parameters: ['tools', 'tool_choice', 'web_search'],
      }),
    ).toBeNull()
  })
})
