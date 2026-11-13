# SPEC: Hermes Pilot (`hermes-pilot`) — 公開プラグイン化・Quick Review / Annotation 同梱・多言語（i18n）対応仕様書

状態: **仕様確定（2026-11-13 インタビュー D1〜D10 合意済み）**
対象リポジトリ: `hermes-mobile-pwa` → 公開プラグイン名 **`Hermes Pilot` (`hermes-pilot`)**
想定実装ランナー: **Hermes Agent / DeepSeek V4.1 Flash**（カンバン自走 ＋ 実機リモートデバッグ検証）

---

## 1. コンセプトと目的

**Hermes Pilot (`hermes-pilot`)** は、自律走行する Hermes Agent をスマートフォンやタブレットから最小の認知負荷で操縦（Pilot）・意思決定（Human-in-the-Loop）・軌道修正するためのモバイル/タブレット PWA プラグインである。

1. **認知負荷を抑えた Human-in-the-Loop 意思決定ループ（Review = Quick Review + Annotation）**
   - エージェントが実装・調査の分岐点に達した際、長文チャットで質問する代わりに **Quick Review（選択肢＋推奨案＋補足シート）** または **Annotation（実機スクショへの赤入れ・矩形・矢印・メモ）** として起票し、人間がスマホ/タブレットから 1 タップで判断を返して自律ワーカーを再稼働させる。
   - **Quick Review スキル（`skills/quick-review/SKILL.md`）** と **Annotation スキル（`skills/annotation/SKILL.md`）** をプラグインに標準同梱し、インストール直後から意思決定ループが完結する。
2. **個人環境依存の完全排除（ゼロ外部プラグイン依存）**
   - 旧来の個人開発プラグイン（`git-ops` / `system-ops`）、個人サービス（`dsh-web` / `nanokvm`）、外部監視 cron（`mobile-akapen-watch`）、旧ディレクトリ（`~/Projects/akapen`）へのハードコード依存をすべて排除し、Hermes Agent 標準環境のみで 100% 動作する自己完結型アーキテクチャとする。
3. **英語デフォルト（`en`）＋日本語（`ja`）・多言語拡張対応（i18n）**
   - 公開プラグインとして英語（`en`）を既定フォールバック言語としつつ、日本語（`ja`）を初期同梱する。390px 幅のスマートフォンでも英語・日本語ともに文字溢れやレイアウト崩れを起こさないマイクロコピー規約を定める。
4. **スマホ 1 ペイン ＆ タブレット 2 ペイン分割 ＋ Dark / Light / System テーマ**
   - スマートフォン（`< 820px`）の片手操作 UI に加え、タブレット横画面（`>= 820px`）では左に一覧・右に Review シート／Annotation キャンバス／タスク詳細を並べる 2 ペイン分割表示と、Dark（既定）/ Light / System テーマ切替を提供する。

---

## 2. 決定表（インタビュー D1〜D10 合意事項）

実装時は以下の決定を厳守し、ワーカーの独断で仕様を変更しないこと。

| # | 論点 | 決定内容 | 根拠・背景 |
|---|---|---|---|
| **D1** | プロダクト名 / パッケージ名 | **`Hermes Pilot` (`hermes-pilot`)**<br>CLI 名: `hermes-pilot` / データ保存先: `~/.hermes/plugin-data/hermes-pilot/` | 自律エージェントをスマホ・タブレットから操縦・判断・軌道修正するコックピットとして直感的。 |
| **D2** | 旧「赤ペン（Akapen）」の名称・API・タグ統一 | UI 表記・内部タグ・API パスのすべてを **`Review`（タグ: `[review]`、API: `/api/review/...`）** に完全統一し、旧 `[akapen]` / `/api/akapen` は廃止・移行する。同梱スキル名は **`quick-review`** と **`annotation`**。 | 公開プラグインとして概念を「Review（Quick Review + Visual Annotation）」に統一し、内部コードの二重管理をなくす。 |
| **D3** | スキル同梱構造 | リポジトリ内に `skills/quick-review/SKILL.md` と `skills/annotation/SKILL.md`（およびテンプレート資産）を同梱し、`hermes-pilot init` で `~/.hermes/skills/` へ配置（またはシンボリックリンク）する。 | プラグイン単体で Hermes Agent がシート生成・スクショ注釈起票の契約を理解して自走できるようにする。 |
| **D4** | 外部プラグイン依存（`git-ops` / `system-ops`）の解消 | ・`/api/repos` は ①設定画面の登録パス＋**指定した親ディレクトリ（`~/Projects`, `~/projects` 等）配下の Git リポジトリ 1 階層自動スキャン**、②カンバン `default_workdir`、③セッション `cwd` 履歴を統合して返す。<br>・`/api/overview` は Hermes 標準 `/api/status` と `/api/system/stats` のみを使用する。 | `git-ops` や `system-ops` を入れていない一般ユーザーの環境でも、初回起動直後からリポジトリ選択と状態監視が動くようにする。 |
| **D5** | 多言語対応（i18n）方式 | **英語（`en`・既定フォールバック）＋日本語（`ja`）** の 2 言語を初期同梱。フラット JSON 辞書（`apps/web/src/i18n/en.json`, `ja.json`）＋設定画面の言語切替（`Auto` / `English` / `日本語`）で実装する。 | ランタイム依存を増やさず、キー欠落時の英語フォールバックと自動テスト検証を容易にする。 |
| **D6** | 旧 `~/Projects/akapen` 等のデータ移行方式 | 移行スクリプト（`scripts/migrate-to-hermes-pilot.mjs` / `npm run migrate:pilot`）で **`~/Projects/akapen/{sheets,shots,library}` および旧 `plugin-data/akapen`・`mobile-pwa` の全ファイルを `~/.hermes/plugin-data/hermes-pilot/` へ物理コピーして一本化**し、`kanban.db` の `[akapen]` も `[review]` に書き換え、ランタイムの旧パス参照を完全に廃止する。 | 既存資産を 100% 保護したうえで、ランタイムコードからレガシー分岐（`~/Projects/akapen` 等）を完全に除去する。 |
| **D7** | 完了通知・レポート監視の仕組み | ブリッジ本体（`apps/bridge/src/review-watcher.js`）に軽量ウォッチャー（`reviewWatcher`）を内蔵し、**外部 cron 設定なしで**完了フィード（`feed.jsonl`）とチャット完了報告（`chat-reports.jsonl`）を自動記録する。 | 公開プラグイン利用者に外部 cron（旧 `mobile-akapen-watch`）の手動設定を強いない。 |
| **D8** | モダン UI/UX・タブレット対応・テーマ切替 | スマホ 1 ペインに加え、**タブレット（`>= 820px`）の 2 ペイン分割表示**（左:一覧 / 右:Review シート・注釈キャンバス・タスク詳細）と、**Dark（既定）/ Light / System テーマ切替**を標準搭載する。 | スマホ・タブレット双方で認知負荷を抑え、明るい屋外やオフィス環境でも高い視認性を確保する。 |
| **D9** | 初回セットアップ・QR ペアリング・常駐起動 | CLI（`hermes-pilot init / start / qr / service`）を用意し、**ターミナルと設定画面に「ワンタップ認証 QR コード（Tailscale/LAN URL＋トークン）」を表示** ＆ macOS（`launchd`）/ Linux（`systemd --user`）サービス登録に対応する。 | スマホでの長いトークン文字列コピペを不要にし、カメラ読み取り 1 回でペアリングを完了させる。 |
| **D10** | Hermes Agent 自走用タスク分割 | 1 タスク＝1 セッションで完走できる **6 バッチ（T1〜T6）** に分割し、各バッチに `npm run verify` と実機リモートデバッグ条件（390×844 / 820×1180、EN/JA、Dark/Light）を明記する。 | DeepSeek V4.1 Flash ワーカーがコンテキスト溢れや手戻りを起こさず確実に自律完走できるようにする。 |

