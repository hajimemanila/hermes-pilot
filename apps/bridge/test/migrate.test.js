import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate, findKanbanDbs, rewriteKanbanTag, formatReport } from '../../../scripts/migrate-to-hermes-pilot.mjs'

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
