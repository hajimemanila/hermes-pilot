/**
 * ブレストシート（`BrainstormSheet`）用の純関数ロジック。
 *
 * 公開プラグインとして任意のリポジトリ・テーマで使えるよう、特定プロジェクト固有の
 * 前提を持たず、チャットへ渡す際も「アイデアを広げる（発散する）」役割指示を明示する。
 */

export const BRAINSTORM_ANGLES = Object.freeze([
  { id: 'feature', key: 'brainstorm.angleFeature' },
  { id: 'ux', key: 'brainstorm.angleUx' },
  { id: 'edge', key: 'brainstorm.angleEdge' },
])

/**
 * メモと選択した観点から汎用チェックリスト項目を組み立てる。
 *
 * @param {string} seed 元のメモ／アイデア
 * @param {string[]} angles 選択中の観点 ID 群
 * @param {Function} t i18n 翻訳関数
 * @returns {Array<{id: string, text: string, done: boolean}>} チェックリスト項目
 */
export function buildBrainstormItems(seed, angles, t) {
  const topic = String(seed ?? '').trim()
  const active = Array.isArray(angles) ? angles : []
  const items = []
  if (active.includes('feature')) {
    items.push(t('brainstorm.tpl.feature1', { topic }), t('brainstorm.tpl.feature2'))
  }
  if (active.includes('ux')) {
    items.push(t('brainstorm.tpl.ux1'), t('brainstorm.tpl.ux2'))
  }
  if (active.includes('edge')) {
    items.push(t('brainstorm.tpl.edge1'), t('brainstorm.tpl.edge2'))
  }
  return items.map((text, idx) => ({ id: `bs_${Date.now()}_${idx}`, text, done: false }))
}

/**
 * チャットへ渡すブレスト用プロンプトを組み立てる。
 *
 * 元メモとチェックリストだけを素送りすると「未完了タスクを実装・収束させる提案」に
 * 寄ってしまうため、ブレスト（発散・別案・深掘り質問）を求める導入指示を先頭に添える。
 *
 * @param {{seed: string, angles?: string[], items?: Array<{text?: string}>, t: Function}} params
 * @returns {string} チャット入力欄へ渡すプロンプト
 */
export function buildBrainstormChatPrompt({ seed = '', angles = [], items = [], t }) {
  const cleanSeed = String(seed ?? '').trim()
  const angleLabels = (Array.isArray(angles) ? angles : [])
    .map((id) => BRAINSTORM_ANGLES.find((a) => a.id === id))
    .filter(Boolean)
    .map((a) => t(a.key))
  const lines = (Array.isArray(items) ? items : [])
    .map((c) => String(c?.text ?? '').trim())
    .filter(Boolean)
    .map((text) => `- [ ] ${text}`)
    .join('\n')

  const parts = [t('brainstorm.chatPromptIntro')]
  if (angleLabels.length) {
    parts.push(t('brainstorm.chatPromptAngles', { angles: angleLabels.join(' / ') }))
  }
  if (cleanSeed) {
    parts.push(`${t('brainstorm.chatPromptNote')}\n${cleanSeed}`)
  }
  if (lines) {
    parts.push(`${t('brainstorm.chatPromptChecklist')}\n${lines}`)
  }
  return parts.filter(Boolean).join('\n\n')
}