---

## 3. ディレクトリ構造とストレージ契約（D1 / D2 / D3 / D6）

### 3.1 リポジトリ構成（`hermes-pilot`）

```text
hermes-pilot/
├── package.json                  # name: "hermes-pilot", bin: { "hermes-pilot": "./bin/hermes-pilot.mjs" }
├── plugin.json                   # Hermes プラグインマニフェスト
├── bin/
│   └── hermes-pilot.mjs          # CLI (init / start / qr / service / migrate)
├── skills/
│   ├── quick-review/
│   │   ├── SKILL.md              # Quick Review 起票・シート生成・再開スキル定義（EN/JA 対応）
│   │   └── assets/
│   │       └── sheet-template.html
│   └── annotation/
│       └── SKILL.md              # Visual Annotation 起票・赤入れ JSON 読解・反映スキル定義
├── scripts/
│   ├── deploy.mjs                # 無停止ビルド＆dist入れ替え
│   ├── check-pwa.py              # PWA 34項目自動検査
│   └── migrate-to-hermes-pilot.mjs # 旧 akapen / mobile-pwa からの物理移行スクリプト
├── apps/
│   ├── bridge/
│   │   ├── src/
│   │   │   ├── server.js
│   │   │   ├── config.js         # データ先: ~/.hermes/plugin-data/hermes-pilot
│   │   │   ├── capabilities.js   # OS / CLI / サービス自動検出
│   │   │   ├── review.js         # 旧 akapen.js を置換（[review]・/api/review/*）
│   │   │   ├── review-watcher.js # 内蔵完了ウォッチャー（feed.jsonl / chat-reports.jsonl 生成）
│   │   │   ├── repos.js          # 設定＋親ディレクトリ1階層Gitスキャン＋board＋session統合
│   │   │   ├── qr.js             # ペアリングURL＆SVG/ASCII QRコード生成
│   │   │   └── ...
│   │   └── test/
│   └── web/
│       ├── src/
│       │   ├── i18n/
│       │   │   ├── index.js      # I18nProvider, useI18n, t(), setLang()
│       │   │   ├── en.json       # 英語辞書（デフォルトフォールバック）
│       │   │   └── ja.json       # 日本語辞書
│       │   ├── features/
│       │   │   ├── ReviewPane.jsx # 旧 AkapenPane.jsx を置換（2ペイン対応）
│       │   │   └── ...
│       │   └── ...
│       └── test/
└── docs/
    └── SPEC-PUBLIC-PLUGIN.md     # 本仕様書
```

### 3.2 ランタイムデータ構造（`~/.hermes/plugin-data/hermes-pilot/`）

すべての永続データは `~/.hermes/plugin-data/hermes-pilot/`（環境変数 `HP_DATA_DIR` で上書き可）配下に一本化する。旧 `~/.hermes/mobile-pwa`、`~/.hermes/plugin-data/akapen`、`~/Projects/akapen` はランタイムから参照しない。

```text
~/.hermes/plugin-data/hermes-pilot/
├── config.json                   # { lang, scanDirs: ["~/Projects", "~/projects"], servicePort: 4097 }
├── token                         # 認証トークン（0600）
├── audit.jsonl                   # 監査ログ
├── repos.json                    # 手動追加リポジトリ・非表示設定・ピン留め設定
├── snippets.json                 # ユーザー定義チャットスニペット
└── review/                       # Review（Quick Review + Annotation）ワークスペース
    ├── sheets/                   # Quick Review HTML シート (<label>-<round>.html, .answer.json)
    ├── shots/                    # キャプチャ・注釈画像 (<label>-<round>.png, .annotated.png, .annotation.json)
    ├── library/                  # 取り込み画像ライブラリ
    ├── feed.jsonl                # reviewWatcher が追記する完了・ブロック 1 行フィード
    ├── chat-reports.jsonl        # reviewWatcher が追記する会話宛て完了報告
    ├── task-chats.json           # taskId -> sessionId 紐づけマップ
    └── watcher-state.json        # reviewWatcher の処理済みイベント/状態チェックポイント
```

---

## 4. Review（Quick Review & Annotation）仕様と移行契約（D2 / D3 / D6 / D7）

