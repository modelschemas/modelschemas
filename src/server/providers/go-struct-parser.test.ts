import { describe, expect, it } from 'vitest'

import { parseGoSchemas } from './go-struct-parser.ts'

const file = (text: string) => [{ name: 'test.go', text }]

describe('go struct parser', () => {
  it('maps primitives, pointers and omitempty-derived requiredness', () => {
    const { schemas, warnings } = parseGoSchemas(
      file(`
type Req struct {
	Model       string   \`json:"model"\`
	Temperature *float32 \`json:"temperature,omitempty"\`
	MaxTokens   *int     \`json:"max_tokens,omitempty"\`
	Stream      bool     \`json:"stream"\`
}
`),
      ['Req'],
    )
    expect(warnings).toEqual([])
    expect(schemas.Req).toEqual({
      type: 'object',
      properties: {
        model: { type: 'string' },
        // A pointer is not itself optional — omitempty is the signal.
        temperature: { type: 'number' },
        max_tokens: { type: 'integer' },
        stream: { type: 'boolean' },
      },
      required: ['model', 'stream'],
    })
  })

  it('turns named string types plus their const block into enums', () => {
    const { schemas } = parseGoSchemas(
      file(`
type ThinkingType string

const (
	ThinkingTypeEnabled  ThinkingType = "enabled"
	ThinkingTypeDisabled ThinkingType = "disabled"
	ThinkingTypeAuto     ThinkingType = "auto"
)

type Thinking struct {
	Type ThinkingType \`json:"type"\`
}
`),
      ['Thinking'],
    )
    expect(schemas.Thinking).toMatchObject({
      properties: { type: { $ref: '#/components/schemas/ThinkingType' } },
    })
    expect(schemas.ThinkingType).toEqual({
      type: 'string',
      enum: ['enabled', 'disabled', 'auto'],
    })
  })

  it('handles slices, maps, interface{} and []byte', () => {
    const { schemas } = parseGoSchemas(
      file(`
type Req struct {
	Messages  []*Message     \`json:"messages"\`
	Stop      []string       \`json:"stop,omitempty"\`
	LogitBias map[string]int \`json:"logit_bias,omitempty"\`
	Anything  interface{}    \`json:"anything,omitempty"\`
	Raw       []byte         \`json:"raw,omitempty"\`
}

type Message struct {
	Role string \`json:"role"\`
}
`),
      ['Req'],
    )
    expect(schemas.Req).toMatchObject({
      properties: {
        messages: {
          type: 'array',
          items: { $ref: '#/components/schemas/Message' },
        },
        stop: { type: 'array', items: { type: 'string' } },
        logit_bias: {
          type: 'object',
          additionalProperties: { type: 'integer' },
        },
        // interface{} carries no constraint rather than a wrong one.
        anything: {},
        // []byte marshals to a base64 string, not an array.
        raw: { type: 'string' },
      },
    })
    expect(schemas.Message).toBeDefined()
  })

  it('skips json:"-" and untagged embedded fields', () => {
    const { schemas } = parseGoSchemas(
      file(`
type ExtraBody map[string]interface{}

type Req struct {
	Model string \`json:"model"\`
	ExtraBody \`json:"-"\`
	HttpHeader
}
`),
      ['Req'],
    )
    expect(
      Object.keys((schemas.Req as { properties: object }).properties),
    ).toEqual(['model'])
  })

  it('resolves aliases and named composite types', () => {
    const { schemas } = parseGoSchemas(
      file(`
type FunctionDefine = FunctionDefinition

type FunctionDefinition struct {
	Name string \`json:"name"\`
}

type Extra map[string]string

type Req struct {
	Fn    FunctionDefine \`json:"fn"\`
	Extra Extra          \`json:"extra,omitempty"\`
}
`),
      ['Req'],
    )
    expect(schemas.Req).toMatchObject({
      properties: {
        fn: { $ref: '#/components/schemas/FunctionDefinition' },
        extra: { type: 'object', additionalProperties: { type: 'string' } },
      },
    })
  })

  it('lifts doc comments into descriptions', () => {
    const { schemas } = parseGoSchemas(
      file(`
// Req opens a generation task.
type Req struct {
	// Whether to burn a watermark into the output.
	Watermark *bool \`json:"watermark,omitempty"\`
}
`),
      ['Req'],
    )
    expect(schemas.Req).toMatchObject({
      description: 'Req opens a generation task.',
      properties: {
        watermark: {
          type: 'boolean',
          description: 'Whether to burn a watermark into the output.',
        },
      },
    })
  })

  it('emits only the closure reachable from the roots', () => {
    const { schemas } = parseGoSchemas(
      file(`
type Wanted struct {
	Child Child \`json:"child"\`
}

type Child struct {
	Name string \`json:"name"\`
}

type Unrelated struct {
	Nope string \`json:"nope"\`
}
`),
      ['Wanted'],
    )
    expect(Object.keys(schemas).sort()).toEqual(['Child', 'Wanted'])
  })

  it('warns rather than throwing on unmapped types and missing roots', () => {
    const { schemas, warnings } = parseGoSchemas(
      file(`
type Req struct {
	When somepkg.Timestamp \`json:"when"\`
}
`),
      ['Req', 'DoesNotExist'],
    )
    expect(schemas.Req).toMatchObject({ properties: { when: {} } })
    expect(warnings).toContain(
      "go-parser: Req.when: unmapped type 'somepkg.Timestamp'",
    )
    expect(warnings).toContain("go-parser: root type 'DoesNotExist' not found")
  })
})
