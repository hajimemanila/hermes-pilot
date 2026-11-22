/**
 * リスト読み取り等の安全ラッパー（D103 / SPEC-COHERENCE-AUDIT-2 §3.3）。
 *
 * `catch { return [] }` の握り潰しをやめ、英語 1 行の warn
 * （`[<label>] <message>`・PII なし・最大 200 字）を残してから既定値を返す。
 * これにより画面の `[]` 前提を壊さずに原因をログへ残せる。
 */

/**
 * 例外を捕捉したら英語 1 行の warn を出して fallback を返す。
 *
 * @template T
 * @param {string} label `<module>.<function>` 形式の呼び出し元識別子
 * @param {() => T} fn 実行する処理
 * @param {T} [fallback] 失敗時の既定値（既定 `[]`）
 * @returns {T} 成功時は `fn()` の戻り値、失敗時は `fallback`
 */
export function safeList(label, fn, fallback = []) {
  try {
    return fn()
  } catch (error) {
    const tag = String(label ?? 'safeList').replace(/\s+/g, ' ').trim().slice(0, 60) || 'safeList'
    const msg =
      String(error?.message ?? error ?? 'unknown error')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200) || 'unknown error'
    console.warn(`[${tag}] ${msg}`)
    return fallback
  }
}
