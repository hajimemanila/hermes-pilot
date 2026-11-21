/**
 * テスト用の一時ディレクトリ補助（`specs.test.js` から分割した `specsMode.test.js` と共用）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 一時ディレクトリを作る。 */
export function tempDir(prefix = 'hm-specs-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** `<dir>/<rel>` を書く（親も作る）。 */
export function writeFile(dir, rel, text) {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
  return abs
}
