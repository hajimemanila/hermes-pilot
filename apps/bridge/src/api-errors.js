/**
 * ブリッジ API のエラー応答（SPEC §6.3）。
 *
 * 形式は `{ ok: false, code: 'NOT_WAITING', error: '<英語既定>', params: { ... } }`。
 * - `code`   … 機械可読。フロントは `t('err.' + code, params)` で自言語化する
 * - `error`  … 英語の既定メッセージ（辞書に無いコードでも読めるように）
 * - `params` … プレースホルダ値（辞書の `{var}` と同名）
 */

/** @typedef {'AUTH_REQUIRED'|'BAD_REQUEST'|'CONFLICT'|'CONFIRM_MISMATCH'|'INTERNAL'|'NOT_FOUND'|'NOT_WAITING'|'NO_SESSION'|'QUERY_REQUIRED'|'RATE_LIMITED'|'SESSION_REQUIRED'|'UNKNOWN_ENDPOINT'} ErrorCode */

/** 英語既定メッセージ（`apps/web/src/i18n/en.json` の `err.*` と同じ意味）。 */
export const ERROR_MESSAGES = {
  AUTH_REQUIRED: 'Sign-in required',
  BAD_REQUEST: 'The request could not be processed',
  CONFLICT: 'The state changed. Reload and try again',
  CONFIRM_MISMATCH: 'Confirmation text does not match',
  INTERNAL: 'Internal error',
  NOT_FOUND: 'Not found',
  NOT_WAITING: 'Task is not waiting for review',
  NO_SESSION: 'This task has no worker session',
  QUERY_REQUIRED: 'A query is required',
  RATE_LIMITED: 'Too many requests. Wait a moment and retry',
  SESSION_REQUIRED: 'session_id is required',
  UNKNOWN_ENDPOINT: 'Unknown endpoint',
}

/**
 * エラー本文を組み立てる。
 * @param {string} code エラーコード
 * @param {Record<string, unknown>} [params] プレースホルダ値
 * @returns {{ok: false, code: string, error: string, params: Record<string, unknown>}} 本文
 */
export function errorBody(code, params = {}) {
  const c = String(code || 'BAD_REQUEST')
  return {
    ok: false,
    code: c,
    error: ERROR_MESSAGES[c] ?? ERROR_MESSAGES.BAD_REQUEST,
    params: params && typeof params === 'object' ? params : {},
  }
}
