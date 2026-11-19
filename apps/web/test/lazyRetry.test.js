/**
 * ターミナルタブの動的 import 失敗からの自動復旧（SPEC-UI-POLISH-V22 / Batch U3）。
 *
 * 見るのは「壊れたら必ず落ちる」4 点:
 *
 * - `isChunkLoadError` が、ブラウザ／バンドラごとの文言と webpack の `name` を拾い、
 *   実装バグの例外は拾わないこと
 * - `retryImport` が瞬断（チャンク読み込み失敗の 1 回目）を刺し直して成功すること
 * - チャンク喪失（刺し直しても駄目）では `reloadForChunkError` が**1 回だけ**読み直すこと
 * - 30 秒のクールダウン中は読み直さないこと（無限リロード防止）
 *
 * そのうえで `App.jsx` の組み込み（`vite:preloadError` 監視・`ErrorBoundary` の
 * チャンク時 reload / 一般エラー時 `retryKey`）と、エラー画面が出すログのパスを
 * ソース／JSON から機械で確かめる。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  CHUNK_RELOAD_COOLDOWN_MS,
  CHUNK_RELOAD_KEY,
  createChunkReloader,
  isChunkLoadError,
  retryImport,
} from '../src/lib/lazyRetry.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const appSrc = fs
  .readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
const ja = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n/ja.json'), 'utf8'))
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n/en.json'), 'utf8'))

/** 読み書きだけをメモリで持つ偽ストレージ（時計も呼び出し側で決める）。 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    calls: 0,
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      this.calls += 1
      map.set(key, String(value))
    },
    removeItem(key) {
      map.delete(key)
    },
    raw: map,
  }
}

/** 決まった値を返す偽時計。 */
function clock(times) {
  let i = 0
  return () => times[Math.min(i++, times.length - 1)]
}

/* ------------------------------------------------------------------ *
 * isChunkLoadError
 * ------------------------------------------------------------------ */

test('isChunkLoadError: ブラウザ／バンドラごとの文言を拾う', () => {
  const yes = [
    // Chrome / Edge / Vite（今回の TermPane-<hash>.js の失敗はこの形）
    'Failed to fetch dynamically imported module: https://h/api/assets/TermPane-a1b2c3.js',
    // Firefox
    'error loading dynamically imported module: https://h/api/assets/TermPane-a1b2c3.js',
    // Safari
    'Importing a module script failed.',
    // webpack 系
    'Loading chunk 12 failed.',
    'Loading CSS chunk 3 failed.',
  ]
  for (const message of yes) {
    assert.equal(isChunkLoadError(new Error(message)), true, message)
    // 例外が文字列で来ることもある（unhandledrejection をそのまま渡す経路）
    assert.equal(isChunkLoadError(message), true, message)
  }
  // webpack の Error は name で判定する（文言は環境で揺れる）
  const named = new Error('boom')
  named.name = 'ChunkLoadError'
  assert.equal(isChunkLoadError(named), true)
})

test('isChunkLoadError: 実装バグや空値は拾わない', () => {
  for (const bad of [
    new TypeError("Cannot read properties of null (reading 'notify')"),
    new Error('Unexpected token'),
    new Error('NetworkError when attempting to fetch resource.'),
    '',
    null,
    undefined,
  ]) {
    assert.equal(isChunkLoadError(bad), false, String(bad))
  }
})

/* ------------------------------------------------------------------ *
 * retryImport
 * ------------------------------------------------------------------ */

test('retryImport: 瞬断は刺し直して成功する', async () => {
  const sleeps = []
  let calls = 0
  const module = { TermPane: () => null }
  const result = await retryImport(
    async () => {
      calls += 1
      if (calls === 1) throw new Error('Failed to fetch dynamically imported module: /assets/TermPane-a1b2.js')
      return module
    },
    { sleep: async (ms) => sleeps.push(ms) },
  )
  assert.equal(result, module)
  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [250])
})

test('retryImport: 直らないチャンク喪失はリトライ上限で投げる', async () => {
  let calls = 0
  const error = new Error('Failed to fetch dynamically imported module')
  await assert.rejects(
    retryImport(
      async () => {
        calls += 1
        throw error
      },
      { retries: 2, sleep: async () => {} },
    ),
    (err) => err === error,
  )
  assert.equal(calls, 3) // 初回 + 2 回のリトライ
})

test('retryImport: チャンク以外の例外はリトライしない', async () => {
  let calls = 0
  const error = new TypeError('notify is not a function')
  await assert.rejects(
    retryImport(
      async () => {
        calls += 1
        throw error
      },
      { sleep: async () => assert.fail('リトライしてはいけない') },
    ),
    (err) => err === error,
  )
  assert.equal(calls, 1)
})

/* ------------------------------------------------------------------ *
 * 単発リロード + 30 秒クールダウン
 * ------------------------------------------------------------------ */

test('reloadForChunkError: チャンク喪失は 1 回だけ読み直す', () => {
  const storage = fakeStorage()
  const now = () => 1_000
  let reloads = 0
  const reload = createChunkReloader({ storage, now, reload: () => (reloads += 1) })

  assert.equal(reload(), true)
  assert.equal(reloads, 1)
  // 読み直した時刻を残しておく（次の判定で使う）
  assert.equal(storage.getItem(CHUNK_RELOAD_KEY), '1000')
})

