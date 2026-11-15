import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  migrate,
  findKanbanDbs,
  rewriteKanbanTag,
  formatReport,
  resolveHermesHome,
  cleanupLegacyCrons,
  cronStorePaths,
  isLegacyCronEntry,
} from '../../../scripts/migrate-to-hermes-pilot.mjs'

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

test('migrate はシート・画像・jsonl・token を物理コピーし、旧ディレクトリを消さない', () => {
  const env = tempLegacy()
  const report = migrate({ home: env.home, hermesHome: env.hermesHome })

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
  migrate({ home: env.home, hermesHome: env.hermesHome })
  const src = fs.statSync(path.join(env.srcRoot, 'library', 'chat', 'shot.png'))
  const dest = fs.statSync(
    path.join(env.hermesHome, 'plugin-data', 'hermes-pilot', 'review', 'library', 'chat', 'shot.png'),
  )
  assert.equal(Math.round(dest.mtimeMs), Math.round(src.mtimeMs))
})

test('migrate は kanban.db の [akapen] を [review] に置換し、必ず .bak を取る', () => {
  const env = tempLegacy()
  const report = migrate({ home: env.home, hermesHome: env.hermesHome })

  const dbPath = path.join(env.boardDir, 'kanban.db')
  const hit = report.kanban.find((k) => k.db === dbPath)
  assert.equal(hit.updated, 2, '2 件だけ置換する')
  assert.ok(hit.backup && fs.existsSync(hit.backup), '書換前にバックアップを取る')
  assert.match(path.basename(hit.backup), /^kanban\.db\.bak-/)

  const db = new DatabaseSync(dbPath)
  const bodies = Object.fromEntries(db.prepare('SELECT id, body FROM tasks').all().map((r) => [r.id, r.body]))
  db.close()
  assert.match(bodies.t_aaa00001, /^\[review\] /m)
  assert.equal(bodies.t_aaa00001.includes('[akapen]'), false)
  assert.match(bodies.t_aaa00002, /^\[review\] /m)
  assert.match(bodies.t_aaa00003, /^\[review\] /m, '既存の [review] は変わらない')
  assert.equal(bodies.t_aaa00004, 'ふつうの本文')

  // バックアップは置換前の内容
  const bak = new DatabaseSync(hit.backup, { readOnly: true })
  const oldBody = bak.prepare("SELECT body FROM tasks WHERE id='t_aaa00001'").get().body
  bak.close()
  assert.match(oldBody, /\[akapen\]/)
})

test('migrate は board.json の default_workdir を新パスへ移す', () => {
  const env = tempLegacy()
  const report = migrate({ home: env.home, hermesHome: env.hermesHome })
  assert.equal(report.boards.length, 1)
  const meta = JSON.parse(fs.readFileSync(path.join(env.boardDir, 'board.json'), 'utf8'))
  assert.equal(meta.default_workdir, path.join(env.hermesHome, 'plugin-data', 'hermes-pilot', 'review'))
  assert.equal(meta.slug, 'mobile', '他のキーは保つ')
})

test('migrate は冪等（2 回流してもファイルもタスクも増えない）', () => {
  const env = tempLegacy()
  migrate({ home: env.home, hermesHome: env.hermesHome })
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
  const baksBefore = fs.readdirSync(env.boardDir).filter((f) => f.startsWith('kanban.db.bak-')).length

  const second = migrate({ home: env.home, hermesHome: env.hermesHome })
  assert.equal(second.copied.sheets, 0)
  assert.equal(second.copied.shots, 0)
  assert.equal(second.copied.library, 0)
  assert.equal(second.copied.reviewFiles, 0)
  assert.equal(second.copied.session, 0)
  assert.equal(countFiles(review), before, 'ファイル数は増えない')

  const hit = second.kanban.find((k) => k.db === dbPath)
  assert.equal(hit.updated, 0, '置換対象が無ければ書き換えない')
  assert.equal(hit.backup, null, '変更が無ければバックアップも増やさない')
  assert.equal(
    fs.readdirSync(env.boardDir).filter((f) => f.startsWith('kanban.db.bak-')).length,
    baksBefore,
  )
})

