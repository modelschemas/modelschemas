import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    // The Cloudflare plugin rejects vitest's resolve.external defaults, so it
    // must be skipped under vitest (Workers-runtime tests need
    // @cloudflare/vitest-pool-workers instead — see PLAN.md task 0.3).
    ...(process.env.VITEST
      ? []
      : [cloudflare({ viteEnvironment: { name: 'ssr' } })]),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
