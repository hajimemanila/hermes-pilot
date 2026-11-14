/**
 * Annotation の「1 タップ指示スタンプ」（SPEC-PILOT-V5 §3.3 ② / D26）。
 *
 * 狙いは **キーボードを開かずに視覚修正指示を送る**こと。6 種のスタンプは
 * キャンバス上のストローク（赤入れ）に紐づき、送信時に
 *  - `marks[].stamp`（構造化メタデータ。Vision レーンと後段の自動修正が読む）
 *  - `note` の末尾に自動合成した指示一覧（ワーカーが読む自然文）
 * の 2 経路でワーカーへ渡る。ユーザーは 1 文字も打たない。
 *
 * ここは React に依存しない純関数だけを置く（`node --test` で単体検証する）。
 * ラベル文言は `annot.stamp.*` の i18n キーで、`src/` に生の日本語は置かない。
 */

/**
 * 6 種のスタンプ定義。
 *
 * `instruction` は**ワーカー（英語で動くエージェント）へ渡す指示文**なので
 * 画面の言語に関係なく英語で固定する（訳すと自動修正の解釈がぶれる）。
 *
 * @type {Array<{id: string, emoji: string, key: string, instruction: string}>}
 */
export const STAMPS = [
  { id: 'overlap', emoji: '💥', key: 'annot.stamp.overlap', instruction: 'Fix element overlap around this marked area.' },
  { id: 'spacing', emoji: '📏', key: 'annot.stamp.spacing', instruction: 'Adjust padding and spacing balance here.' },
  { id: 'overflow', emoji: '✂️', key: 'annot.stamp.overflow', instruction: 'Fix horizontal overflow or truncated text here.' },
  { id: 'contrast', emoji: '🎨', key: 'annot.stamp.contrast', instruction: 'Improve text/background contrast ratio here.' },
  { id: 'shift_up', emoji: '🔼', key: 'annot.stamp.shift_up', instruction: 'Shift this element up to clear the bottom bar.' },
  { id: 'remove', emoji: '🗑️', key: 'annot.stamp.remove', instruction: 'Remove or hide this element.' },
]

/** 1 本もストロークが無いときに自動生成する矩形の位置（画像に対する割合）。 */
export const AUTO_BOX = { x0: 0.35, y0: 0.35, x1: 0.65, y1: 0.65 }

/** レイアウト前（幅・高さが 0）に自動ボックスを作るときの暫定キャンバス長辺。 */
const FALLBACK_SIZE = 1000

const BY_ID = new Map(STAMPS.map((s) => [s.id, s]))

/**
 * id からスタンプ定義を引く。
 * @param {string} id スタンプ id
 * @returns {{id: string, emoji: string, key: string, instruction: string}|null} 定義（未知なら null）
 */
export function stampById(id) {
  return BY_ID.get(String(id ?? '')) || null
}

/**
 * ストロークに載せる `stamp` メタデータ（送信 JSON と同じ形）。
 * @param {string} id スタンプ id
 * @returns {{id: string, label: string, instruction: string}|null} メタデータ
 */
export function stampMeta(id) {
  const s = stampById(id)
  return s ? { id: s.id, label: s.key, instruction: s.instruction } : null
}

/** 直近ストロークに付いているスタンプ id（チップの on 表示用）。 */
export function lastStampId(strokes) {
  const list = Array.isArray(strokes) ? strokes : []
  return list.length ? list[list.length - 1]?.stamp?.id ?? null : null
}

/**
 * スタンプをキャンバスへ適用する（**入力配列は変更しない**）。
 *
 * - 既にストロークがある → **最後のストローク**に `stamp` を紐づける
 *   （同じストロークに別のスタンプを押し直すと置き換え。Undo で 1 本戻せる）
 * - 1 本も無い → 中央付近（`AUTO_BOX`）に小さな矩形ストロークを自動生成して紐づける。
 *   これにより「赤を引かずにスタンプだけ押して送信」が成立する（入力 0 文字）
 *
 * @param {Array<object>} strokes 現在のストローク配列（CSS px 座標）
 * @param {string} stampId スタンプ id
 * @param {{w: number, h: number}|null} [box] キャンバスの CSS px サイズ（自動ボックス用）
 * @returns {{strokes: Array<object>, stroke: object|null, stamp: object|null, created: boolean}} 新しい配列と結果
 */