test('旧環境が無くても落ちず、レポートに skipped を残す', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-empty-'))
  const hermesHome = path.join(home, '.hermes')
  fs.mkdirSync(hermesHome, { recursive: true })
  const report = migrate({ home, hermesHome })
  assert.equal(report.copied.sheets, 0)
  assert.ok(report.skipped.length > 0)
  const text = formatReport(report)
  assert.match(text, /sheets : 新規 0/)
  assert.match(text, /旧ディレクトリは削除していません/)
})

test('findKanbanDbs はルートと各ボードの DB を拾う', () => {
  const env = tempLegacy()
  const other = path.join(env.hermesHome, 'kanban', 'boards', 'work')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, 'kanban.db'), '')
  const dbs = findKanbanDbs(env.hermesHome)
  assert.ok(dbs.some((p) => p.endsWith(path.join('boards', 'mobile', 'kanban.db'))))
  assert.ok(dbs.some((p) => p.endsWith(path.join('boards', 'work', 'kanban.db'))))
})

test('rewriteKanbanTag はタスク表が無い DB でも例外を投げない（呼び出し側で拾う）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-bad-'))
  const dbPath = path.join(dir, 'kanban.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE other (id TEXT)')
  db.close()
  assert.throws(() => rewriteKanbanTag(dbPath), /no such table|tasks/i)
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
  })
  assert.equal(report.hermesHome, env.hermesHome)
  assert.equal(report.pluginDataDir, path.join(env.hermesHome, 'plugin-data', 'hermes-pilot'))
  assert.equal(fs.existsSync(path.join(env.hermesHome, 'profiles', 'mobile', 'plugin-data')), false)
  // kanban.db も本物（profiles の外）を見つける
  assert.equal(report.kanban.length, 1)
  assert.equal(report.kanban[0].updated, 2)
})

// ── D44: 旧外部 cron の自動クリーンアップ ───────────────────────────────

/** cron/jobs.json を一時 hermesHome に作り、{jobs, updated_at} を返す。 */
function tempCronStore(jobs, { arrayForm = false, extra = {} } = {}) {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-cron-'))
  const [file] = cronStorePaths(hermesHome)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = arrayForm ? jobs : { jobs, updated_at: '2026-11-15T00:00:00+08:00', ...extra }
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  return { hermesHome, file }
}

test('cleanupLegacyCrons は旧 akapen/review watch だけを消し、他の cron とトップレベル構造を保つ', () => {
  const store = tempCronStore(
    [
      { id: 'c1', name: 'mobile-akapen-watch', prompt: '赤ペンの完了を Discord へ' },
      { id: 'c2', name: 'mobile-review-watch', script: 'review-watch.sh' },
      { id: 'c3', name: 'kanban-reap', script: 'kanban-reap.sh' },
      { id: 'c4', name: 'morning-brief', prompt: '朝のブリーフ' },
    ],
    { extra: { version: 3 } },
  )

  const res = cleanupLegacyCrons(store.hermesHome)
  assert.equal(res.removed, 2)
  assert.deepEqual(res.names, ['mobile-akapen-watch', 'mobile-review-watch'])
  assert.equal(res.errors.length, 0)

  const saved = JSON.parse(fs.readFileSync(store.file, 'utf8'))
  assert.deepEqual(
    saved.jobs.map((j) => j.id),
    ['c3', 'c4'],
    '一致しないジョブは保持する',
  )
  assert.equal(saved.updated_at, '2026-11-15T00:00:00+08:00', 'トップレベルの updated_at を保つ')
  assert.equal(saved.version, 3, '未知のトップレベルキーも保つ')
  // 元ファイルだけが残る（tmp が残らない＝原子的書き込み）
  assert.deepEqual(fs.readdirSync(path.dirname(store.file)).sort(), ['jobs.json'])
})

test('cleanupLegacyCrons は配列形式の cron ストアにも効く', () => {
  const store = tempCronStore(
    [{ name: 'mobile-akapen-watch' }, { name: 'keep-me' }],
    { arrayForm: true },
  )
  const res = cleanupLegacyCrons(store.hermesHome)
  assert.equal(res.removed, 1)
  const saved = JSON.parse(fs.readFileSync(store.file, 'utf8'))
  assert.ok(Array.isArray(saved), '配列形式を保つ')
  assert.deepEqual(
    saved.map((j) => j.name),
    ['keep-me'],
  )
})