### 4.1 タスク本文の機械可読行（`[review]` タグ）

カンバンタスク（board: `mobile` または対象リポジトリのボード）の本文先頭または任意の行に以下の機械可読タグを記載する。

- **Quick Review（設問シート）**:
  ```text
  [review] label=<slug> round=<n> mode=sheet sheet=sheets/<slug>-<n>.html target=<repo_path> chat=<session_id>
  ```
- **Annotation（画像赤入れ）**:
  ```text
  [review] label=<slug> round=<n> mode=annotation image=shots/<slug>-<n>.png target=<repo_path> chat=<session_id>
  ```

- **パーサ関数**: `apps/bridge/src/review.js` の `parseReviewLine(body)`
  - 正規表現: `/^\[review\]\s+(.+)$/m`
  - セキュリティ制約: `sheet` / `image` は `isSafeRel()`（`..`・絶対パス・NULL バイト禁止）を通過し、かつ `realpath` が `~/.hermes/plugin-data/hermes-pilot/review`（またはボードの `default_workdir`）配下であることを検証する。
- **回答フォーマット（`toReplyText` / `parseReplyText`）**:
  - 言語設定に応じた見出し（EN: `[Review Answer] <label>` / `Overall Note:`、JA: `【レビュー回答】<label>` / `全体へのコメント:`）を生成し、両方を受理できるよう `parseReplyText` を拡張する（既存の `【赤ペン回答】` / `全体への赤ペン:` も正規表現で受理して構造化する）。
- **注入ブリッジ（`injectReviewBridge`）**:
  - シート HTML 表示時に `window.__reviewSubmit`（互換エイリアス `window.__akapenSubmit` も定義して既存 HTML シート資産がそのまま動くようにする）を注入し、`POST /api/review/:id/answer` へ送信する。

### 4.2 Review API エンドポイント一覧（`/api/review/*`）

旧 `/api/akapen/*` を `/api/review/*` に全面統一する。

| メソッド & パス | 役割 |
|---|---|
| `GET /api/review` | Review タスク一覧（`waiting` / `active` / `done` 集計用、`items` 配列を返す） |
| `GET /api/review/targets` | 反映先として選択可能な Git リポジトリ一覧（`repos.list()` と連動） |
| `GET /api/review/library` | 注釈の下地に使える画像一覧（`review/library/**` と `review/shots/**`） |
| `GET /api/review/library/file?path=<rel>` | ライブラリ画像のバイナリ配信 |
| `POST /api/review/annotation/new` | アップロード画像またはライブラリ画像から新規 Annotation タスクを起票＆`blocked` 化 |
| `GET /api/review/feed?limit=20&since=0` | `review/feed.jsonl` から最新フィードを取得 |
| `GET /api/review/chat-report?session_id=<id>` | 指定セッション宛ての Review 完了報告を取得 |
| `GET /api/review/chat-reports?limit=200&since=0` | 全セッション分の Review 完了報告（未読ドット計算用） |
| `GET /api/review/:id/sheet` | Quick Review シート HTML（`injectReviewBridge` 注入済み）を配信 |
| `GET /api/review/:id/data` | シートから抽出した設問構造（ネイティブ UI 描画用）と既存回答 JSON を返す |
| `POST /api/review/:id/answer` | Quick Review 回答を保存し、カンバン `comment` + `unblock` を実行（SHA-256 冪等） |
| `POST /api/review/:id/reopen` | 完了/進行中タスクを再度 `blocked` に戻して再回答可能にする |
| `GET /api/review/:id/session` | タスクの実行ワーカー `session_id` を解決する |
| `GET /api/review/:id/worker?limit=20` | ワーカーの最新ツール実行・思考ログを `state.db` から返す |
| `GET /api/review/:id/image?annotated=0\|1` | Annotation の下地画像または赤入れ合成済み画像を返す |
| `GET /api/review/:id/annotation` | 保存済みの `.annotation.json` を返す |
| `POST /api/review/:id/annotation` | 赤入れ PNG/JPEG（data URL）とストローク座標・メモを保存し、`comment` + `unblock` |
| `GET /api/review/:id/thumb?src=<rel>` | シート内の相対画像サムネイルを安全に配信 |

### 4.3 ブリッジ内蔵ウォッチャー（`apps/bridge/src/review-watcher.js`）（D7）

外部 cron（旧 `mobile-akapen-watch`）を不要にするため、ブリッジプロセス内に `createReviewWatcher(cfg, { review, intervalMs: 10_000 })` を実装する。

1. **ポーリング対象**:
   - カンバン DB（`~/.hermes/kanban/boards/*/kanban.db` または `review` 対象ボード）の `[review]` タスクを 10 秒間隔で読み取る（Read-Only SQLite）。
2. **状態遷移の検知と冪等記録（`review/watcher-state.json`）**:
   - `watcher-state.json` に `{ tasks: { [taskId]: { status, updatedAt, reportedDoneAt, reportedBlockedAt } } }` を保持する。
   - **初回起動時（ベースライン確立）**: `watcher-state.json` が存在しない初回起動時は、既存の `done` / `blocked` タスクを現在の状態として記録するのみとし、過去タスクの大量通知スパムを防ぐ。
   - **`done` への遷移検知時**:
     - `review/feed.jsonl` に `{"at":"<ISO8601>","task_id":"<id>","kind":"done","label":"<label>","text":"✅ <title> (<id>)"}` を追記する。
     - タスク本文の `chat=<session_id>` または `task-chats.json` に紐づく `sessionId` がある場合、`review/chat-reports.jsonl` に `{"at":"<ISO8601>","session_id":"<sessionId>","task_id":"<id>","label":"<label>","text":"<result 1行要約またはタイトル>"}` を追記する。
   - **`running` → `blocked`（再質問・第 2 ラウンド）への遷移検知時**:
     - `review/feed.jsonl` に `{"at":"<ISO8601>","task_id":"<id>","kind":"blocked","label":"<label>","text":"⏸ <title> (<id>)"}` を追記する。
