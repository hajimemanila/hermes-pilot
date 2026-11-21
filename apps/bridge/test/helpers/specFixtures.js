/**
 * テスト用の SPEC フィクスチャ（`specs.test.js` / `specsMode.test.js` で共用）。
 */

export const SPEC = `# SPEC: Demo (SPEC-DEMO)

Intro paragraph.

## 6. Batches

### Batch P1: First batch

- **目的**: do the first thing
- **受入条件（Verify）**:
  - it works

### P2: Second batch

- **Objective**: do the second thing

#### Sub note

keep me

---

## Other section

### 1.1 Not a batch

text
`

export const MODE_SPEC = `# SPEC: Mode demo (SPEC-MODE)

### Batch M1: zero stop batch

- **Execution Mode**: \`[Mode: Zero-Stop]\`
- **目的**: 自律で完走する

### Batch M2: review batch

- **実行モード**: [Mode: Fast-Track Review]
- **目的**: 分岐したら聞く

### Batch M3: visual batch

- **Execution Mode**: [Mode: Visual Gate]
- **目的**: 見た目を検証する

### Batch M4: legacy batch

- **目的**: モード未宣言（過去 SPEC）

### 3.1 not a batch

- **Execution Mode**: [Mode: Zero-Stop]
`
