import { expect, it } from 'vitest'
import { openRouterGatewayEfforts } from './openrouter-reasoning.ts'
import { openRouterReasoning } from './reasoning-config.ts'
import docs from './fixtures/openrouter-gateway-efforts.json'

it('reads native normative gateway values only for explicit null efforts', () => {
  const text = docs.markdown
  const efforts = openRouterGatewayEfforts(text)
  expect(
    openRouterReasoning(
      { reasoning: { mandatory: true, supported_efforts: null } },
      efforts,
    )?.efforts,
  ).not.toContain('none')
  expect(efforts).toEqual([
    'max',
    'xhigh',
    'high',
    'medium',
    'low',
    'minimal',
    'none',
  ])
  expect(
    openRouterReasoning(
      { reasoning: { mandatory: false, supported_efforts: null } },
      efforts,
    )?.efforts,
  ).toEqual(efforts)
  expect(
    openRouterReasoning({ reasoning: { mandatory: false } }, efforts),
  ).toBeNull()
  expect(
    openRouterReasoning(
      { reasoning: { mandatory: false, supported_efforts: ['low'] } },
      efforts,
    )?.efforts,
  ).toEqual(['low'])
  expect(() => openRouterGatewayEfforts('```\n' + text + '\n```')).toThrow()
  expect(() =>
    openRouterGatewayEfforts(
      text.replace(
        'When `null`, all gateway effort values are accepted',
        'unknown contract',
      ),
    ),
  ).toThrow()
  expect(() =>
    openRouterGatewayEfforts(
      text.replace('the model rejects it', 'unpublished behavior'),
    ),
  ).toThrow('mandatory effort rejection')
})
