import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  base: '/',
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 4098,
    proxy: {
      '/api': 'http://127.0.0.1:4097',
      '/auth': 'http://127.0.0.1:4097',
      '/ws': { target: 'ws://127.0.0.1:4097', ws: true },
    },
  },
})