3. **アトミック追記**:
   - JSONL 追記は 1 行完結の `fs.appendFileSync`（改行終端保証）で行い、`watcher-state.json` は一時ファイル `.tmp` からの `fs.renameSync` でアトミックに更新する。

### 4.4 旧環境からの完全移行スクリプト（`scripts/migrate-to-hermes-pilot.mjs`）（D6）

`npm run migrate:pilot`（および `hermes-pilot init` 実行時）で動作する冪等な移行スクリプトを提供する。

1. **ファイル物理コピー（タイムスタンプ `mtime` 保持）**:
   - `~/Projects/akapen/sheets/*` → `~/.hermes/plugin-data/hermes-pilot/review/sheets/`
   - `~/Projects/akapen/shots/*` → `~/.hermes/plugin-data/hermes-pilot/review/shots/`
   - `~/Projects/akapen/library/*` → `~/.hermes/plugin-data/hermes-pilot/review/library/`
   - `~/.hermes/plugin-data/akapen/{feed.jsonl,chat-reports.jsonl,task-chats.json}` → `~/.hermes/plugin-data/hermes-pilot/review/`
   - `~/.hermes/mobile-pwa/{token,snippets.json,audit.jsonl}` → `~/.hermes/plugin-data/hermes-pilot/`
   - コピー時は `fs.cpSync(src, dest, { recursive: true, force: false, preserveTimestamps: true })` を用い、**画像の `mtime`（撮影日時順ソートに使用）を必ず維持する**。
2. **カンバン DB（`kanban.db`）のタグ・workdir 更新**:
   - 更新前に `kanban.db.bak-<timestamp>` バックアップを作成する。
   - `tasks` テーブルの `body` に含まれる先頭タグ `[akapen]` を `[review]` に置換（`UPDATE tasks SET body = replace(body, '[akapen]', '[review]') WHERE body LIKE '%[akapen]%'`）。
   - `boards/mobile/board.json` の `default_workdir` が `~/Projects/akapen` を指している場合、`~/.hermes/plugin-data/hermes-pilot/review` に更新する。
3. **移行レポート出力**:
   - コピーしたシート数・画像数・更新したタスク件数をコンソールに表示する。

### 4.5 同梱スキルの仕様（`skills/quick-review/SKILL.md`, `skills/annotation/SKILL.md`）（D3）

- **`skills/quick-review/SKILL.md`**:
  - エージェントが判断を仰ぐ際、`~/.hermes/plugin-data/hermes-pilot/review/sheets/<label>-<round>.html` に設問シート（`<section class="q" data-q="q1"><h3>Q1. ...</h3><label data-opt="A"><input type="radio" name="q1" value="A">...</label></section>`）を生成し、`[review] label=<label> round=<round> mode=sheet sheet=sheets/<label>-<round>.html target=<repo> chat=<session_id>` 付きでカンバンタスクを `blocked`（`--kind needs_input`）にする手順とテンプレートを定義。
- **`skills/annotation/SKILL.md`**:
  - スクリーンショットや UI キャプチャ（`shots/<label>-<round>.png`）に対する赤入れタスクの起票方法、および人間が送信した `.annotated.png`（視覚確認用）と `.annotation.json`（`marks` 座標配列＋`note` テキスト）の両方を読み取って UI/コードを修正する手順を定義。

---

## 5. 外部依存の排除と Capability 検出仕様（D4）

### 5.1 リポジトリ自動検出・管理（`apps/bridge/src/repos.js`）

`plugins/git-ops/config/repos.json` への依存を廃止し、以下の 4 ソースを統合（重複パスは `normalizePath` でマージ）してリポジトリ一覧を構築する。

1. **ユーザー設定 ＆ 親ディレクトリ 1 階層自動スキャン（`~/.hermes/plugin-data/hermes-pilot/repos.json`）**:
   - 設定ファイル構造:
     ```json
     {
       "scanDirs": ["~/Projects", "~/projects"],
       "pinned": ["hermes-pilot"],
       "hidden": [],
       "custom": [
         { "id": "my-repo", "label": "my-repo", "path": "/Users/alice/work/my-repo" }
       ]
     }
     ```
   - `scanDirs` の各ディレクトリ直下（1 階層のみ、深さ制限 `depth = 1`）を走査し、`<dir>/<child>/.git` が存在するディレクトリを自動で候補に加える（キャッシュ TTL: 30 秒、`POST /api/repos/scan` で即時再スキャン可能）。
2. **カンバンボードの `default_workdir`**:
   - `kanban.boards()` から取得した各ボードの `workdir` に `.git` が存在すれば候補に加える。
3. **直近セッションの `cwd`**:
   - `state.db` の `sessions` テーブルから直近アクティブな `cwd`（`.git` があるもの）を抽出して候補に加える。
4. **管理 API（設定画面から操作可能）**:
   - `GET /api/repos`: 統合済みリポジトリ一覧＋現在の `scanDirs` を返す。
   - `POST /api/repos`: `{ path, label? }` で個別リポジトリ追加、または `{ scanDirs }` で自動スキャン親ディレクトリを更新（実在かつ `.git` 確認、ホームディレクトリ直下 `~` は拒否）。
   - `DELETE /api/repos/:id`: `custom` からの削除、または自動検出リポジトリの `hidden` リストへの追加。
   - `POST /api/repos/board`: 選択したリポジトリに対応するカンバンボードを作成（既存どおり）。

### 5.2 システム状態監視（`apps/bridge/src/ops.js`）

- `/api/plugins/system-ops/blocked-processes` の呼び出しを削除する。
- `GET /api/overview` は Hermes 標準の `/api/status` と `/api/system/stats`、およびブリッジ自身のメトリクス（稼働状態、カンバン集計、Review 待ち件数）のみを返す。

### 5.3 Capability 自動検出と端末スニペット（`apps/bridge/src/capabilities.js`, `term-snippets.js`）

