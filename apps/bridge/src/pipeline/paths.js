/**
 * A2B パイプライン最適化の**パス定数だけ**を持つ葉モジュール。
 *
 * ここは `apps/bridge/src/pipeline/` の一番下（何も import しない）。
 * リポジトリのルートを 1 箇所で定義し、`soul.js` / `profile.js` / `skills.js` が
 * そこから派生したパスを共有する（パス組み立てを散らかさない）。
 */

import path from 'node:path'

/** リポジトリのルート（このファイルは `apps/bridge/src/pipeline/` の下）。 */
export const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')

/** 同梱スキルの置き場（`hermes-pilot init` と同じ 3 つ）。 */
export const BUNDLED_SKILLS = ['quick-review', 'annotation', 'spec-architect']

/** 既定のスキル供給元。 */
export const DEFAULT_SKILLS_SRC = path.join(REPO_ROOT, 'skills')
