/**
 * ブリッジ API のエラー応答（SPEC §6.3）。
 *
 * 形式は `{ ok: false, code: 'NOT_WAITING', error: '<英語既定>', params: { ... } }`。
 * - `code`   … 機械可読。フロントは `t('err.' + code, params)` で自言語化する
 * - `error`  … 英語の既定メッセージ（辞書に無いコードでも読めるように）
 * - `params` … プレースホルダ値（辞書の `{var}` と同名）
 *
 * コード命名は `<DOMAIN>_<REASON>`（SPEC-i18n-resp B1）。既存 12 コードは温存。
 * ここに載るコードは**必ず 1 コード 1 英語既定文**を持ち、`err.<code>` の訳が
 * 辞書に無くても画面が英語で読める状態を保つ。
 */

/** @typedef {'AUTH_REQUIRED'|'BAD_REQUEST'|'CONFLICT'|'CONFIRM_MISMATCH'|'INTERNAL'|'NOT_FOUND'|'NOT_WAITING'|'NO_SESSION'|'QUERY_REQUIRED'|'RATE_LIMITED'|'SESSION_REQUIRED'|'UNKNOWN_ENDPOINT'} CoreErrorCode */

/** 英語既定メッセージ（`apps/web/src/i18n/en.json` の `err.*` と同じ意味）。 */
export const ERROR_MESSAGES = {
  // --- 基盤（既存 12。順序も既存のまま） ---
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

  // --- repo（repos.js / specs.js / review.js） ---
  REPO_PATH_REQUIRED: 'A repository path is required',
  REPO_PATH_INVALID: 'The repository path must be an absolute path',
  REPO_PATH_FORBIDDEN: 'The home directory cannot be added as a repository',
  REPO_NOT_GIT: 'Not a Git repository (.git is missing)',
  REPO_NOT_FOUND: 'The repository is not registered',
  REPO_ID_REQUIRED: 'A repository id is required',
  SCAN_DIRS_INVALID: 'scanDirs must be an array',
  SCAN_DIR_NOT_ABSOLUTE: 'Not an absolute path: {path}',
  SCAN_DIR_FORBIDDEN: 'Cannot scan directly under the home directory. Specify a subdirectory',
  SCAN_DIR_NOT_DIRECTORY: 'Not a directory: {path}',
  SCAN_DIR_MISSING: 'Does not exist: {path}',

  // --- board / task（repos.js / capture.js / specs.js / kanban.js / inbox.js） ---
  BOARD_NAME_INVALID: 'The board name contains characters that cannot be used',
  BOARD_NOT_FOUND: 'Board {board} was not found',
  TASK_ID_INVALID: 'The task id is invalid',
  TASK_ID_MISSING: 'Could not get the task id',
  TASK_NOT_FOUND: 'Task {id} was not found',
  TASK_STATE_LOCKED: 'The task is not in a state that allows this action (status: {status})',
  TASK_TITLE_REQUIRED: 'A title is required',
  TASK_TITLE_TOO_LONG: 'The title must be {max} characters or fewer',

  // --- comment / action / cli（inbox.js / ops.js / review.js） ---
  COMMENT_REQUIRED: 'A comment is required',
  COMMENT_FAILED: 'Could not post the comment',
  ACTION_INVALID: 'Unknown action: {action}',
  CLI_FAILED: 'The Hermes command failed',
  HERMES_REJECTED: 'Hermes rejected the operation (HTTP {status})',
  CREATE_FAILED: 'Creating the task failed',
  UNKNOWN_TARGET: 'Unknown target. Choose a registered repository',

  // --- spec（specs.js） ---
  SPEC_PATH_REQUIRED: 'A spec path is required',
  SPEC_PATH_NOT_RELATIVE: 'The spec path must be relative to the repository',
  SPEC_PATH_OUTSIDE: 'The spec path points outside the repository',
  SPEC_READ_FAILED: 'Could not read the spec: {path}',
  SPEC_BATCH_HEADING_MISSING: 'No batch heading (### Batch <ID>: <Title>) was found',
  SPEC_BATCH_NOT_FOUND: 'The selected batch is not in the spec',
  SPEC_NOT_MARKDOWN: 'Only Markdown (.md) specs can be previewed: {path}',

  // --- review / sheet / approval（review.js） ---
  NO_SHEET: 'This task has no sheet',
  SHEET_MISSING: 'Sheet not found',
  DATA_MISSING: 'sheet.json is missing',
  REVIEW_ALREADY_ANSWERED: 'The same answer is already saved',
  APPROVAL_ALREADY_RECORDED: 'Approval is already recorded',

  // --- image / annotation（review.js） ---
  NO_IMAGE: 'This task has no base image',
  IMAGE_MISSING: 'Base image not found',
  NO_COMPARE: 'No previous image to compare against',
  NO_ANNOTATION: 'No annotations yet',
  BAD_IMAGE: 'image must be data:image/(png|jpeg);base64,…',
  TOO_LARGE: 'The image is too large',
  THUMB_MISSING: 'Illustration not found',
  BAD_THUMB: 'The illustration path is invalid',
  BAD_PATH: 'The path is invalid',
  OUTSIDE: 'Only files under library / shots are served',
  BAD_EXT: 'Not an image file',

  // --- その他（chat-profile.js / hermes.js / architect.js） ---
  PROFILE_UNKNOWN: 'Unknown profile: {profile}',
  HERMES_TOKEN_MISSING: 'Could not get the Hermes session token (is the dashboard running?)',
  INVALID_RUNNER: 'Only the Hermes Native runner is supported',
  INVALID_SEED: 'A seed text is required',
  INVALID_BOARD: 'The board name is invalid',
  INVALID_REPO: 'The repository path is invalid',
  INVALID_JOB_ID: 'A job id is required',
  JOB_NOT_FOUND: 'The architect job was not found',
  WRITE_FAILED: 'Could not write the output',
}

