/**
 * 注釈エディタのレイアウト規約（注釈 1405）の自動検証。
 *
 * 赤入れ画面で「スクショが小さく視認性が悪い」問題への対策として、次の 3 つを
 * 構造として固定する（見た目が戻ったらテストで気づけるようにする）:
 *
 * - 指示スタンプは **1 行の横スクロール**（`overflow-x: auto` / 折り返さない）
 * - 幅 560px 以上では「画像｜操作列」の横並び（`.ak-anno.wide`）にして高さを画像へ渡す
 * - 検収 OK（✅ 完了）とアーカイブは **最下部の同じ行**に並ぶ（`─.ak-anno-actions`）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const here = import.meta.dirname
const css = fs
  .readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
const editor = fs.readFileSync(path.resolve(here, '../src/features/AnnotationEditor.jsx'), 'utf8')

/** セレクタ 1 つの宣言ブロックを取り出す（行頭一致。`.a .b` を `.b` と誤認しない）。 */
function rule(selector) {
  const at = css.indexOf(`\n${selector} {`)
  assert.notEqual(at, -1, `${selector} の規則が無い`)
  const end = css.indexOf('}', at)
  return css.slice(at, end)
}

test('スタンプは 1 行の横スクロール（折り返さない）', () => {
  const scroll = rule('.ak-anno-stamps-scroll')
  assert.match(scroll, /overflow-x:\s*auto/, '横スクロールが無い')
  assert.doesNotMatch(scroll, /flex-wrap:\s*wrap/, '折り返すと 2 段になって画像の高さを奪う')
  // 旧 2 段組みのクラスは残さない
  assert.equal(css.includes('.ak-anno-stamps-title'), false, '旧スタンプ帯の見出しが残っている')
})

test('560px 以上は「画像｜操作列」の横並び（.ak-anno.wide）', () => {
  assert.match(rule('.ak-anno.wide .ak-anno-body'), /flex-direction:\s*row/, 'wide の横並びが無い')
  assert.match(rule('.ak-anno-body'), /flex-direction:\s*column/, '既定は縦積みであること')
  assert.match(rule('.ak-anno-side'), /flex-direction:\s*column/)
  // JS 側の閾値と CSS の wide クラスが対応していること
  assert.match(editor, /const WIDE_MIN = 560/)
  assert.match(editor, /className=\{`ak-anno\$\{wide \? ' wide' : ''\}`\}/)
})

test('✅ 完了 と 📂 アーカイブ は最下部の同じ行に並ぶ', () => {
  assert.match(rule('.ak-anno-actions'), /display:\s*flex/)
  assert.match(rule('.ak-anno-actions'), /margin-top:\s*auto/, '判断バーは最下部に置く')
  assert.match(editor, /className="ak-anno-actions"/)
  assert.match(editor, /className="ak-anno-done"/)
  assert.match(editor, /<HoldButton/, 'アーカイブは誤タップ対策の長押し')
  // 旧 UI（全幅の検収ボタン + 片付けメニュー）は注釈画面から外す
  assert.equal(editor.includes('close-actions'), false, '旧 CloseActions が残っている')
  assert.equal(editor.includes('ak-approve-row'), false, '旧 検収 OK 行が残っている')
})

test('スタンプの全一覧はドロワー（Sheet）から開ける', () => {
  assert.match(editor, /stampSheet/, 'ドロワーの state が無い')
  assert.match(editor, /<Sheet title=\{t\('annot\.stampSheetTitle'\)\}/, 'Sheet が無い')
  assert.match(editor, /className="ak-anno-more"/, '「＋」ボタンが無い')
})
