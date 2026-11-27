/**
 * Review の文言（回答・操作・HTML の固定文）と機械可読行の正規表現。`review.js` から分割。
 * 公開契約は `review.js` の再エクスポートで維持する。
 */

import { LEGACY_REVIEW_NAME } from './legacy-tags.js'

/**
 * タスク本文の機械可読行（SPEC §4.1）。
 *
 * 正は `[review]`。移行前のボード（`kanban.db` の旧タグ置換が済んでいない）でも
 * レビューが消えないよう、旧タグも読むだけ受ける（書き込み側は常に `[review]`）。
 */
export const LINE_RE = new RegExp(`^\\[(?:review|${LEGACY_REVIEW_NAME})\\]\\s+(.+)$`, 'm')
export const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/i

/** 旧名（`【赤ペン回答】` / `全体への赤ペン:`）も移行前のシート資産のために受ける。 */
export const REPLY_HEAD_RE = /^【(?:レビュー|赤ペン)回答】/
/**
 * シートの回答テキストに付く見出し（移行前の `【赤ペン回答】` も受ける）。
 *
 * 注入スクリプトへは `asciiScriptString()` で埋める（`?lang=en` の出力から CJK を消すため）。
 */
export const REPLY_MARK_SOURCE = '【(?:レビュー|赤ペン)回答】|\\[Review Answer\\]'
export const GLOBAL_LABEL_RE = /^(?:全体への(?:レビュー|赤ペン)|Overall Note):\s*(.*)$/
export const ANNOTATIONS_LABEL_RE = /^(?:赤入れ注釈|Annotations):/

/**
 * 回答テキストの表記（`lang` ごと・キー集合は両言語で同一）。
 *
 * ここは**外部と共有するデータ形式**でもある（貼り付け・`answer.txt`・シート HTML の出力）。
 * だから `parseReplyText` / `reviewPaste.js` は**両表記を受ける**。片側だけ変えると往復が壊れる。
 */
export const REPLY_TEXT = {
  en: {
    head: '[Review Answer] ',
    unselected: '(unselected = take recommended)',
    noteMark: 'note:',
    globalLabel: 'Overall Note',
    annotationsLabel: 'Annotations',
    tail: 'Apply the answers above and continue. Items left unselected are settled by the recommended option.',
  },
  ja: {
    head: '【レビュー回答】',
    unselected: '(未選択 = お任せ)',
    noteMark: '補足:',
    globalLabel: '全体へのレビュー',
    annotationsLabel: '赤入れ注釈',
    tail: '上の回答を反映して作業を続けてください。お任せの項目は推奨案で確定してください。',
  },
}

/**
 * 回答テキストの表記を返す（未知の言語は en）。
 * @param {'ja'|'en'} [lang] 言語
 * @returns {typeof REPLY_TEXT.en} 表
 */
export function replyTextOf(lang) {
  return lang === 'ja' ? REPLY_TEXT.ja : REPLY_TEXT.en
}

/**
 * カンバンに残す運用 1 行（回答サマリ・unblock 理由・注釈・起票タイトル）の表。
 *
 * worker はこの 1 行を入力として読むので、実行時言語で出す（SPEC-i18n-gen §3.3）。
 * パスやタスク id などの機械トークンは**訳さない**（呼び出し側が ASCII のまま足す）。
 */
export const OPS_TEXT = {
  en: {
    answered: 'Review answers received',
    answeredAgain: 'Review answers received (resend)',
    /** @param {number} total @param {number} chosen @param {number} defaulted @param {string} rel */
    answerSummary: (total, chosen, defaulted, rel) =>
      `Review answers: ${total} (chosen ${chosen} / defaulted ${defaulted}) — ${rel}`,
    /** @param {number} strokes @param {string} note @param {string} rel */
    annotationSummary: (strokes, note, rel) => `Annotation: ${strokes} strokes${note ? ` / note: ${note}` : ''} — ${rel}`,
    annotationReceived: 'Annotation received',
    annotationReceivedAgain: 'Annotation received (resend)',
    annotationTitle: 'Annotation (from image)',
    annotationWaiting: 'Awaiting annotation (from image)',
    /** @param {string} note @param {boolean} again */
    approved: (note, again) => `Visual check OK${note ? `: ${note}` : ''}${again ? ' (resend)' : ''}`,
    remixRequested: 'Alternative requested (remix)',
    /** @param {string} qid @param {string} reason @param {string} hint @param {string} rel */
    remixSummary: (qid, reason, hint, rel) =>
      `Remix requested${qid ? ` (${qid})` : ''}: ${reason || 'alternative'}${hint ? ` — ${hint}` : ''} — ${rel}`,
  },
  ja: {
    answered: 'レビュー回答を受領',
    answeredAgain: 'レビュー回答を受領（再送）',
    answerSummary: (total, chosen, defaulted, rel) =>
      `レビュー回答: ${total}問 (選択 ${chosen} / お任せ ${defaulted}) — ${rel}`,
    annotationSummary: (strokes, note, rel) => `注釈: ${strokes} ストローク${note ? ` / メモ: ${note}` : ''} — ${rel}`,
    annotationReceived: '注釈を受領',
    annotationReceivedAgain: '注釈を受領（再送）',
    annotationTitle: '注釈（画像から作成）',
    annotationWaiting: '注釈待ち（画像から作成）',
    approved: (note, again) => `検収 OK（Visual check passed）${note ? `: ${note}` : ''}${again ? '（再送）' : ''}`,
    remixRequested: '別案を再生成リクエスト（REMIX）',
    remixSummary: (qid, reason, hint, rel) =>
      `別案リクエスト${qid ? ` (${qid})` : ''}: ${reason || '別アプローチ'}${hint ? ` — ${hint}` : ''} — ${rel}`,
  },
}

/**
 * 運用 1 行の表を返す（未知の言語は en）。
 * @param {'ja'|'en'} [lang] 言語
 * @returns {typeof OPS_TEXT.en} 表
 */
export function opsText(lang) {
  return lang === 'ja' ? OPS_TEXT.ja : OPS_TEXT.en
}

/**
 * `reopen`（変更要求）の既定理由の表。
 *
 * 理由文は worker がそのまま読む **カンバンに残る散文**なので、呼び出し元の表示言語で出す
 * （SPEC-EN-ZERO-LEAK D73）。機械トークン（タスク id・パス）は含めない。
 */
const REOPEN_TEXT = {
  en: { defaultReason: 'Please re-check and update the implementation' },
  ja: { defaultReason: 'レビューの再確認をお願いします' },
}

/**
 * `reopen` の既定理由を返す（未知の言語は en）。
 * @param {'ja'|'en'} [lang] 言語
 * @returns {typeof REOPEN_TEXT.en} 表
 */
export function reopenTextOf(lang) {
  return lang === 'ja' ? REOPEN_TEXT.ja : REOPEN_TEXT.en
}

/** 未選択を表す接頭辞（`(未選択 = お任せ)` / `(unselected = take recommended)` の両方）。 */
export const UNSELECTED_RE = /^\(\s*(?:未選択|unselected)/i

/** タスク本文から `[review] label=... round=... mode=... sheet=...` を取り出す。 */
