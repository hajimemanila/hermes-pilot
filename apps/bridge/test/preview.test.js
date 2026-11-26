import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectProjectPreview, readPreviewFile } from '../src/preview.js'
import { createRepos } from '../src/repos.js'

test('preview: detectProjectPreview と readPreviewFile は dist/index.html を検出し同一オリジン配信する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-prev-'))
  const dist = path.join(dir, 'dist')
  const assets = path.join(dist, 'assets')
  fs.mkdirSync(assets, { recursive: true })
  fs.writeFileSync(
    path.join(dist, 'index.html'),
    '<html><head><title>B News</title></head><body><script src="/assets/app.js"></script></body></html>',
  )
  fs.writeFileSync(path.join(assets, 'app.js'), 'console.log("ok")')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))

  const info = detectProjectPreview(dir, 'b-news')
  assert.equal(info.kind, 'static')
  assert.equal(info.url, '/api/boards/b-news/preview-files/')
  assert.equal(info.entry, 'dist/index.html')
  assert.equal(info.launchCmd, 'npm run dev')

  const html = readPreviewFile(dir, 'b-news', '')
  assert.equal(html.ok, true)
  const text = html.data.toString('utf8')
  assert.match(text, /<base href="\/api\/boards\/b-news\/preview-files\/">/)
  assert.match(text, /src="\/api\/boards\/b-news\/preview-files\/assets\/app\.js"/)

  const js = readPreviewFile(dir, 'b-news', 'assets/app.js')
  assert.equal(js.ok, true)
  assert.match(js.type, /javascript/)

  assert.equal(readPreviewFile(dir, 'b-news', '../package.json').ok, false)

  // シンボリックリンク脱出も拒否する
  const outside = path.join(os.tmpdir(), `secret-${Date.now()}.txt`)
  fs.writeFileSync(outside, 'secret')
  try {
    fs.symlinkSync(outside, path.join(dist, 'leak.txt'))
    assert.equal(readPreviewFile(dir, 'b-news', 'leak.txt').ok, false)
  } finally {
    fs.rmSync(outside, { force: true })
  }
})

test('preview: 静的成果物が無く scripts だけある場合は kind=app を返す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-app-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node index.js' } }))
  const info = detectProjectPreview(dir, 'cli-app')
  assert.equal(info.kind, 'app')
  assert.equal(info.url, null)
  assert.equal(info.launchCmd, 'npm start')
})

test('repos.createNew は新規ディレクトリ + git init + repo登録 + board作成を一気に行う', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-newproj-'))
  const scanDir = path.join(root, 'projects')
  fs.mkdirSync(scanDir, { recursive: true })
  const configPath = path.join(root, 'repos.json')
  const gitCalls = []
  const kanbanCalls = []

  const repos = createRepos(
    { reposPath: configPath },
    {
      boards: () => [],
      cwds: () => [],
      runner: (args) => {
        kanbanCalls.push(args)
        return { code: 0, stdout: 'created', stderr: '' }
      },
      runGit: (args, cwd) => {
        gitCalls.push({ args, cwd })
        fs.mkdirSync(path.join(cwd, '.git'), { recursive: true })
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  )
  repos.setScanDirs([scanDir])

  const bad = await repos.createNew({ name: '///' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'BOARD_NAME_INVALID')

  const created = await repos.createNew({ name: 'B News Site' })
  assert.equal(created.ok, true)
  assert.equal(created.board.slug, 'b-news-site')
  assert.equal(fs.existsSync(path.join(scanDir, 'b-news-site', 'README.md')), true)
  assert.equal(gitCalls.length, 1)
  assert.ok(kanbanCalls.some((c) => c[0] === 'kanban' && c[2] === 'create' && c[3] === 'b-news-site'))

  const dup = await repos.createNew({ name: 'b-news-site' })
  assert.equal(dup.ok, false)
  assert.equal(dup.code, 'CONFLICT')
})
