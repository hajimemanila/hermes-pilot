# Hermes Pilot（日本語）

自律走行する [Hermes Agent](https://hermes-agent.nousresearch.com/docs) を、スマホやタブレットから**操縦**するための
PWA プラグインです。エージェントが判断を仰ぐ場面を「1 タップのレビューシート」と「スクショへの赤入れ」に変え、
**1 行の思いつきを、起票済みで自走するカンバンバッチまで運ぶ（A2B パイプライン）**うえで、
カンバン・チャット・ターミナル・使用量を 1 つのインストール可能な PWA にまとめます。

English README: [`README.md`](README.md)

**[▶ インタラクティブデモを試す](https://hajimemanila.github.io/hermes-pilot/)** — インストール不要・Hermes 不要。A2B フロー（Spec Seed → Quick Review → Spec Launchpad → Architect 進行 → Mission Receipt）をモックで一通り触れます。単一ファイルは [`demo/index.html`](demo/index.html) にも同梱（Google Sites に埋め込み可）。

```text
[スマホ / タブレット PWA] → https://<tailscale-host>/（または http://<lan-ip>:4097）
                              │
                        [ブリッジ :4097] ──► http://127.0.0.1:9119（既存の Hermes ダッシュボードは変更しない）
                              ├── カンバン SQLite（読み取り専用）
                              ├── Hermes WebSocket（チャット JSON-RPC 中継）
                              └── ~/.hermes/plugin-data/hermes-pilot/（トークン・シート・画像・フィード）
```

## できること

- **Quick Review（レビュー）**: エージェントが「3±1 問＋推奨案」のシートを作り、カンバンタスクを blocked で
  起票します。スマホから 1 タップで回答すると、コメントとして返り、ワーカーが再開します。スキル: `skills/quick-review/`
- **Annotation（赤入れ）**: エージェントが添付したスクショに指で赤を入れ（矩形・矢印・メモ）、座標付きの修正リストとして返します。
  スキル: `skills/annotation/`
- **Spec Architect（仕様化）**: 1 行の種から設計ヒアリングを行い、ワーカーが追加質問なしに完走できる
  `docs/SPEC-*.md` を作ります。スキル: `skills/spec-architect/`
- **タスク / 承認待ち**: ボード切替、詳細、イベント履歴、タスクごとの git 差分、承認・コメント・中断
- **チャット**: ストリーミング、思考ログ、ツールログ、添付、定型スニペット、セッション横断検索
- **ターミナル**: 実 PTY。OS に応じたコマンドスニペット付き
- **英語・日本語**（既定フォールバックは `en`、`ja` 同梱）、**Dark / Light / System** テーマ、そして 2 段階の
  2 ペイン: **680px から狭幅マスター・ディテール**（左 280px。iPad mini 縦などの 744/768px 用）と
  **820px から広幅 2 ペイン**（レビュー左 380px / タスク左 360px）。680px 未満は詳細が全画面シートで開きます
- **外部プラグイン不要** — リポジトリはプロジェクトフォルダの 1 階層スキャンで見つけ、システム状態は
  Hermes 標準 API だけで組み立てます

## A2B パイプライン（種 → 自走するバッチ）

1 行の意図が、ワーカーが最後まで走れる仕様書になります。質問をチャットに積みません。

```text
📝 Spec Seed ──► Quick Review ──► 📄 SPEC-<SLUG>.md ──► 🚀 Spec Launchpad ──► ⚡ ライブ監視 ──► 🏆 Mission Receipt
 1 行（音声可）   3(±1) 問        バッチごとの実行モード     冪等な一括起票          ArchitectJobBar        1200×630 PNG
                 1 タップ回答     受入条件を明記            （カンバン）             LiveSheet/WorkerFeed   X 換算 280 文字以内
```

**2 つの正規ルート（どちらも外部 AI CLI を起動しません）:**

- **A. SPEC 配置 → 1 タップ自律実装（基本ルート）** — `docs/SPEC-*.md`（必要なら先に
  `review/sheets/*.json`）を自分でリポジトリへ置きます。自分のターミナル、公式 Antigravity Remote PWA、
  任意のエディタのどれでも構いません。Hermes Pilot はファイル監視（`Spec Launchpad` / `reviewWatcher`）
  だけで受け取り、1 タップの起票から自律実装が始まります。
- **B. `Hermes Native` による仕様策定（スマホ完結）** — `Spec Seed` → Quick Review → `docs/SPEC-*.md` →
  Launchpad。Hermes 自身の `hermes kanban create` で回すため、外部プロセスはゼロです（下の 1〜4）。

1. **📝 Spec Seed** — タスクタブで 1 行を入力（音声ディクテーション可）し、**実行モード**を選びます。
   - **`Zero-Stop`**（既定）— 全バッチが承認待ちで止まらず最後まで自走します。
   - **`Visual-Gate`** — チェックポイントで止まり、次のバッチへ進む前に描画結果（スクショ／赤入れ）を
     目で確認できます。
   - **ランナー** — `Hermes Native` 固定です。Architect は Hermes 自身の中で回り、外部 AI CLI を
     サブプロセスとして起動することはありません（上の「2 つの正規ルート」を参照）。
2. **Quick Review ヒアリング** — Architect が推奨案つきの 3(±1) 問をシートに載せます。
   「⚡ 推奨を一括承認」で 1 タップですべて回答できます。
3. **📄 仕様書** — 2 ラウンド目で `docs/SPEC-<SLUG>.md` を書きます。決定表・バッチごとの `Execution Mode`・
   変更ファイル・受入コマンドまで含むので、ワーカーが「どう実装するか」を聞き返しません。
4. **🚀 Spec Launchpad** — タスクタブが仕様書の `### Batch <ID>` をアコーディオン＋Markdown プレビューで
   一覧し、1 タップでカンバンに起票します。同じ `[ID]` の未完了タスクがあるバッチは飛ばすので、
   二度押し・再読み込みでも重複しません。
5. **⚡ ライブ監視** — `ArchitectJobBar` がジョブのフェーズ（`spawning → round1_sheet → round2_spec →
   spec_ready → launched`）を出し、進まなくなると停滞警告を出し、失敗・停滞したジョブは 1 タップで
   再試行できます。
   `LiveSheet` と `WorkerFeed` が実行中ワーカーのログを流します。
6. **🏆 Mission Receipt** — バッチ完走後、完走サマリが **1200×630 の PNG レシート**と、
   **JA/EN とも X 換算 280 文字以内**のシェア文（KPI の数値は 1 つも落とさず、見出しとフッターから削る）
   を出力します。

```bash
# 1) 種を起票（202 と jobId を即返し、Architect は背後で走る）
curl -s -X POST -H "x-client: mobile" -H "content-type: application/json" \
     -d '{"board":"<board>","seedText":"レシートのダークモード書き出しを足す","autoStart":false}' \
     "http://127.0.0.1:4097/api/architect/seed?t=$(cat ~/.hermes/plugin-data/hermes-pilot/token)"

# 2) ジョブの状態・完成 SPEC・未起票 SPEC
curl -s -H "x-client: mobile" \
     "http://127.0.0.1:4097/api/architect/jobs?board=<board>&t=$(cat ~/.hermes/plugin-data/hermes-pilot/token)"

# 3) バッチを一括起票（冪等。同じ板の未完了はスキップ）
curl -s -X POST -H "x-client: mobile" -H "content-type: application/json" \
     -d '{"board":"<board>","specRelPath":"docs/SPEC-DARK-RECEIPT.md","batchIds":["B1","B2"]}' \
     "http://127.0.0.1:4097/api/specs/launch?t=$(cat ~/.hermes/plugin-data/hermes-pilot/token)"

# 4) 完走後 — 完走サマリとレシートの材料（読み取り専用の集計）
curl -s -H "x-client: mobile" \
     "http://127.0.0.1:4097/api/telemetry/receipt?board=<board>&hours=24&t=$(cat ~/.hermes/plugin-data/hermes-pilot/token)"
```

## 意思決定コックピット（v2）

「エージェントが判断を待っている」から「また走り出した」までを最短にする 5 つ。スマホからも標準
ダッシュボードからも触れます。

- **Spec Launchpad** — タスクタブがボードのリポジトリの `docs/SPEC-*.md` を読み、`### Batch P1: …` の
  バッチを一覧して 1 タップでカンバンに起票します。同じ `[ID]` の未完了タスクがあるバッチは飛ばすので、
  二度押しや再読み込みで重複しません。

  ```bash
  curl -s -H "x-client: mobile" "http://127.0.0.1:4097/api/specs?board=<board>&t=$(cat ~/.hermes/plugin-data/hermes-pilot/token)"
  curl -s -X POST -H "x-client: mobile" -H "content-type: application/json" \
       -d '{"board":"<board>","specRelPath":"docs/SPEC-PILOT-V2.md","batchIds":["P5"]}' \
       "http://127.0.0.1:4097/api/specs/launch?t=$(cat ~/.hermes/plugin-data/hermes-pilot/token)"
  ```

- **1 タップ一括承認（Fast-Track）** — 設問に推奨案があるシートでは
  「⚡ 推奨案（Q1:A · Q2:B）で一括承認して再開」が出ます。1 タップで推奨をまとめて送信し、ワーカーを
  unblock して次の判断待ちへ移ります（`POST /api/review/:id/answer`）。
- **Before ↔ After 比較** — 前ラウンド（`*.before.png` または 1 つ前の連番スクショ）がある注釈レビューでは
  比較トグルが出て、自分が入れた赤と最新スクショを切り替えて見られます。「✅ 検収 OK」で 1 タップ完了
  （`POST /api/review/:id/approve`）。
- **標準ダッシュボード連携** — Hermes ダッシュボード（`:9119`）の「Hermes Pilot」タブで、リポジトリ
  （追加・ピン・非表示・ボード作成）、チャット＆端末スニペット、ブリッジ／GW／監査ログを、PWA と同じ
  ファイルに対して操作できます（`scanDirs` の設定箇所は 1 か所だけ）。

  ```bash
  npx hermes-pilot init --force      # 更新後にダッシュボードのプラグインファイルを入れ替える
  ```

- **スニペット編集** — 組み込みも Hot（バー表示）/ 非表示を切替でき、自分用の追加・編集・並べ替え・削除が
  チャットと端末の両方で、英語・日本語のまま行えます（「既定に戻す」つき）。

  ```bash
  curl -s -H "x-client: mobile" "http://127.0.0.1:4097/api/snippets?lang=ja"      # チャット
  curl -s -H "x-client: mobile" "http://127.0.0.1:4097/api/snippets/term?lang=ja" # 端末
  ```

## 快適さと 1 タップ設定

- **Vibe モード** — 設定の `⚡ ドーパミン ⇄ 🧘 セロトニン` は「見た目と手触りの強さ」だけを変え、機能は変えません。
  ハプティクスと効果音は独立トグルで、**Vibe を切り替えても維持**されます（音量を下げたつもりが振動まで
  止まる事故を起こさないため）。
- **スニペット帯トグル** — チャット入力欄の上、注釈ツールバー、端末キーのチップ帯はそれぞれ折りたためます。
  選択は帯ごとに記憶され、390px の画面で入力欄とキーボードが場所を取り合いません。
- **1 タップ環境最適化** — *設定 → この Hermes を最適化*（`POST /api/pipeline/optimize`）が
  `~/.hermes/SOUL.md` へ A2B の規律節を**冪等に**追記し、同梱 3 スキルを `~/.hermes/skills/` へ配置します。
  `GET /api/pipeline/status` は適用済みかだけを返し、`SOUL.md` の中身は返しません。
- **旧 cron の自動片付け** — `migrate`（と `init`）は旧 `mobile-akapen-watch` / `mobile-review-watch` の
  cron を削除します。完了フィードはブリッジ内蔵の監視が書くようになり、2 者が書くと報告が二重になるためです。
  他の cron とストアのトップレベル構造は変更しません。

## 触って試せるデモ（バックエンド不要）

`npm run build:demo` で `apps/web/dist-demo` に**ブリッジもゲートウェイも DB も要らない**静的サイトを
生成します。GitHub Pages などの静的ホスティングに置けば、誰でもパイプラインを体験できます。

```bash
npm run build:demo             # VITE_DEMO_MODE=1 / base ./ / outDir apps/web/dist-demo
npx serve apps/web/dist-demo   # もしくは python3 -m http.server -d apps/web/dist-demo 4321
```

- **スマホ**では普通の PWA として全画面で開きます（筐体なし）。
- **PC ブラウザ（900px 以上）**ではデバイス筐体つきで表示し、`Phone 390×844` / `Tablet 820×1180`
  （2 ペイン）/ `Full window` を即時切替。`Dopamine ⇄ Serotonin`・音・`Dark ⇄ Light`・`EN ⇄ JA`・
  「ツアーを最初から」も同じバーから切り替わります。筐体の中身は本物の `<iframe>` なので、
  メディアクエリ・`position: fixed` のシート・トースト・下部ナビが実機と同じように振る舞います。
- **4 ステップのガイド**（上部バー。各ステップにジャンプボタン）: ① 仕様の判断シートを
  「⚡ 推奨を一括承認」→ ② 生成された仕様書のバッチを一括起票して自走を眺める →
  ③ 赤入れスタンプ or Before ↔ After の視覚検収 → ④ 実行サマリと**完了レシート**
  （1200×630 PNG / シェア文）を開く。

データはすべてメモリ上（`apps/web/src/demo/mockApi.js`）で、視覚検収に使う画像も inline SVG の
data URL として組み立てるため、デモは外部ネットワークに一切依存しません。

**本番は汚しません**: `main.jsx` が `import.meta.env.VITE_DEMO_MODE` を見るので、通常の
`npm run build` ではデモ分岐ごと（動的 import を含めて）消えます。`apps/web/dist` にモックのコード・
ツアー用 CSS・スクショは入りません（共有辞書の `demo.*` 文言だけは辞書に残ります）。
`apps/web/dist-demo` は git 管理外で、`npm pack` にも含まれません。

### Google Sites（単一ファイル埋め込み）

`npm run build:demo` は **`apps/web/dist-demo/google-sites-embed.html`** も生成します。JS・CSS・SVG 画像を
すべてインライン化し、`localStorage` をメモリ実装に差し替え、PWA 用の `<link>` を外した 1 ファイルです。
生成直後の `verifyEmbedHtml()` 自己チェックで外部参照が 1 つでも残っていれば**ビルドが exit 1 で失敗**する
ため、壊れたファイルがサイトに出ることはありません。

1. `npm run build:demo`
2. Google Sites → *挿入* → **埋め込み** → **コードを埋め込む** → `google-sites-embed.html` の中身を丸ごと貼り付け
3. PC ブラウザで開くと、埋め込み文書が自分をフレームだと認識する（`window.__HM_DEMO_FRAME__`）ため、
   **`Phone 390×844` / `Tablet 820×1180` / `Full window`** のデバイスシミュレータと上部バーがそのまま出ます。
   「ツアーを最初から」は `srcdoc` の reload ではなく内側 iframe の再生成なので、Google Sites 上でも動きます
4. GitHub Pages なら `apps/web/dist-demo` をそのまま公開（相対 `base`）。埋め込みファイルは任意です。

## 必要なもの

- Node.js **22.19 以上**
- Hermes Agent（ブリッジは `http://127.0.0.1:9119` を中継します）
- 任意: [Tailscale](https://tailscale.com/)（外出先から HTTPS で使う場合）。同じ LAN なら
  `http://<lan-ip>:4097` で Tailscale 無しでも動きます

## インストール

```bash
npx hermes-pilot init
```

`init` は何度実行しても安全で、次の 5 つを行います。

1. `~/.hermes/plugin-data/hermes-pilot/`（と `review/{sheets,shots,library}`）を作成
2. **256-bit hex のアプリトークン**を `token` に `0600` で生成（既にあれば作り直さない）
3. 旧 `~/Projects/akapen` / `~/.hermes/plugin-data/akapen` / `~/.hermes/mobile-pwa` があれば移行
   （**コピー**のみ・`mtime` 保持・カンバンの `[akapen]` タグを `[review]` に書換）
4. 同梱スキル `quick-review` / `annotation` / `spec-architect` を `~/.hermes/skills/` へ配置
5. 到達可能なアドレス（Tailscale の MagicDNS 名、無ければ LAN IP）を検出して、
   **ペアリング URL とターミナル QR** を表示

そのあとブリッジを起動します。

```bash
npx hermes-pilot start                        # http://127.0.0.1:4097
npx hermes-pilot start --port 4097 --host 127.0.0.1
```

## 端末のペアリング（長いトークンを打たない）

- **ターミナルから**: `npx hermes-pilot qr` が候補と QR を表示。Tailscale `serve` が 443 以外で HTTPS を
  出している場合は `--tls-port 8444` を付けます
- **アプリから**: 設定 →「端末を追加」→「ペアリング QR を表示」（`GET /api/auth/pairing`）。
  2 台目のスマホ／タブレットで読み取ります

QR を読むと `https://<host>/?token=<token>`（または `#token=`）が開きます。アプリはそのトークンを
`POST /api/auth/login` で **HttpOnly のセッション Cookie** に交換し、直後に `history.replaceState` で
アドレスバーからトークンを消します（履歴・ブックマーク・スクショに残さない）。

> QR にはアプリトークンが入っています。読み取った人はこの Hermes を操作できます。スクショの共有は
> パスワードと同じ扱いにしてください。ローテーションは
> `rm ~/.hermes/plugin-data/hermes-pilot/token` してブリッジを再起動（全端末がログアウトされます）。

## 常駐化

```bash
npx hermes-pilot service install     # macOS は launchd、Linux は systemd --user
npx hermes-pilot service status
npx hermes-pilot service restart
npx hermes-pilot service uninstall
```

- macOS: `~/Library/LaunchAgents/ai.hermes.pilot.plist`（ラベル `ai.hermes.pilot`）、
  ログは `~/.hermes/logs/pilot.out.log` / `pilot.err.log`
- Linux: `~/.config/systemd/user/hermes-pilot.service`
  （`systemctl --user enable --now hermes-pilot.service`）

### `hermes-mobile-pwa` からの移行（HEADS-UP）

サービスラベルは `ai.hermes.hermes-mobile` → `ai.hermes.pilot`、パッケージ名は
`hermes-mobile-pwa` → `hermes-pilot` に変わりました。**旧ラベルは止めずに併設**して、無停止で切り替えます。

```bash
npx hermes-pilot init                     # データをコピー（旧ファイルはそのまま残る）
npx hermes-pilot service install          # 新しいラベルを登録して起動
npx hermes-pilot service status           # 起動確認

# 新しい方で問題ないと確認できてから、旧ラベルを引退させる:
launchctl bootout gui/$(id -u)/ai.hermes.hermes-mobile
```

どちらもポート 4097 を使います。旧がまだ 4097 を掴んでいる場合は、新を別ポートで先に起動して確認し
（`npx hermes-pilot start --port 4098`）、あとで入れ替えてください。旧 `~/.hermes/mobile-pwa/` は
コピーされるだけで削除されません。不要になったら手動で消してください。

## セキュリティ

待ち受けているのはブリッジだけであり、Hermes に手が届くのもブリッジだけです。

| 面 | ルール |
|---|---|
| 待受 | 既定は `127.0.0.1:4097`。Tailscale `serve` などの TLS プロキシを前段に置かない限り外には出ません |
| 端末の資格情報 | `~/.hermes/plugin-data/hermes-pilot/token`（`0600`）の 256-bit hex アプリトークン。1 回だけ **`HttpOnly` / `SameSite=Strict` のセッション Cookie** に交換し、トークンは `history.replaceState` でアドレスバーから消します |
| QR ペアリング | QR に載るのは**ワンタイムのペアリングコード**（10 分・1 回限り）で、アプリトークンそのものではありません。それでもスクショの共有はパスワード扱いで。ローテーションは `rm …/token` ＋ 再起動で全端末がログアウトします |
| Hermes のセッショントークン | ブリッジの外に出ません。PWA が持つのはアプリトークン／Cookie だけです |
| 書き込み | 変更系は **`X-Client: mobile`** ヘッダ（無いと 401）とセッション Cookie の両方が必要で、クロスサイトのフォーム送信では動きません |
| キルスイッチ | 1.5 秒長押し＋確認語。API 側でも `confirm` を検査します。UI から生の `launchctl` は叩きません |
| レート制限 | 読み取り 120 回/分（エンドポイント別バケット）、書き込み 60 回/分 |
| 監査 | すべての書き込みを `~/.hermes/plugin-data/hermes-pilot/audit.jsonl` へ追記（設定タブから閲覧可） |
| 読み取り専用 | カンバン SQLite・使用量・レシートは読み取り専用で開き、ブリッジが勝手に板を移行することはありません |
| 公開パス | 認証不要なのはアプリの殻（`/`, `/assets/*`, `/manifest.webmanifest`, `/sw.js`, `/icon-*`, `/auth`, `/healthz`）だけ。Android の WebAPK 生成が資格情報なしで取りに来るためです。`/api/*` と `/ws/*` はすべて認証の内側です |
| デモ | `apps/web/dist-demo`（と Google Sites 埋め込み）は**モックデータのみ**。トークンもブリッジもネットワークも使いません |

## データと環境変数

永続データはすべて `~/.hermes/plugin-data/hermes-pilot/` の下にあります。

```text
config.json    { lang, scanDirs, servicePort, tlsPort? }
token          アプリトークン（0600）
audit.jsonl    監査ログ（書き込みごと）
repos.json     scanDirs / pinned / hidden / custom
snippets.json  ユーザー定義のチャットスニペット
review/        sheets/, shots/, library/, feed.jsonl, chat-reports.jsonl, task-chats.json
```

| 変数 | 意味 |
|---|---|
| `HP_DATA_DIR` | プラグインのデータ先（既定 `~/.hermes/plugin-data/hermes-pilot`） |
| `HM_DATA` | データ先の完全上書き（開発・検証用） |
| `HM_PORT` / `HM_HOST` | ブリッジの待受（既定 `4097` / `127.0.0.1`） |
| `HERMES_HOME` | Hermes ホーム（既定 `~/.hermes`。`profiles/<name>` を指した場合はルートに補正） |

## 構成の決定

| 項目 | 決定 |
|---|---|
| 公開 | `https://<host>:8444`（Tailscale `serve`）。ブリッジ自体は `127.0.0.1:4097` のみ |
| 認証 | アプリトークン Cookie（`HttpOnly` / `SameSite=Strict`）＋書き込み時 `X-Client: mobile` |
| カンバン | ボードごとの SQLite を読み取り専用で直接読む（HTTP API が無いため） |
| キルスイッチ | Hermes の `/api/gateway/*`。UI から生の `launchctl` は叩かない |
| レビュー | `~/.hermes/plugin-data/hermes-pilot/review/`（シート・画像・ライブラリ・フィード） |
| 完了通知 | ブリッジ内蔵 `review-watcher.js` が `feed.jsonl` / `chat-reports.jsonl` を追記（cron 不要） |

## 開発

```bash
npm install                 # postinstall が node-pty の権限を直す
npm run dev                 # Vite :4098（/api・/ws は 4097 へプロキシ）
npm test                    # 単体テスト（808 件）
npm run verify              # test + check:pwa（34 項目）+ check:oauth + 本番ビルド + audit:responsive
npm run build:demo          # バックエンド不要の静的デモ → apps/web/dist-demo（+ google-sites-embed.html）
npm run deploy              # 検証付きで dist を原子的に切替（無停止）
npm run migrate:pilot       # init と同じ移行を単体で実行
node bin/hermes-pilot.mjs --help
```

`npm run verify` はすべての変更が通す関門です（このツリーでの実測）:

| 手順 | 何を保証するか |
|---|---|
| `npm test` | **808 件**の単体・結合テストが 0 fail（node:test、フレームワーク無し） |
| `check:pwa` | `apps/web/public` に対する **34/34** 項目（マニフェスト・アイコン・マスカブル・Service Worker・viewport） |
| `check:oauth` | **0 違反**: 端末の資格情報や OAuth トークンがブラウザ側バンドルから読めないこと |
| `build` | Vite 本番ビルドが通り、`demo/` のコードが混入していないこと |
| `audit:responsive` | `390×844` / `844×390` / `820×1180` などのレイアウト監査（タップ 44px 以上・新規の見切れなし） |

構成:

```text
bin/hermes-pilot.mjs     CLI: init / start / qr / service / migrate
apps/bridge/src/         ブリッジ（server.js, auth.js, review.js, qr.js, capabilities.js, ...）
apps/bridge/test/        ブリッジの単体テスト（qr.test.js は qrencode の参照行列と比較）
apps/web/src/            React PWA（i18n/, features/, lib/pairing.js, lib/theme.js）
apps/web/src/demo/       デモ専用（mockApi.js, DemoStage.jsx, demo.css）— dist には入りません
apps/web/dist/           ブリッジが配信する本番ビルド
apps/web/dist-demo/      静的デモビルド（`npm run build:demo`・git 管理外）
skills/                  同梱スキル quick-review / annotation / spec-architect
docs/                    SPEC-PUBLIC-PLUGIN.md（仕様）, OPERATIONS.md, PLAN.md, EVIDENCE.md
```

QR 生成は依存ゼロ（`apps/bridge/src/qr.js`）です。byte モード・誤り訂正レベル M・型番 1〜10 に対応し、
UI 向けに SVG、ターミナル向けに ANSI 半角ブロックを出します。生成したモジュール行列は
`apps/bridge/test/qr.test.js` で `qrencode` の参照行列と一致することを検証しています。

## ライセンス

MIT