test('cleanupLegacyCrons は name 以外（script / prompt / label / id）でも旧 cron を検出する', () => {
  assert.equal(isLegacyCronEntry({ script: '/opt/mobile-akapen-watch.sh' }), true)
  assert.equal(isLegacyCronEntry({ prompt: 'mobile-review-watch を回す' }), true)
  assert.equal(isLegacyCronEntry({ label: 'mobile-akapen-watch' }), true)
  assert.equal(isLegacyCronEntry({ id: 'mobile-review-watch-2' }), true)
  assert.equal(isLegacyCronEntry({ name: 'kanban-reap', script: 'kanban-reap.sh' }), false)
  assert.equal(isLegacyCronEntry({}), false)
  assert.equal(isLegacyCronEntry(null), false)
})

test('cleanupLegacyCrons は cron ストアが無い環境で無害に空結果を返す', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-nocron-'))
  const res = cleanupLegacyCrons(hermesHome)
  assert.equal(res.removed, 0)
  assert.deepEqual(res.names, [])
  assert.deepEqual(res.files, [])
  assert.equal(res.errors.length, 0)
})

test('cleanupLegacyCrons は dryRun でファイルを書き換えない', () => {
  const store = tempCronStore([{ name: 'mobile-akapen-watch' }, { name: 'keep-me' }])
  const before = fs.readFileSync(store.file, 'utf8')
  const stamp = fs.statSync(store.file).mtimeMs

  const res = cleanupLegacyCrons(store.hermesHome, { dryRun: true })
  assert.equal(res.removed, 1, '何が消えるかは返す')
  assert.deepEqual(res.names, ['mobile-akapen-watch'])
  assert.equal(fs.readFileSync(store.file, 'utf8'), before, '本文は変わらない')
  assert.equal(fs.statSync(store.file).mtimeMs, stamp, '書き込みもしない')
})

test('cleanupLegacyCrons は冪等（2 回目は 0 件で書き込まない）', () => {
  const store = tempCronStore([{ name: 'mobile-akapen-watch' }, { name: 'keep-me' }])
  assert.equal(cleanupLegacyCrons(store.hermesHome).removed, 1)
  const stamp = fs.statSync(store.file).mtimeMs
  const second = cleanupLegacyCrons(store.hermesHome)
  assert.equal(second.removed, 0)
  assert.equal(fs.statSync(store.file).mtimeMs, stamp, '対象が無ければ書かない')
})

test('cleanupLegacyCrons は壊れた JSON を消さずに errors へ積む', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-badcron-'))
  const [file] = cronStorePaths(hermesHome)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ this is not json', 'utf8')
  const res = cleanupLegacyCrons(hermesHome)
  assert.equal(res.removed, 0)
  assert.equal(res.errors.length, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json')
})

test('migrate は旧 cron を片付け、レポートに削除件数を出す', () => {
  const env = tempLegacy()
  const [file] = cronStorePaths(env.hermesHome)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        jobs: [
          { id: 'c1', name: 'mobile-akapen-watch' },
          { id: 'c2', name: 'kanban-reap' },
        ],
        updated_at: '2026-11-15T00:00:00+08:00',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  const report = migrate({ home: env.home, hermesHome: env.hermesHome })
  assert.equal(report.crons.removed, 1)
  assert.deepEqual(report.crons.names, ['mobile-akapen-watch'])
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(saved.jobs.map((j) => j.id), ['c2'])
  assert.match(formatReport(report), /旧 cron のクリーンアップ: 1 件を削除（mobile-akapen-watch）/)
})

test('migrate の dryRun は旧 cron を検出するだけで消さない', () => {
  const env = tempLegacy()
  const [file] = cronStorePaths(env.hermesHome)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const before = `${JSON.stringify({ jobs: [{ name: 'mobile-review-watch' }] }, null, 2)}\n`
  fs.writeFileSync(file, before, 'utf8')

  const report = migrate({ home: env.home, hermesHome: env.hermesHome, dryRun: true })
  assert.equal(report.crons.removed, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'dryRun では書かない')
})

test('旧環境が無いときのレポートはクリーンアップ 0 件を明示する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-nocron-report-'))
  const hermesHome = path.join(home, '.hermes')
  fs.mkdirSync(hermesHome, { recursive: true })
  const text = formatReport(migrate({ home, hermesHome }))
  assert.match(text, /旧 cron のクリーンアップ: 0 件/)
})
