/**
 * A2B パイプラインの第 3 段 — 1 タップ環境最適化（SPEC §3.2 / D25③）。
 *
 * 「インストールしただけで自走する」ための**非破壊・冪等**な環境最適化だけを行う。
 * - `optimizeHermesSoul`  … `~/.hermes/SOUL.md` へ行動規範ブロックを 1 つだけ埋め込む
 * - `optimizeAgentSkills`  … スキル置き場へ `quick-review` / `annotation` / `spec-architect` を配置する
 *   （**ファイル配置だけ**。外部 AI CLI のサブプロセスは一切起動しない・SPEC V11 D50）
 * - `getOptimizeStatus` … 適用済みかどうかを**真偽値と件数だけ**で返す（内容は返さない）
 *
 * **このファイルはバレル**。実装は `apps/bridge/src/pipeline/` に分割してあり
 * （`paths` ← `soul` ← `profile` ← `skills` の DAG）、ここは**明示的な named re-export だけ**を置く
 * （`export *` は使わない＝公開契約を目で数えられるようにする）。公開している 23 件は分割前と同一。
 */

export { REPO_ROOT, BUNDLED_SKILLS, DEFAULT_SKILLS_SRC } from './pipeline/paths.js'

export {
  A2B_START,
  A2B_END,
  A2B_RULES,
  A2B_RULE_BLOCK,
  backupStamp,
  mergeSoul,
  nextBackupPath,
  optimizeHermesSoul,
} from './pipeline/soul.js'

export {
  DEFAULT_PILOT_PROFILE,
  sanitizePilotProfile,
  PROFILE_SOUL_CREATE_IF_MISSING,
  pilotProfileSkillsDir,
  listProfileNames,
  ensurePilotProfile,
  optimizeProfileSouls,
} from './pipeline/profile.js'

export {
  SKILL_TARGET_CANDIDATES,
  installSkill,
  optimizeAntigravitySkills,
  optimizeAgentSkills,
  getOptimizeStatus,
} from './pipeline/skills.js'
