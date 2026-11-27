/**
 * architect テストの共用フィクスチャ（`architect.test.js` / `architectJobView.test.js` /
 * `architectTask.test.js` / `architectBatch.test.js`）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 一時リポジトリ（`docs/` 付き）。 */
export function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-architect-'))
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  return root
}

/** SPEC を 1 枚書く（mtime を指定できる）。 */
export function writeSpec(repo, name, text, mtimeMs) {
  const file = path.join(repo, 'docs', name)
  fs.writeFileSync(file, text)
  if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  return `docs/${name}`
}

export const SPEC_TEXT = [
  '# SPEC: Demo',
  '',
  '### Batch D-1: One',
  '',
  '- **Execution Mode**: `[Mode: Zero-Stop]`',
  '- **目的**: 一つ目',
  '',
  '### Batch D-2: Two',
  '',
  '- **Execution Mode**: `[Mode: Visual Gate]`',
  '- **目的**: 二つ目',
  '',
].join('\n')

/** ランナー解決を待つ（`seed()` は待たない設計なので、テスト側だけ待つ）。 */
export async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

/** `seed` の定型入力。 */
export function seedInput(repo, over = {}) {
  return { repoPath: repo, board: 'demo', seedText: '新機能の仕様化: 通知まとめ', ...over }
}

/** 起票だけを返すダミー CLI（引数・cwd・PATH を記録できる）。 */
export function fakeCli(name = 'cli') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-cli-'))
  const file = path.join(dir, name)
  const script = [
    '#!/bin/sh',
    'if [ -n "$HPA_FAKE_OUT" ]; then',
    '  printf "%s\\000" "$@" > "$HPA_FAKE_OUT.args"',
    '  printf "%s" "$PWD" > "$HPA_FAKE_OUT.pwd"',
    '  printf "%s" "$PATH" > "$HPA_FAKE_OUT.path"',
    'fi',
    'printf \'{"id":"t_archfake"}\'',
    'exit 0',
    '',
  ].join('\n')
  fs.writeFileSync(file, script, { mode: 0o755 })
  return file
}

/** ダミー CLI が書いた実行記録を読む。 */
export function readFakeOut(out) {
  return {
    args: fs.readFileSync(`${out}.args`, 'utf8').split('\0').slice(0, -1),
    pwd: fs.readFileSync(`${out}.pwd`, 'utf8'),
    path: fs.readFileSync(`${out}.path`, 'utf8'),
  }
}

/** 最小スキーマのカンバン DB を作る（task_events は作らない）。 */
export function makeKanbanBoard(dir, slug = 'demo') {
  const boardDir = path.join(dir, 'kanban', 'boards', slug)
  fs.mkdirSync(boardDir, { recursive: true })
  fs.writeFileSync(path.join(boardDir, 'board.json'), JSON.stringify({ slug, name: 'Demo' }))
  const db = new DatabaseSync(path.join(boardDir, 'kanban.db'))
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, body TEXT, assignee TEXT, status TEXT,
      priority INTEGER, created_at INTEGER, started_at INTEGER, completed_at INTEGER,
      workspace_path TEXT, branch_name TEXT, worker_pid INTEGER, last_heartbeat_at INTEGER,
      result TEXT, consecutive_failures INTEGER, session_id TEXT, current_step_key TEXT)
  `)
  return { db, boardDir }
}
