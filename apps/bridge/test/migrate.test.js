import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  migrate,
  findKanbanDbs,
  formatReport,
  resolveHermesHome,
  cleanupLegacyCrons,
  isLegacyCronEntry,
  parseCronList,
  stripAnsi,
} from '../../../scripts/migrate-to-hermes-pilot.mjs'
import { migrationDecision } from '../../../bin/hermes-pilot.mjs'

/** 旧環境（akapen / plugin-data/akapen / mobile-pwa / kanban）を一時ディレクトリに作る。 */
function tempLegacy() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-pilot-'))
  const hermesHome = path.join(home, '.hermes')
  const srcRoot = path.join(home, 'Projects', 'akapen')
  for (const d of ['sheets', 'shots', 'library', 'thumbs']) fs.mkdirSync(path.join(srcRoot, d), { recursive: true })

  fs.writeFileSync(path.join(srcRoot, 'sheets', 'sheet-01-1.html'), '<html><body>s</body></html>')
  fs.writeFileSync(path.join(srcRoot, 'sheets', 'sheet-01-1.json'), '{"label":"sheet-01"}')
  fs.writeFileSync(path.join(srcRoot, 'shots', 'sheet-01-1.png'), 'PNG-A')
  fs.writeFileSync(path.join(srcRoot, 'shots', 'sheet-01-1.before.png'), 'PNG-B')
  fs.mkdirSync(path.join(srcRoot, 'library', 'chat'), { recursive: true })
  fs.writeFileSync(path.join(srcRoot, 'library', 'chat', 'shot.png'), 'PNG-C')
  // 撮影日時順ソートに使う mtime を固定する（2026-11-01T00:00:00Z）
  const stamp = Date.parse('2026-11-01T00:00:00Z') / 1000
  for (const f of ['sheets/sheet-01-1.html', 'shots/sheet-01-1.png', 'library/chat/shot.png']) {
    fs.utimesSync(path.join(srcRoot, f), stamp, stamp)
  }

  const oldPlugin = path.join(hermesHome, 'plugin-data', 'akapen')
  fs.mkdirSync(oldPlugin, { recursive: true })
  fs.writeFileSync(path.join(oldPlugin, 'feed.jsonl'), '{"at":"2026-11-12T22:00:00+08:00","text":"✅ 完了"}\n')
  fs.writeFileSync(path.join(oldPlugin, 'chat-reports.jsonl'), '{"at":"2026-11-12T22:00:00+08:00","session_id":"chat-a","text":"ok"}\n')
  fs.writeFileSync(path.join(oldPlugin, 'task-chats.json'), '{"t_1":"chat-a"}')

  const oldPwa = path.join(hermesHome, 'mobile-pwa')
  fs.mkdirSync(oldPwa, { recursive: true })
  fs.writeFileSync(path.join(oldPwa, 'token'), 'secret-token')
  fs.writeFileSync(path.join(oldPwa, 'snippets.json'), '{"custom":[]}')
  fs.writeFileSync(path.join(oldPwa, 'audit.jsonl'), '{"kind":"x"}\n')

  const boardDir = path.join(hermesHome, 'kanban', 'boards', 'mobile')
  fs.mkdirSync(boardDir, { recursive: true })
  fs.writeFileSync(
    path.join(boardDir, 'board.json'),
    JSON.stringify({ slug: 'mobile', name: 'Mobile', default_workdir: srcRoot }),
  )
  const db = new DatabaseSync(path.join(boardDir, 'kanban.db'))
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, body TEXT, status TEXT)')
  const ins = db.prepare('INSERT INTO tasks (id,title,body,status) VALUES (?,?,?,?)')
  ins.run('t_aaa00001', '旧 1', '本文\n[akapen] label=old-01 round=1 mode=sheet sheet=sheets/old-01-1.html', 'review')
  ins.run('t_aaa00002', '旧 2', '[akapen] label=old-02 mode=annotation image=shots/old-02-1.png', 'done')
  ins.run('t_aaa00003', '新', '[review] label=new-01 round=1 mode=sheet sheet=sheets/new-01-1.html', 'review')
  ins.run('t_aaa00004', 'タグ無し', 'ふつうの本文', 'ready')
  db.close()

  return { home, hermesHome, srcRoot, boardDir }
}

