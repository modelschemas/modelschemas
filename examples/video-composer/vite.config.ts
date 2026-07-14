import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Served as static assets from the main worker under this path.
  base: '/examples/video-composer/',
  server: {
    port: 3203,
    // The browser calls the API same-origin; in dev, forward to the target.
    proxy: {
      '/v1': {
        target: process.env.MODELSCHEMAS_URL ?? 'https://modelschemas.com',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    tailwindcss(),
    tanstackStart({ spa: { enabled: true } }),
    viteReact(),
  ],
})
