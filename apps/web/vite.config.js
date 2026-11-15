import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

/**
 * デモビルド（`VITE_DEMO_MODE=1`）は **チャンクを分けない**（`inlineDynamicImports`）。
 *
 * `npm run build:demo` は 2 種類の配布物を作る（SPEC-PILOT-V6 D32）:
 * 1. 通常の静的サイト `apps/web/dist-demo/`（URL 埋め込み用・`base: './'`）
 * 2. 単一自己完結 HTML `apps/web/dist-demo/google-sites-embed.html`（コード埋め込み用・
 *    `scripts/build-demo-embed.mjs` が CSS/JS をインライン化する）
 *
 * 2 は「外部ファイルを 1 つも参照しない 1 枚の HTML」なので、遅延 import のチャンクが残ると
 * 成立しない（相対 URL が 404 する）。デモだけ 1 チャンクに畳む。本番ビルドは従来通り。
 */
const DEMO = process.env.VITE_DEMO_MODE === '1'

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  base: '/',
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    ...(DEMO ? { rollupOptions: { output: { inlineDynamicImports: true } } } : {}),
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