- `GET /api/capabilities` を新設し、起動時に以下を検出して返す:
  ```json
  {
    "os": "darwin",
    "serviceManager": "launchd",
    "hasTailscale": true,
    "hasHermesCli": true,
    "pilotServiceUnit": "ai.hermes.pilot"
  }
  ```
- `apps/bridge/src/term-snippets.js` から個人環境の `ai.hermes.dsh-web`（8787）を削除する。
- サービス再起動・状態確認スニペットは `capabilities.serviceManager` に応じて分岐する:
  - `darwin` (`launchd`): `launchctl kickstart -k gui/$(id -u)/ai.hermes.pilot`
  - `linux` (`systemd`): `systemctl --user restart hermes-pilot.service`
- `ChatPane.jsx`（L1204, L1860）の `'nanokvm'` ハードコードを削除し、プロファイル並び順は `(1) DEFAULT_PROFILE, (2) 'default', (3) 直近利用順, (4) 名前順` とし、説明文も汎用化する。

---

## 6. 多言語対応（i18n）仕様（英語既定＋日本語同梱）（D5）

### 6.1 言語解決の優先順位

1. `localStorage.getItem('hm.lang')` が `'en'` または `'ja'` の場合はその言語を使用。
2. `'auto'` または未設定の場合は `navigator.languages` / `navigator.language` を検査し、`ja` で始まれば `'ja'`、それ以外はすべて **`'en'`（英語）** にフォールバックする。
3. 選択された言語に応じて `<html lang="en|ja">` を動的に更新し、API リクエスト時に `Accept-Language: en|ja` ヘッダーを付与する。

### 6.2 辞書構造と翻訳ヘルパー（`apps/web/src/i18n/`）

- `apps/web/src/i18n/en.json`（基準辞書・全キー必須）
- `apps/web/src/i18n/ja.json`（日本語辞書・`en.json` と完全同一のキー集合）
- `t(key, vars)` 関数:
  - `vars` によるプレースホルダ展開（例: `t('chat.toolsRan', { count: 3 })` → EN: `"🔧 Ran 3 tools"`, JA: `"🔧 ツール 3 件を実行"`）。
  - 指定言語にキーが存在しない場合は `en.json` の値を返し、それも無ければキー文字列自体を返す（画面クラッシュ防止）。

#### 主要キー名前空間と英語/日本語対照表（抜粋）

| キー | English (`en.json` - Default) | 日本語 (`ja.json`) | 390px 幅の制約 |
|---|---|---|---|
| `nav.tasks` | `Tasks` | `タスク` | 最大 8 文字 |
| `nav.review` | `Review` | `レビュー` | 最大 8 文字 |
| `nav.chat` | `Chat` | `チャット` | 最大 8 文字 |
| `nav.term` | `Term` | `端末` | 最大 8 文字 |
| `nav.settings` | `Settings` | `設定` | 最大 8 文字 |
| `status.gw` | `GW` | `GW` | チップ省略表記 |
| `status.workers` | `Workers {n}` | `稼働 {n}` | 10 文字以内 |
| `status.reviewWaiting` | `Review {n}` | `判断待ち {n}` | 12 文字以内 |
| `review.tab.waiting` | `Waiting` | `判断待ち` | チップ 1 行収まり |
| `review.tab.active` | `Active` | `進行中` | チップ 1 行収まり |
| `review.tab.done` | `Done` | `完了` | チップ 1 行収まり |
| `review.newAnnotation` | `+ Annotate` | `＋ 注釈` | ボタン 1 行 |
| `review.submitAnswer` | `Submit Review` | `回答を送信` | ボタン 1 行 |
| `chat.working` | `Working…` | `実行中…` | シマー表示 |
| `chat.toolsRan` | `🔧 Ran {count} tools` | `🔧 ツール {count} 件を実行` | 折りたたみ見出し |
| `chat.reviewWaitingTitle` | `🖊 Waiting for Review` | `🖊 レビュー判断待ち` | ライブカード見出し |
| `chat.openInReview` | `Open Review ↗` | `レビューで回答 ↗` | ライブカードボタン |
| `chat.jumpBottom` | `↓ Latest` | `↓ 最新へ` | フローティングボタン |
| `chat.jumpBottomWorking` | `↓ Working · Latest` | `↓ Working・最新へ` | フローティングボタン |
| `settings.language` | `Language` | `表示言語` | 設定セクション |
| `settings.theme` | `Theme` | `テーマ` | `Dark` / `Light` / `System` |

### 6.3 ブリッジエラーコードと組み込みスニペットの i18n

- ブリッジ API のエラー応答は `{ ok: false, code: 'NOT_WAITING', error: 'Task is not waiting for review', params: { status } }` のように機械可読 `code` と英語既定メッセージを返し、フロントエンドは `t('err.' + res.code, res.params)` でローカライズ表示する。
- `apps/bridge/src/snippets.js` および `term-snippets.js` は `listSnippets(custom, lang = 'en')` として `en` / `ja` 両方のラベル・プロンプト文面を持ち、`GET /api/snippets?lang=en|ja`（または `Accept-Language`）に応じた言語で返す。

---

## 7. モダン UI/UX・タブレット 2 ペイン分割・テーマ仕様（D8）

### 7.1 カラートークンと Dark / Light / System テーマ

- `localStorage.getItem('hm.theme')`（`'dark'` | `'light'` | `'system'`、既定は `'dark'`）。
- `<html data-theme="dark|light">` 属性で切り替え、`styles.css` の `:root`（Dark）と `html[data-theme="light"]`（Light）で CSS 変数を定義する。

| トークン | Dark（既定） | Light | 用途 |
|---|---|---|---|
| `--bg` | `#051319` | `#f4f7f8` | アプリ全体背景 |
| `--bg-elev` | `#0a2029` | `#ffffff` | ヘッダー・ナビ・シート背景 |
| `--surface` | `#0e2a35` | `#eef3f5` | カード・気泡・入力欄背景 |
| `--text` | `#e8f4f6` | `#0f242a` | 本文テキスト（コントラスト比 7:1 以上） |
| `--muted` | `#84a5ad` | `#526d75` | 補助テキスト（コントラスト比 4.5:1 以上） |
| `--line` | `rgba(120, 190, 205, 0.16)` | `rgba(15, 45, 55, 0.12)` | 境界線 |
| `--accent` | `#2dd4bf` | `#0d9488` | アクセント（ティール） |
| `--warn` | `#f59e0b` | `#d97706` | Review 判断待ち・警告 |
| `--bad` | `#f87171` | `#dc2626` | エラー・ブロック |

