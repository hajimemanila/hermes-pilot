/**
 * 移行前データとの互換タグ。coherence のソフトシグナル（旧名の残存）が許す唯一の箇所。
 *
 * 旧タグは**読むだけ**受ける（書き込み側は常に `[review]`）。リテラルをここ 1 箇所に集約し、
 * SQL はテンプレート文字列、正規表現は `new RegExp` で組み立てて使う（マッチ挙動は変えない）。
 */
export const LEGACY_REVIEW_TAG = '[akapen]'

/** 旧タグ名だけ（正規表現の交互に埋める）。 */
export const LEGACY_REVIEW_NAME = LEGACY_REVIEW_TAG.slice(1, -1)

/** SQL の `LIKE` に渡す `%<旧タグ>%`。 */
export const LEGACY_REVIEW_LIKE = `%${LEGACY_REVIEW_TAG}%`