/**
 * 英語既定文の無いコードで使う既定コード。
 * @type {string}
 */
export const FALLBACK_CODE = 'BAD_REQUEST'

/**
 * エラー本文を組み立てる。`fail()` の実体でもある（SPEC §6.3）。
 * @param {string} code エラーコード
 * @param {Record<string, unknown>} [params] プレースホルダ値
 * @returns {{ok: false, code: string, error: string, params: Record<string, unknown>}} 本文
 */
export function errorBody(code, params = {}) {
  const c = String(code || FALLBACK_CODE)
  return {
    ok: false,
    code: c,
    error: ERROR_MESSAGES[c] ?? ERROR_MESSAGES[FALLBACK_CODE],
    params: params && typeof params === 'object' ? params : {},
  }
}

/**
 * 失敗結果を返す（**throw しない**）。戻り値は `{ ok:false, code, error, params }`。
 *
 * 呼び出し側が `return` する規約（`{ok:false, ...}` を返すモジュール群）に合わせるための
 * 糖衣で、中身は `errorBody()` と同一。
 * @param {string} code エラーコード
 * @param {Record<string, unknown>} [params] プレースホルダ値
 * @returns {{ok: false, code: string, error: string, params: Record<string, unknown>}} 失敗結果
 */
export function fail(code, params = {}) {
  return errorBody(code, params)
}

/**
 * `throw` したい場所（inbox.js / ops.js など）用のエラー。
 *
 * `server.js` の `sendFailure` が `code` / `params` を読み、`statusCode` を HTTP ステータスに使う。
 * `message` は英語既定文（`detail` に載る文が日本語にならないように）。
 */
export class ApiError extends Error {
  /**
   * @param {string} code エラーコード
   * @param {Record<string, unknown>} [params] プレースホルダ値
   * @param {number} [statusCode] HTTP ステータス（既定 400）
   */
  constructor(code, params = {}, statusCode = 400) {
    const c = String(code || FALLBACK_CODE)
    super(ERROR_MESSAGES[c] ?? ERROR_MESSAGES[FALLBACK_CODE])
    this.name = 'ApiError'
    this.code = c
    this.params = params && typeof params === 'object' ? params : {}
    this.statusCode = statusCode
  }
}

/** コード表（テストと将来の網羅チェック用）。 */
export const ERROR_CODES = Object.keys(ERROR_MESSAGES)