### 7.2 タブレット 2 ペイン分割レイアウト（`@media (min-width: 820px)`）

画面幅 `820px` 以上（iPad / Android タブレット横・縦、デスクトップウィンドウ）では、シートのフルスクリーン被せではなく **Master-Detail 2 ペイン分割** で表示し、コンテキストスイッチの認知負荷を最小化する。

1. **Review タブ（`ReviewPane.jsx`）**:
   - **左ペイン（幅 `340px〜380px`、固定スクロール）**: `Waiting / Active / Done` フィルタチップ、フィード、タスク一覧カード。
   - **右ペイン（`flex: 1`、独立スクロール）**: 選択中の Quick Review シート（ネイティブ設問カードまたは HTML シート）または Annotation エディタを常時展開。左の一覧から別タスクをタップすると即座に右ペインが切り替わる。
2. **Tasks タブ（`TasksPane.jsx`）**:
   - **左ペイン（幅 `360px`）**: ボード切替・ステータスフィルタ・タスク一覧。
   - **右ペイン（`flex: 1`）**: 選択タスクの詳細・イベント履歴・Git Diff・操作ボタンを常時表示。
3. **Chat タブ（`ChatPane.jsx`）**:
   - `>= 1024px` では左に会話履歴サイドバー（幅 `280px`）を常設可能とし、`820px〜1023px` では中央最大幅 `840px` で読みやすいタイムライン幅を保つ。

---

## 8. オンボーディング・QR ペアリング・CLI 仕様（D9）

### 8.1 CLI コマンド体系（`bin/hermes-pilot.mjs`）

- `npx hermes-pilot init` / `hermes-pilot init`:
  1. `~/.hermes/plugin-data/hermes-pilot/` ディレクトリ群を作成。
  2. トークン未生成なら暗号論的乱数（256-bit hex）で `token`（権限 `0600`）を生成。
  3. 旧環境（`~/Projects/akapen` または `~/.hermes/mobile-pwa`）が存在する場合は自動でマイグレーション（4.4 節）を実行。
  4. `skills/quick-review` と `skills/annotation` を `~/.hermes/skills/` にインストール。
  5. Tailscale ホスト名（`tailscale status --json` の `Self.DNSName`）または LAN IP を自動検出し、ペアリング URL と ASCII QR コードをターミナルに表示。
- `hermes-pilot start [--port 4097] [--host 127.0.0.1]`:
  - 本番ビルド（`apps/web/dist`）の存在を確認（無ければ自動ビルド）し、ブリッジを起動して QR コードを表示。
- `hermes-pilot qr`:
  - 現在のペアリング URL（`https://<host>:<port>/?pair=<one-time-or-bearer-token>`）とターミナル QR コードを表示。
- `hermes-pilot service install | uninstall | restart | status`:
  - **macOS (`darwin`)**: `~/Library/LaunchAgents/ai.hermes.pilot.plist` を生成・`launchctl bootstrap` / `kickstart`。
  - **Linux (`linux`)**: `~/.config/systemd/user/hermes-pilot.service` を生成・`systemctl --user enable --now hermes-pilot.service`。

### 8.2 ワンタップ QR ペアリング導線

- **ペアリング URL 処理**:
  - スマホで QR コード（`https://<host>/?token=<token>` または `#token=<token>`）を読み取って開くと、フロントエンド起動時に自動で `POST /api/auth/login` を実行して `HttpOnly` セッション Cookie を確立し、`history.replaceState` で URL からトークン文字列を即座に消去する（ブラウザ履歴にトークンを残さない）。
- **設定画面の「Show Pairing QR」シート**:
  - 認証済みセッションから `GET /api/auth/pairing` を呼ぶと、検出された接続先候補（Tailscale HTTPS URL / LAN URL）と QR コード SVG を返し、2 台目のスマホやタブレットをその場でペアリングできる。

---

## 9. 既知の罠と実装時の厳守ルール（Pitfalls）

Hermes Agent（DeepSeek V4.1 Flash）が実装時に必ず守るべきガードレール：

1. **実機スクショ撮影・リモートデバッグ前の `npm run build` / `npm run deploy` 必須**:
   - ブリッジ（`:4097`）は `apps/web/dist` を配信する。CSS や JSX を変更した後にビルドせずスクリーンショットを撮ると古い画面が写るため、**画面検証の前に必ず `npm run deploy` を実行すること**。
2. **`Ui.jsx` の `Sheet` 履歴スタック（`activeSheets`）を壊さない**:
   - シートから別シートを開く遷移（「会話」ドロワー →「新しい会話」シート等）の競合を防ぐため、`Ui.jsx` のモジュールレベル `activeSheets` と `setTimeout(..., 0)` による遅延 `history.back()` の実装を維持すること。
3. **390px 幅での英語テキスト溢れ防止**:
   - 英語は日本語より文字幅が 1.3〜1.6 倍長くなる。ステータスバー（`.strip`）、ボトムナビ（`.nav`）、フィルタチップ（`.chips`）では必ず `text-overflow: ellipsis; white-space: nowrap; min-width: 0;` を効かせ、390×844 ビューポートで `document.documentElement.scrollWidth <= 390` であることを自動検証すること。
4. **チャットの他プロファイル送信フォールバック**:
   - `ChatPane.jsx` の `session not found` 再作成経路では必ず現在の `profile` を渡し、黙って `default` プロファイルにセッションが作られないようにすること（`SPEC-PROFILE-CHAT.md` 3.3 節の原則維持）。