export function applyStampToStrokes(strokes, stampId, box) {
  const list = Array.isArray(strokes) ? strokes : []
  const meta = stampMeta(stampId)
  if (!meta) return { strokes: list, stroke: null, stamp: null, created: false }

  const last = list[list.length - 1]
  if (last) {
    const stroke = { ...last, stamp: meta }
    return { strokes: [...list.slice(0, -1), stroke], stroke, stamp: meta, created: false }
  }

  const w = Number(box?.w) > 0 ? Number(box.w) : FALLBACK_SIZE
  const h = Number(box?.h) > 0 ? Number(box.h) : FALLBACK_SIZE
  const round = (v) => Math.round(v * 10) / 10
  const stroke = {
    tool: 'rect',
    auto: true,
    points: [
      [round(AUTO_BOX.x0 * w), round(AUTO_BOX.y0 * h)],
      [round(AUTO_BOX.x1 * w), round(AUTO_BOX.y1 * h)],
    ],
    stamp: meta,
  }
  return { strokes: [...list, stroke], stroke, stamp: meta, created: true }
}

/**
 * 送信用 `marks` を組む（CSS px → 画像に対する 0..1・小数 3 桁）。
 *
 * `stamp` を持つストロークだけ `stamp` メタデータを載せる（無いものには付けない）。
 * 送信先 bridge は `tool` / `points` のみ保存するが、クライアント側の
 * 送信 JSON には仕様どおり `stamp` を含める（note 側にも同じ内容が入る）。
 *
 * @param {Array<object>} strokes ストローク配列
 * @param {{width: number, height: number}} size キャンバスの CSS px サイズ
 * @returns {Array<{tool: string, points: number[][], stamp?: object, auto?: true}>} 正規化済み marks
 */
export function strokesToMarks(strokes, size) {
  const w = Number(size?.width) || 0
  const h = Number(size?.height) || 0
  const norm = (v, dim) => (dim > 0 ? Math.round((v / dim) * 1000) / 1000 : 0)
  return (Array.isArray(strokes) ? strokes : []).map((s) => {
    const mark = {
      tool: String(s?.tool || 'pen'),
      points: (Array.isArray(s?.points) ? s.points : []).map((p) => [
        norm(Number(p?.[0]) || 0, w),
        norm(Number(p?.[1]) || 0, h),
      ]),
    }
    if (s?.stamp) {
      mark.stamp = { id: s.stamp.id, label: s.stamp.label, instruction: s.stamp.instruction }
    }
    if (s?.auto) mark.auto = true
    return mark
  })
}

/**
 * 描画・採番用にスタンプ付きストロークを 1 始まりの連番で返す。
 * @param {Array<object>} strokes ストローク配列
 * @returns {Array<{index: number, stroke: object, stamp: object, emoji: string}>} スタンプ一覧
 */
export function stampPills(strokes) {
  const out = []
  for (const stroke of Array.isArray(strokes) ? strokes : []) {
    const stamp = stroke?.stamp
    if (!stamp) continue
    out.push({
      index: out.length + 1,
      stroke,
      stamp,
      emoji: stampById(stamp.id)?.emoji ?? '🏷️',
    })
  }
  return out
}

/**
 * `note` に自動合成するスタンプ由来の一覧（1 行 1 スタンプ）。
 * @param {Array<object>} strokes ストローク配列
 * @returns {string[]} 例: `#1 💥 Fix element overlap around this marked area.`
 */
export function stampNoteLines(strokes) {
  return stampPills(strokes).map((p) => `#${p.index} ${p.emoji} ${p.stamp.instruction}`)
}

/** スタンプ一覧の見出し（note 内で人が見て区切りが分かるように）。 */
export const STAMP_NOTE_HEADER = '[Stamps]'

/**
 * 送信 `note` を組む。ユーザーのひとこと（任意）＋ スタンプ一覧。
 * @param {string} note ユーザー入力のメモ
 * @param {Array<object>} strokes ストローク配列
 * @returns {string} 送信する note（スタンプが無ければユーザー入力をそのまま）
 */
export function composeNote(note, strokes) {
  const base = String(note ?? '').trim()
  const lines = stampNoteLines(strokes)
  if (!lines.length) return base
  const block = [STAMP_NOTE_HEADER, ...lines].join('\n')
  return base ? `${base}\n${block}` : block
}
