/**
 * デモモード（`npm run build:demo` / `VITE_DEMO_MODE=1`）専用のインメモリ API（入口）。
 *
 * 目的（SPEC-PILOT-V5 §3.4 / D27）: バックエンド（ブリッジ・ゲートウェイ・カンバン DB）が
 * 一切無い静的ホスティングでも、A2B パイプラインの 4 ステップを体験できること。
 *
 * 約束:
 * - **本番バンドルに混ざらない**: `api.js` / `openSocket()` が
 *   `import.meta.env.VITE_DEMO_MODE === '1'` の分岐の中でだけこのモジュールを動的 import する。
 *   Vite は `import.meta.env.VITE_DEMO_MODE` を静的に畳むので、通常ビルドではこの
 *   ファイルはチャンクとしても生成されない（`npm run verify` 後に `apps/web/dist` を grep して確認）。
 * - **外部依存ゼロ**: 画像は SVG 文字列から data URL を作る（ネットワークも外部ファイルも使わない）。
 * - **状態は 1 枚のオブジェクト**: `createDemoState()` を作り直せばツアーを最初から再生できる。
 *
 * 画面側は `demoFetch(path, opts)` を `fetch` の代わりに呼ぶだけ。パスは本物の
 * ブリッジ API と同じ形にしてあるので、画面コンポーネント側にデモ分岐は要らない。
 *
 * 実装は責務ごとに分割してある（このファイルは**互換のための入口**で、公開名をそのまま再輸出する）:
 *   fixtures.js      … 定数・設問・レビュー・SPEC のデータ
 *   store.js         … ツアー状態 1 枚と購読、SPEC 一覧の組み立て
 *   shots.js         … SVG の擬似スクリーンショット
 *   gitFixtures.js   … タスク詳細・差分・ワーカーフィード
 *   architectDemo.js … Architect ジョブの進行
 *   payloads.js      … 応答ペイロード（概要・レシート・ログ・検索・診断）
 *   route.js         … `/api/...` の分類（純関数）
 *   fetch.js         … `demoFetch`
 *   sockets.js       … WebSocket モック
 */

export {
  DEMO_BOARD,
  DEMO_REPO,
  DEMO_REPO_PATH,
  DEMO_RUNNER_LABEL,
  DEMO_SESSION,
  DEMO_SPEC_PATH,
  DEMO_SPEC_V4_PATH,
  DEMO_SPEC_V5_PATH,
  DEMO_TICK_MS,
  MIN,
  SPEC_MTIME_SLACK_MS,
  STEPS,
  demoQuestions,
  demoRunnerLabel,
  demoTaskSpecOf,
  demoTaskStampMs,
  emptyProgress,
  initialReviewItems,
  stepIndex,
} from './fixtures.js'
export {
  createArchitectState,
  createDemoState,
  currentSpecs,
  currentStep,
  demoArchivedSpecList,
  demoSpecContent,
  demoSpecList,
  demoSpects,
  demoSpecsWithArchive,
  demoState,
  resetDemoState,
  snapshot,
  subscribeDemo,
} from './store.js'
export { demoImageFor, installDemoImageShim, mockShotDataUrl, mockShotSvg, svgToDataUrl } from './shots.js'
export { demoDiffSummary, demoFilePatch, demoTaskDetail, demoWorkerFeed } from './gitFixtures.js'
export {
  DEMO_STALLED_AFTER_MS,
  advanceArchitectJob,
  demoArchitectJobs,
  demoExecutionMode,
  demoJobPhase,
  demoJobStalled,
  demoLiveArchitect,
  demoPublicJob,
  normalizeDemoExecutionPolicy,
  startDemoArchitectJob,
} from './architectDemo.js'
export {
  advanceBatches,
  demoCoherenceAlert,
  demoCoherenceReport,
  demoLogText,
  demoPipelineStatus,
  demoQrRows,
  demoSearchHits,
  finishPipeline,
  itemById,
  overviewBody,
  receiptBody,
  setDemoTick,
} from './payloads.js'
export { demoRoute } from './route.js'
export { demoFetch } from './fetch.js'
export { demoSocket } from './sockets.js'