5. **画像コピー時の `mtime` 保持**:
   - マイグレーションやライブラリ取り込みで画像をコピーする際は、`mtime` が変わらないよう `preserveTimestamps: true` を使うこと（一覧の撮影日時順ソートが壊れるのを防ぐ）。

---

## 10. Hermes Agent 自走用カンバンタスク分割（Batch T1〜T6）（D10）

以下の **6 バッチ（T1 → T2 → T3 → T4 → T5 → T6）** を順番にカンバンで起票・実行する。各バッチは 1 セッションで完結し、完了時に必ず受入条件（Verify）を満たすこと。

---

### Batch T1: 外部プラグイン依存の排除・Git リポジトリ自動スキャン・Capability 検出

- **目的**: `git-ops` / `system-ops` / `nanokvm` / `dsh-web` への個人依存を完全に除去し、どの Hermes 環境でもリポジトリ選択とシステム監視が単体動作するようにする。
- **変更・新規ファイル**:
  - 新規: `apps/bridge/src/capabilities.js`（OS、`launchd`/`systemd`、`tailscale`、`hermes` CLI の検出）
  - 変更: `apps/bridge/src/repos.js`（`repos.json` 設定＋`scanDirs` 親ディレクトリ 1 階層 `.git` 自動スキャン＋カンバン `default_workdir`＋`state.db` 直近 `cwd` の統合、`POST /api/repos`, `DELETE /api/repos/:id` 追加）
  - 変更: `apps/bridge/src/ops.js`（`/api/plugins/system-ops/blocked-processes` 呼び出しの削除）
  - 変更: `apps/bridge/src/term-snippets.js`（`dsh-web` 削除、`capabilities.serviceManager` に応じた `launchctl` / `systemctl --user` 分岐）
  - 変更: `apps/bridge/src/server.js`（`GET /api/capabilities`, `POST /api/repos`, `DELETE /api/repos/:id` ルート追加）
  - 変更: `apps/web/src/features/ChatPane.jsx`（`nanokvm` ハードコード削除、動的プロファイル並び順）
  - 変更: `apps/web/src/features/SettingsPane.jsx`（スキャン対象ディレクトリ `scanDirs` とリポジトリの追加・非表示 UI）
  - テスト: `apps/bridge/test/repos.test.js`, `apps/bridge/test/capabilities.test.js`
- **受入条件（Verify）**:
  - `rg "system-ops|git-ops|dsh-web|nanokvm" apps/bridge/src apps/web/src` が **0 件** であること（テストフィクスチャを除く）。
  - 一時ディレクトリにダミー `.git` リポジトリを 2 個作成し、`scanDirs` 1 階層スキャンで自動検出されるユニットテストが通ること。
  - `npm run verify` が全件パスすること。

---

### Batch T2: `Review ([review])` 完全統一・内蔵ウォッチャー・スキル同梱・データ移行スクリプト

- **目的**: 旧 `akapen` を `review` に完全統一し、スキル同梱・内蔵ウォッチャー（`reviewWatcher`）・物理移行スクリプト（`migrate-to-hermes-pilot.mjs`）を実装する。
- **変更・新規ファイル**:
  - 新規: `apps/bridge/src/review.js`（旧 `akapen.js` を移行・改名。`[review]` タグ、`/api/review/*`、保存先 `~/.hermes/plugin-data/hermes-pilot/review/`）
  - 新規: `apps/bridge/src/review-watcher.js`（10 秒間隔で `kanban.db` を監視し、`done`/`blocked` 遷移時に `feed.jsonl` と `chat-reports.jsonl` へ冪等追記）
  - 新規: `scripts/migrate-to-hermes-pilot.mjs`（`~/Projects/akapen`・`plugin-data/akapen`・`mobile-pwa` から `~/.hermes/plugin-data/hermes-pilot/` への物理コピー＋`kanban.db` の `[akapen]` → `[review]` 置換）
  - 新規: `skills/quick-review/SKILL.md`, `skills/quick-review/assets/sheet-template.html`, `skills/annotation/SKILL.md`
  - 変更: `apps/bridge/src/config.js`, `apps/bridge/src/server.js`（`/api/review/*` ルート化、`reviewWatcher` 起動連動）
  - 変更: `apps/web/src/features/ReviewPane.jsx`（旧 `AkapenPane.jsx` を改名・エンドポイント `/api/review/*` 化）、`App.jsx`, `ChatPane.jsx`, `CaptureSheet.jsx`, `AnnotationEditor.jsx`, `lib/reviewView.js`（旧 `akapenView.js`）
  - テスト: `apps/bridge/test/review.test.js`, `apps/bridge/test/reviewWatcher.test.js`, `apps/bridge/test/migrate.test.js`
- **受入条件（Verify）**:
  - `npm run migrate:pilot` を実行すると既存の `~/Projects/akapen` のシート・画像・`kanban.db` タグが欠損なく `~/.hermes/plugin-data/hermes-pilot/` へ移行されること。
  - 外部 cron 無しで、テスト用 `[review]` タスクを `done` に遷移させた際に `reviewWatcher` が `feed.jsonl` と `chat-reports.jsonl` に 1 行追記することをテストで検証。
  - `npm run verify` が全件パスすること。

---

### Batch T3: i18n 基盤構築（`en.json` / `ja.json`）＆ ブリッジ API・スニペットの多言語化

- **目的**: 英語（`en`・既定フォールバック）と日本語（`ja`）の辞書基盤を構築し、ブリッジのエラーコードと組み込みスニペットを多言語対応にする。
- **変更・新規ファイル**:
  - 新規: `apps/web/src/i18n/index.js`（`I18nProvider`, `useI18n`, `t()`, 言語自動判定、`localStorage['hm.lang']` 永続化、`<html lang>` 同期）
  - 新規: `apps/web/src/i18n/en.json`, `apps/web/src/i18n/ja.json`（全画面・全エラーコードの完全対訳辞書）
  - 変更: `apps/web/src/lib/format.js`, `apps/web/src/components/Ui.jsx`（`relTime`, `fmtBytes`, 日時フォーマットの `Intl` 言語連動）
  - 変更: `apps/bridge/src/snippets.js`, `apps/bridge/src/term-snippets.js`（`lang = 'en' | 'ja'` 引数対応）
  - 変更: `apps/bridge/src/server.js`（`Accept-Language` または `?lang=` クエリの受け渡し、エラーレスポンスへの `code` 付与）
  - テスト: `apps/web/test/i18n.test.js`（`en.json` と `ja.json` のキー完全一致検査、プレースホルダ `{var}` の一致検査、フォールバック動作検査）