/**
 * `hermes` CLI の偽ランナー（D55: cleanupLegacyCrons はファイルを触らず CLI だけを叩く）。
 * @param {string} listText `hermes cron list` の stdout
 * @param {{listExit?: number, removeExit?: number, removeError?: string|null}} [opts]
 */
function fakeCronRunner(listText, { listExit = 0, removeExit = 0, removeError = null } = {}) {
  const calls = []
  const envs = []
  const runner = (cmd, args, opts = {}) => {
    calls.push([cmd, ...args].join(' '))
    envs.push(opts.env ?? null)
    if (args[0] === 'cron' && args[1] === 'list') {
      return { status: listExit, stdout: listExit ? '' : listText, stderr: listExit ? 'list failed' : '', error: null }
    }
    if (args[0] === 'cron' && args[1] === 'remove') {
      if (removeError) return { status: null, stdout: '', stderr: '', error: removeError }
      return { status: removeExit, stdout: removeExit ? '' : 'Removed job', stderr: removeExit ? 'no such job' : '', error: null }
    }
    return { status: 1, stdout: '', stderr: 'unexpected command', error: null }
  }
  return { runner, calls, envs }
}

/** `hermes cron list` の実出力に近いテキスト（`hermes_cli/cron.py` の `cron_list` 形式）。 */
function cronListText(jobs) {
  if (!jobs.length) return "No scheduled jobs in profile 'mobile'.\nCreate one with 'hermes cron create ...' or the /cron command in chat.\n"
  const lines = ['', '┌' + '─'.repeat(73) + '┐', '│' + ' '.repeat(25) + 'Scheduled Jobs (profile: mobile)'.padEnd(48) + '│', '└' + '─'.repeat(73) + '┘', '']
  for (const j of jobs) {
    lines.push(`  ${j.id} [${j.state ?? 'active'}]`)
    lines.push(`    Name:       ${j.name}`)
    lines.push(`    Schedule:   ${j.schedule ?? '*/30 * * * *'}`)
    if (j.deliver) lines.push(`    Deliver:    ${j.deliver}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** 旧 cron が無いときのランナー（他のテストが本物の CLI を叩かないように必ず渡す）。 */
const noCronRunner = () => fakeCronRunner(cronListText([])).runner

test('migrate はシート・画像・jsonl・token を物理コピーし、旧ディレクトリを消さない', () => {
  const env = tempLegacy()
  const report = migrate({ home: env.home, hermesHome: env.hermesHome, runner: noCronRunner() })

  const review = path.join(env.hermesHome, 'plugin-data', 'hermes-pilot', 'review')
  assert.equal(report.copied.sheets, 2, 'html + json')
  assert.equal(report.copied.shots, 2)
  assert.equal(report.copied.library, 1, 'サブディレクトリも再帰でコピーする')
  assert.equal(fs.readFileSync(path.join(review, 'sheets', 'sheet-01-1.html'), 'utf8'), '<html><body>s</body></html>')
  assert.equal(fs.readFileSync(path.join(review, 'library', 'chat', 'shot.png'), 'utf8'), 'PNG-C')

  assert.equal(fs.existsSync(path.join(review, 'feed.jsonl')), true)
  assert.equal(fs.existsSync(path.join(review, 'chat-reports.jsonl')), true)
  assert.equal(fs.existsSync(path.join(review, 'task-chats.json')), true)

  const dataDir = path.join(env.hermesHome, 'plugin-data', 'hermes-pilot')
  assert.equal(fs.readFileSync(path.join(dataDir, 'token'), 'utf8'), 'secret-token')
  assert.equal(fs.existsSync(path.join(dataDir, 'snippets.json')), true)
  assert.equal(fs.existsSync(path.join(dataDir, 'audit.jsonl')), true)

  // 旧ディレクトリは残す（破壊しない）
  assert.equal(fs.existsSync(path.join(env.srcRoot, 'sheets', 'sheet-01-1.html')), true)
  assert.equal(fs.existsSync(path.join(env.hermesHome, 'plugin-data', 'akapen', 'feed.jsonl')), true)
})

test('migrate は画像の mtime を保つ（撮影日時順ソートが壊れない）', () => {
  const env = tempLegacy()
  migrate({ home: env.home, hermesHome: env.hermesHome, runner: noCronRunner() })
  const src = fs.statSync(path.join(env.srcRoot, 'library', 'chat', 'shot.png'))
  const dest = fs.statSync(
    path.join(env.hermesHome, 'plugin-data', 'hermes-pilot', 'review', 'library', 'chat', 'shot.png'),
  )
  assert.equal(Math.round(dest.mtimeMs), Math.round(src.mtimeMs))
})

// ── D55: kanban.db を read-write で開かない ─────────────────────────────

test('migrate は kanban.db を書き換えない（[akapen] はそのまま・.bak も作らない）', () => {
  const env = tempLegacy()
  const dbPath = path.join(env.boardDir, 'kanban.db')
  const before = fs.readFileSync(dbPath)
  const beforeMtime = fs.statSync(dbPath).mtimeMs

  const report = migrate({ home: env.home, hermesHome: env.hermesHome, runner: noCronRunner() })

  assert.equal(fs.readFileSync(dbPath).equals(before), true, 'DB のバイト列が変わらない')
  assert.equal(fs.statSync(dbPath).mtimeMs, beforeMtime, 'DB を開いて書き戻していない')
  assert.equal(
    fs.readdirSync(env.boardDir).filter((f) => f.includes('.bak-')).length,
    0,
    'バックアップも作らない',
  )

  const hit = report.kanban.find((k) => k.db === dbPath)
  assert.ok(hit, 'レポートには DB の存在を残す')
  assert.equal(hit.updated, 0)
  assert.equal(hit.written, false)

  // 中身は旧タグのまま（読み取りは review.js が後方互換で行う）
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const bodies = Object.fromEntries(db.prepare('SELECT id, body FROM tasks').all().map((r) => [r.id, r.body]))
  db.close()
  assert.match(bodies.t_aaa00001, /^\[akapen\] /m)
  assert.match(bodies.t_aaa00002, /^\[akapen\] /m)

  assert.match(formatReport(report), /kanban\.db: 1 found \/ rewriting \[akapen\] -> \[review\] is retired/)
})

test('migrate スクリプトは Hermes state を直接書き換えない（D55 の受入条件）', () => {
  const src = fs.readFileSync(new URL('../../../scripts/migrate-to-hermes-pilot.mjs', import.meta.url), 'utf8')
  assert.equal(/UPDATE\s+tasks/i.test(src), false, 'kanban.db を UPDATE しない')
  assert.equal(/DatabaseSync/.test(src), false, 'node:sqlite を import しない')
  assert.equal(/fs\.renameSync/.test(src), false, 'tmp → rename のファイル差し替えをしない')

  // 書き込みは board.json の default_workdir だけ
  const writes = [...src.matchAll(/fs\.writeFileSync\(([\s\S]{0,80}?)\)/g)].map((m) => m[1].replace(/\s+/g, ' '))
  assert.equal(writes.length, 1, `writeFileSync は 1 箇所だけ: ${JSON.stringify(writes)}`)
  assert.match(writes[0], /^file, /, 'board.json への書き込みだけ')
})

test('migrate は board.json の default_workdir を新パスへ移す', () => {
  const env = tempLegacy()
  const report = migrate({ home: env.home, hermesHome: env.hermesHome, runner: noCronRunner() })
  assert.equal(report.boards.length, 1)
  const meta = JSON.parse(fs.readFileSync(path.join(env.boardDir, 'board.json'), 'utf8'))
  assert.equal(meta.default_workdir, path.join(env.hermesHome, 'plugin-data', 'hermes-pilot', 'review'))
  assert.equal(meta.slug, 'mobile', '他のキーは保つ')
})

test('migrate は冪等（2 回流してもファイルもタスクも増えない）', () => {
  const env = tempLegacy()
  const runner = noCronRunner()
  migrate({ home: env.home, hermesHome: env.hermesHome, runner })
  const review = path.join(env.hermesHome, 'plugin-data', 'hermes-pilot', 'review')
  const countFiles = (dir) => {
    let n = 0
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name))
        else n += 1
      }
    }
    walk(dir)
    return n
  }
  const before = countFiles(review)
  const dbPath = path.join(env.boardDir, 'kanban.db')
  const dbBefore = fs.readFileSync(dbPath)

  const second = migrate({ home: env.home, hermesHome: env.hermesHome, runner })
  assert.equal(second.copied.sheets, 0)
  assert.equal(second.copied.shots, 0)
  assert.equal(second.copied.library, 0)
  assert.equal(second.copied.reviewFiles, 0)
  assert.equal(second.copied.session, 0)
  assert.equal(countFiles(review), before, 'ファイル数は増えない')

  // DB は毎回バイト単位で無変化
  assert.equal(fs.readFileSync(dbPath).equals(dbBefore), true)
  assert.equal(
    fs.readdirSync(env.boardDir).filter((f) => f.includes('.bak-')).length,
    0,
    'バックアップも増えない',
  )
})

test('旧環境が無くても落ちず、レポートに skipped を残す', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-empty-'))
  const hermesHome = path.join(home, '.hermes')
  fs.mkdirSync(hermesHome, { recursive: true })
  const report = migrate({ home, hermesHome, runner: noCronRunner() })
  assert.equal(report.copied.sheets, 0)
  assert.ok(report.skipped.length > 0)
  const text = formatReport(report)
  assert.match(text, /sheets : new 0/)
  assert.match(text, /Old directories were NOT removed/)
})

test('findKanbanDbs はルートと各ボードの DB を拾う（開かずに存在だけ見る）', () => {
  const env = tempLegacy()
  const other = path.join(env.hermesHome, 'kanban', 'boards', 'work')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, 'kanban.db'), '')
  const dbs = findKanbanDbs(env.hermesHome)
  assert.ok(dbs.some((p) => p.endsWith(path.join('boards', 'mobile', 'kanban.db'))))
  assert.ok(dbs.some((p) => p.endsWith(path.join('boards', 'work', 'kanban.db'))))
  // 壊れた DB（空ファイル）でも例外を投げない = 開いていない
  assert.doesNotThrow(() => findKanbanDbs(env.hermesHome))
})

test('resolveHermesHome はプロファイルディレクトリを ~/.hermes に正す（worker からの実行対策）', () => {
  const home = '/Users/alice'
  assert.equal(resolveHermesHome('/Users/alice/.hermes/profiles/mobile', home), '/Users/alice/.hermes')
  assert.equal(resolveHermesHome('/Users/alice/.hermes', home), '/Users/alice/.hermes')
  assert.equal(resolveHermesHome('~/.hermes', home), '/Users/alice/.hermes')
  // profiles/<name>/ 以外はそのまま
  assert.equal(resolveHermesHome('/Users/alice/work/hermes', home), '/Users/alice/work/hermes')
})

test('migrate は HERMES_HOME がプロファイルを指していても profiles 配下に書かない', () => {
  const env = tempLegacy()
  // 実際に起きやすい取り違え: worker の HERMES_HOME は profiles/<name> を指す
  const report = migrate({
    home: env.home,
    hermesHome: path.join(env.hermesHome, 'profiles', 'mobile'),
    runner: noCronRunner(),
  })
  assert.equal(report.hermesHome, env.hermesHome)
  assert.equal(report.pluginDataDir, path.join(env.hermesHome, 'plugin-data', 'hermes-pilot'))
  assert.equal(fs.existsSync(path.join(env.hermesHome, 'profiles', 'mobile', 'plugin-data')), false)
  // 本物（profiles の外）の kanban.db を見つける。書き換えはしない。
  assert.equal(report.kanban.length, 1)
  assert.equal(report.kanban[0].written, false)
})

// ── D44 / D55: 旧外部 cron は公式 CLI（list → remove）で片付ける ────────────

test('parseCronList は hermes cron list の出力から id と name を拾う', () => {
  const text = cronListText([
    { id: 'c1aaaa111111', name: 'mobile-akapen-watch' },
    { id: 'c2bbbb222222', name: 'kanban-reap', state: 'paused' },
  ])
  const jobs = parseCronList(text)
  assert.deepEqual(jobs.map((j) => j.id), ['c1aaaa111111', 'c2bbbb222222'])
  assert.deepEqual(jobs.map((j) => j.name), ['mobile-akapen-watch', 'kanban-reap'])
})

test('parseCronList は ANSI カラー入りの出力でも壊れない', () => {
  const colored = '\u001b[36m  7cad0b034fff \u001b[32m[active]\u001b[0m\n    Name:       \u001b[1mmobile-review-watch\u001b[0m\n'
  const jobs = parseCronList(colored)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].id, '7cad0b034fff')
  assert.equal(jobs[0].name, 'mobile-review-watch')
  assert.equal(stripAnsi(colored).includes('\u001b'), false)
})

test('parseCronList はジョブが無い出力で空配列を返す', () => {
  assert.deepEqual(parseCronList(cronListText([])), [])
  assert.deepEqual(parseCronList(''), [])
})

test('cleanupLegacyCrons は旧 watch だけを hermes cron remove で消す（ファイルは触らない）', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-cron-'))
  // 旧実装が書き換えていたファイルを置いても、一切触らないことを確かめる
  const storeFile = path.join(hermesHome, 'cron', 'jobs.json')
  fs.mkdirSync(path.dirname(storeFile), { recursive: true })
  const storeBody = '{"jobs":[{"id":"c1","name":"mobile-akapen-watch"}],"updated_at":"2026-11-15T00:00:00+08:00"}\n'
  fs.writeFileSync(storeFile, storeBody)
  const storeMtime = fs.statSync(storeFile).mtimeMs

  const { runner, calls } = fakeCronRunner(
    cronListText([
      { id: 'c1aaaaaaaaaa', name: 'mobile-akapen-watch' },
      { id: 'c2bbbbbbbbbb', name: 'mobile-review-watch' },
      { id: 'c3cccccccccc', name: 'kanban-reap' },
      { id: 'c4dddddddddd', name: 'morning-brief' },
    ]),
  )

  const res = cleanupLegacyCrons(hermesHome, { runner })
  assert.equal(res.scanned, 4)
  assert.equal(res.detected, 2)
  assert.equal(res.removed, 2)
  assert.deepEqual(res.names, ['mobile-akapen-watch', 'mobile-review-watch'])
  assert.deepEqual(res.ids, ['c1aaaaaaaaaa', 'c2bbbbbbbbbb'])
  assert.deepEqual(res.errors, [])
  assert.deepEqual(calls, [
    'hermes cron list',
    'hermes cron remove c1aaaaaaaaaa',
    'hermes cron remove c2bbbbbbbbbb',
  ])

  assert.equal(fs.readFileSync(storeFile, 'utf8'), storeBody, 'jobs.json は読まないし書かない')
  assert.equal(fs.statSync(storeFile).mtimeMs, storeMtime)
})

test('cleanupLegacyCrons は dryRun で list だけ呼び、remove を呼ばない', () => {
  const { runner, calls } = fakeCronRunner(cronListText([{ id: 'c1aaaaaaaaaa', name: 'mobile-akapen-watch' }]))
  const res = cleanupLegacyCrons(os.tmpdir(), { runner, dryRun: true })
  assert.equal(res.detected, 1)
  assert.equal(res.removed, 0)
  assert.deepEqual(res.names, ['mobile-akapen-watch'])
  assert.deepEqual(calls, ['hermes cron list'])
  assert.equal(res.dryRun, true)
})

test('cleanupLegacyCrons は旧 cron が無ければ remove を呼ばない（冪等）', () => {
  const { runner, calls } = fakeCronRunner(cronListText([{ id: 'c3cccccccccc', name: 'kanban-reap' }]))
  const first = cleanupLegacyCrons(os.tmpdir(), { runner })
  assert.equal(first.removed, 0)
  assert.equal(first.detected, 0)
  const second = cleanupLegacyCrons(os.tmpdir(), { runner })
  assert.equal(second.removed, 0)
  assert.deepEqual(calls, ['hermes cron list', 'hermes cron list'], 'list だけ・remove は呼ばない')
})

test('cleanupLegacyCrons は cron list の失敗を握りつぶさず errors に積む', () => {
  const { runner, calls } = fakeCronRunner('', { listExit: 2 })
  const res = cleanupLegacyCrons(os.tmpdir(), { runner })
  assert.equal(res.removed, 0)
  assert.equal(res.errors.length, 1)
  assert.match(res.errors[0].cmd, /cron list$/)
  assert.equal(calls.includes('hermes cron remove'), false)
})

test('cleanupLegacyCrons は remove の失敗を 1 件ずつ記録し、残りは続行する', () => {
  const { runner } = fakeCronRunner(
    cronListText([
      { id: 'c1aaaaaaaaaa', name: 'mobile-akapen-watch' },
      { id: 'c2bbbbbbbbbb', name: 'mobile-review-watch' },
    ]),
    { removeExit: 1 },
  )
  const res = cleanupLegacyCrons(os.tmpdir(), { runner })
  assert.equal(res.removed, 0)
  assert.equal(res.errors.length, 2)
  assert.match(res.errors[0].cmd, /cron remove c1aaaaaaaaaa$/)
  assert.match(res.errors[1].cmd, /cron remove c2bbbbbbbbbb$/)
})

test('cleanupLegacyCrons は node:test 配下でランナー未指定なら CLI を叩かない（安全弁）', () => {
  // NODE_TEST_CONTEXT は node --test が立てる。誤って本物の cron を消さないためのガード。
  assert.equal(process.env.NODE_TEST_CONTEXT, 'child-v8')
  const res = cleanupLegacyCrons(os.tmpdir())
  assert.equal(res.removed, 0)
  assert.equal(res.errors.length, 1)
  assert.match(res.errors[0].error, /refusing to run the hermes CLI inside node:test/)
})

test('isLegacyCronEntry は name 以外（script / prompt / label / id）でも旧 cron を検出する', () => {
  assert.equal(isLegacyCronEntry({ script: '/opt/mobile-akapen-watch.sh' }), true)
  assert.equal(isLegacyCronEntry({ prompt: 'mobile-review-watch を回す' }), true)
  assert.equal(isLegacyCronEntry({ label: 'mobile-akapen-watch' }), true)
  assert.equal(isLegacyCronEntry({ id: 'mobile-review-watch-2' }), true)
  assert.equal(isLegacyCronEntry({ name: 'kanban-reap', script: 'kanban-reap.sh' }), false)
  assert.equal(isLegacyCronEntry({}), false)
  assert.equal(isLegacyCronEntry(null), false)
})

test('migrate は旧 cron を CLI 経由で片付け、レポートに削除件数を出す', () => {
  const env = tempLegacy()
  const { runner, calls, envs } = fakeCronRunner(
    cronListText([
      { id: 'c1aaaaaaaaaa', name: 'mobile-akapen-watch' },
      { id: 'c2bbbbbbbbbb', name: 'kanban-reap' },
    ]),
  )
  const report = migrate({ home: env.home, hermesHome: env.hermesHome, runner })

  assert.equal(report.crons.detected, 1)
  assert.equal(report.crons.removed, 1)
  assert.deepEqual(report.crons.names, ['mobile-akapen-watch'])
  assert.deepEqual(calls, ['hermes cron list', 'hermes cron remove c1aaaaaaaaaa'])
  // HERMES_HOME を移行対象の home に固定して、別プロファイルの cron を取り違えない
  assert.equal(envs[0].HERMES_HOME, env.hermesHome)
  assert.match(formatReport(report), /legacy cron cleanup: removed 1 \(hermes cron: mobile-akapen-watch\)/)
})

test('migrate の dryRun は旧 cron を検出するだけで remove を呼ばない', () => {
  const env = tempLegacy()
  const { runner, calls } = fakeCronRunner(cronListText([{ id: 'c1aaaaaaaaaa', name: 'mobile-review-watch' }]))
  const report = migrate({ home: env.home, hermesHome: env.hermesHome, dryRun: true, runner })

  assert.equal(report.crons.detected, 1)
  assert.equal(report.crons.removed, 0)
  assert.deepEqual(calls, ['hermes cron list'], 'dryRun では remove を呼ばない')
  assert.match(formatReport(report, { dryRun: true }), /1 detected, not removed \(dry run: mobile-review-watch\)/)
  // dryRun でもコピーはしない
  assert.equal(fs.existsSync(path.join(env.hermesHome, 'plugin-data', 'hermes-pilot', 'review', 'sheets')), false)
})

test('旧環境が無いときのレポートはクリーンアップ 0 件を明示する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-nocron-report-'))
  const hermesHome = path.join(home, '.hermes')
  fs.mkdirSync(hermesHome, { recursive: true })
  const text = formatReport(migrate({ home, hermesHome, runner: noCronRunner() }))
  assert.match(text, /legacy cron cleanup: 0/)
})

// ── D72: 移行レポートと運用スクリプトの出力は英語（CJK ゼロ）─────────────

/** 出力に混ざってはいけない文字（CJK・全角和文記号）。 */
const CJK_OUT = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff60]/

test('formatReport は英語だけで出る（CJK ゼロ・dryRun も含む）', () => {
  const env = tempLegacy()
  const text = formatReport(migrate({ home: env.home, hermesHome: env.hermesHome, runner: noCronRunner() }))
  assert.deepEqual(text.split('\n').filter((l) => CJK_OUT.test(l)), [], 'レポートに日本語が混ざっている')

  const dry = formatReport(
    migrate({ home: env.home, hermesHome: env.hermesHome, runner: noCronRunner(), dryRun: true }),
    { dryRun: true },
  )
  assert.deepEqual(dry.split('\n').filter((l) => CJK_OUT.test(l)), [], 'dry run のレポートに日本語が混ざっている')
  assert.match(dry, /dry run: nothing was written/)
  assert.match(text, /sheets : new \d+ \/ existing \d+/)
  assert.match(text, /legacy cron cleanup: 0/)
})

test('postinstall / deploy の出力行に日本語が無い（D72・静的検査）', () => {
  // これらは実際には走らせにくい（npm install 後・本番入れ替え）ので、出力呼び出しの行を直接見る。
  for (const rel of ['scripts/postinstall.mjs', 'scripts/deploy.mjs']) {
    const src = fs.readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8')
    const outLines = src
      .split('\n')
      .filter((l) => /console\.(?:log|warn|error)\(|throw new Error\(/.test(l))
    assert.ok(outLines.length > 0, `${rel} に出力呼び出しが見つからない`)
    assert.deepEqual(outLines.filter((l) => CJK_OUT.test(l)), [], `${rel} の出力に日本語が残っている`)
  }
})

// ── D55: init の無言自動移行をやめる ────────────────────────────────────

test('migrationDecision は旧環境・--yes・TTY の組み合わせで 4 通りに分かれる', () => {
  assert.equal(migrationDecision({ hasLegacy: false }), 'skip')
  assert.equal(migrationDecision({ hasLegacy: false, yes: true, isTTY: true }), 'skip', '旧環境が無ければ移行しない')
  assert.equal(migrationDecision({ hasLegacy: true }), 'manual', '非 TTY かつ --yes 無しは案内だけ')
  assert.equal(migrationDecision({ hasLegacy: true, isTTY: true }), 'ask', 'TTY は y/N を聞く')
  assert.equal(migrationDecision({ hasLegacy: true, yes: true }), 'migrate', '--yes は確認なし')
})
