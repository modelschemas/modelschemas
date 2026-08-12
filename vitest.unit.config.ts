import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'unit',
    include: [
      'src/**/*.test.{ts,tsx}',
      'packages/*/src/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    exclude: ['src/**/*.worker.test.ts'],
  },
})