- **受入条件（Verify）**:
  - `en.json` と `ja.json` のキー差分が 0 件、プレースホルダ変数名の不一致が 0 件であることを `i18n.test.js` で自動検証。
  - `npm run verify` が全件パスすること。

---

### Batch T4: Web UI 全コンポーネントの i18n 適用（英語デフォルト化＋日本語完全維持）

- **目的**: 全 12 画面・コンポーネントのハードコード日本語文字列を `t('...')` に置き換え、設定画面から `Auto / English / 日本語` を即時切り替えられるようにする。
- **変更ファイル**:
  - `apps/web/src/App.jsx`
  - `apps/web/src/features/ChatPane.jsx`
  - `apps/web/src/features/ReviewPane.jsx`
  - `apps/web/src/features/AnnotationEditor.jsx`
  - `apps/web/src/features/TasksPane.jsx`
  - `apps/web/src/features/TermPane.jsx`
  - `apps/web/src/features/SettingsPane.jsx`（言語セレクタ `Auto / English / 日本語` 追加）
  - `apps/web/src/features/InboxSheet.jsx`, `LiveSheet.jsx`, `SearchSheet.jsx`, `UsageSheet.jsx`, `CaptureSheet.jsx`
  - `apps/web/src/components/Ui.jsx`, `CloseActions.jsx`
  - `apps/web/src/lib/pwaDiagnose.js`, `reviewView.js`
  - テスト: `apps/web/test/noHardcodedJapanese.test.js`（JSX/JS 内の未翻訳日本語リテラル残存チェック、コメント除く）
- **受入条件（Verify）**:
  - `apps/web/src/` 内のコード（コメントを除く）にハードコードされた日本語 UI 文字列が残っていないことをテストで自動検査。
  - 実機リモートデバッグ（`390×844`）で `hm.lang = 'en'` と `hm.lang = 'ja'` の両方を撮影し、下部ナビ・ステータスバー・各タブに文字切れや横スクロール（`scrollWidth > 390`）が無いことを確認。

---

### Batch T5: モダン UI/UX 刷新（Dark / Light / System テーマ ＆ タブレット `>= 820px` 2 ペイン分割）

- **目的**: Dark / Light / System テーマ切替と、タブレット（`>= 820px`）での Master-Detail 2 ペイン分割レイアウト（Review タブ・Tasks タブ）を実装する。
- **変更ファイル**:
  - `apps/web/src/styles.css`（Light テーマ CSS 変数 `html[data-theme="light"]`、タブレット `@media (min-width: 820px)` 2 ペイングリッド `.split-layout`, `.split-master`, `.split-detail`）
  - `apps/web/src/App.jsx`（テーマ初期化・`matchMedia('(prefers-color-scheme: dark)')` 監視・`<meta name="theme-color">` 動的更新）
  - `apps/web/src/features/ReviewPane.jsx`（`>= 820px` 時に左:一覧、右:選択中シート/注釈エディタを並べて表示）
  - `apps/web/src/features/TasksPane.jsx`（`>= 820px` 時に左:タスク一覧、右:詳細/Diff を並べて表示）
  - `apps/web/src/features/SettingsPane.jsx`（テーマ切替 UI: `Dark` / `Light` / `System`）
- **受入条件（Verify）**:
  - `npm run verify` が全件パスすること。
  - リモートデバッグで ①スマホ `390×844`（Dark / Light）と ②タブレット `820×1180` および `1180×820`（Dark / Light）のスクリーンショットを撮影し、2 ペイン分割表示とコントラストを視覚検証。

---

### Batch T6: `hermes-pilot` CLI・ワンタップ QR ペアリング・サービス管理・英語/日本語 README

- **目的**: 公開プラグインとして `npx hermes-pilot init / start / qr / service` で導入・QR ペアリング・常駐化ができるようにし、英語 `README.md` と日本語 `README.ja.md` を整備する。
- **変更・新規ファイル**:
  - 新規: `plugin.json`（Hermes プラグインマニフェスト）
  - 新規: `bin/hermes-pilot.mjs`（`init`, `start`, `qr`, `service install|uninstall|restart|status`, `migrate` サブコマンド）
  - 新規: `apps/bridge/src/qr.js`（外部依存ゼロまたは軽量エンコーダによる QR SVG / ターミナル UTF-8 ブロック文字列生成、Tailscale / LAN URL 検出）
  - 変更: `apps/bridge/src/server.js`（`GET /api/auth/pairing` 追加）
  - 変更: `apps/web/src/App.jsx`（`?token=` / `#token=` クエリからの自動ログイン＆URL クリア）
  - 変更: `apps/web/src/features/SettingsPane.jsx`（「Show Pairing QR / ペアリング QR を表示」モーダル追加）
  - 変更: `package.json`（`name: "hermes-pilot"`, `bin` フィールド、`migrate:pilot` スクリプト追加）
  - 新規・更新: `README.md`（英語版・メイン）、`README.ja.md`（日本語版）
  - テスト: `apps/bridge/test/qr.test.js`, `apps/bridge/test/cli.test.js`
- **受入条件（Verify）**:
  - `node bin/hermes-pilot.mjs --help`、`node bin/hermes-pilot.mjs qr`、`node bin/hermes-pilot.mjs service status` が正常動作すること。
  - `?token=<valid_token>` 付き URL でアクセスした際に自動でセッション Cookie が発行され、アドレスバーから `token` パラメータが消去されることを確認。
  - `npm run verify`（全ユニットテスト＋PWA 34 項目検査＋本番ビルド）がすべて合格すること。
