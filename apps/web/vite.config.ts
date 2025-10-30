import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { nitroV2Plugin } from '@tanstack/nitro-v2-vite-plugin'

const config = defineConfig({
  plugins: [
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart(),
    nitroV2Plugin({ 
      preset: 'node-server' 
    }),
    viteReact(),
  ],
  server: {
    proxy: {
      // Proxy API calls to the local API dev server
      '/v1': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        ws: true,
      },
      '/ws': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ['@resvg/resvg-wasm'],
  },
})

export default config