test('reloadForChunkError: 30 秒クールダウン中は読み直さない（無限ループ防止）', () => {
  const storage = fakeStorage()
  let reloads = 0
  const reload = createChunkReloader({
    storage,
    now: clock([1_000, 1_001, 2_000, 30_999]),
    reload: () => (reloads += 1),
  })

  assert.equal(reload(), true) // t=1000 → 読み直す
  assert.equal(reload(), false) // t=1001（1 秒後）→ 抑止
  assert.equal(reload(), false) // t=2000（2 秒後）→ 抑止
  assert.equal(reload(), false) // t=30999（29.999 秒後）→ まだ抑止
  assert.equal(reloads, 1)
  assert.equal(storage.getItem(CHUNK_RELOAD_KEY), '1000', 'クールダウン中は記録を上書きしない')
})

test('reloadForChunkError: 30 秒を過ぎたらもう一度だけ読み直せる', () => {
  const storage = fakeStorage()
  let reloads = 0
  const reload = createChunkReloader({
    storage,
    now: clock([1_000, 1_000 + CHUNK_RELOAD_COOLDOWN_MS, 1_000 + CHUNK_RELOAD_COOLDOWN_MS + 5_000]),
    reload: () => (reloads += 1),
  })
  assert.equal(reload(), true)
  assert.equal(reload(), true) // ちょうど 30 秒後は許可
  assert.equal(reload(), false) // その 5 秒後は再び抑止
  assert.equal(reloads, 2)
})

test('reloadForChunkError: sessionStorage が無い／壊れていても落ちず、メモリで抑止する', () => {
  // node には sessionStorage が無い → メモリ退避で同じクールダウンが効く
  let reloads = 0
  const reload = createChunkReloader({ reload: () => (reloads += 1) })
  assert.equal(reload(), true)
  assert.equal(reload(), false)
  assert.equal(reloads, 1)

  // 読み書きが投げるストレージ（プライベートモード等）でも例外を外へ出さない
  const hostile = {
    getItem() {
      throw new Error('SecurityError')
    },
    setItem() {
      throw new Error('SecurityError')
    },
  }
  let hostileReloads = 0
  const reloadHostile = createChunkReloader({ storage: hostile, reload: () => (hostileReloads += 1) })
  assert.equal(reloadHostile(), true)
  assert.equal(hostileReloads, 1)
})

/* ------------------------------------------------------------------ *
 * App.jsx への組み込み（ソースで機械確認）
 * ------------------------------------------------------------------ */

test('App.jsx: TermPane の動的 import は retryImport を通す', () => {
  assert.match(appSrc, /import \{[^}]*retryImport[^}]*\} from '\.\/lib\/lazyRetry\.js'/)
  assert.match(appSrc, /const TermPane = lazy\(\(\) =>\s*retryImport\(\(\) => import\('\.\/features\/TermPane\.jsx'\)\)/)
})

test('App.jsx: vite:preloadError を監視して単発リロードに寄せる', () => {
  assert.match(appSrc, /addEventListener\('vite:preloadError'/)
  assert.match(appSrc, /removeEventListener\('vite:preloadError'/)
  assert.match(appSrc, /reloadForChunkError\(\)[^\n]*preventDefault/)
})

test('App.jsx: ErrorBoundary の再試行はチャンクなら reload・一般エラーは retryKey 更新', () => {
  const retry = appSrc.slice(appSrc.indexOf('  retry() {'), appSrc.indexOf('  render() {'))
  assert.match(retry, /isChunkLoadError\(this\.state\.error\)/)
  assert.match(retry, /reloadForChunkError\(\)/)
  assert.match(retry, /retryKey: prev\.retryKey \+ 1/)
  // 子は retryKey 付き key で作り直す（reject 済み lazy を抱え込まない）
  assert.match(appSrc, /key=\{`\$\{this\.props\.tab\}:\$\{this\.state\.retryKey\}`\}/)
})

/* ------------------------------------------------------------------ *
 * ログの案内パス（ブリッジが実際に書く場所と一致）
 * ------------------------------------------------------------------ */

test('app.tabErrorLog は現行のログパスを案内する', () => {
  const expected = '~/.hermes/plugin-data/hermes-pilot/client-errors.log'
  assert.match(ja['app.tabErrorLog'], new RegExp(expected.replace(/[.]/g, '\\.')))
  assert.match(en['app.tabErrorLog'], new RegExp(expected.replace(/[.]/g, '\\.')))
  // 旧パス（移行前の置き場所）を案内し続けない
  assert.doesNotMatch(ja['app.tabErrorLog'], /mobile-pwa/)
  assert.doesNotMatch(en['app.tabErrorLog'], /mobile-pwa/)
})

test('ログの案内パスはブリッジの書き込み先と一致する', () => {
  const config = fs.readFileSync(path.join(ROOT, '../bridge/src/config.js'), 'utf8')
  const server = fs.readFileSync(path.join(ROOT, '../bridge/src/server.js'), 'utf8')
  // 既定の dataDir = <HERMES_HOME>/plugin-data/hermes-pilot
  assert.match(config, /path\.join\(hermesHome, 'plugin-data', 'hermes-pilot'\)/)
  // クライアントエラーの記録先 = <dataDir>/client-errors.log
  assert.match(server, /path\.join\(cfg\.dataDir, 'client-errors\.log'\)/)
})
