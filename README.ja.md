# Hermes Pilot（日本語）

自律走行する [Hermes Agent](https://hermes-agent.nousresearch.com/docs) を、スマホやタブレットから**操縦**するための
PWA プラグインです。エージェントが判断を仰ぐ場面を「1 タップのレビューシート」と「スクショへの赤入れ」に変え、
カンバン・チャット・ターミナル・使用量を 1 つのインストール可能な PWA にまとめます。

English README: [`README.md`](README.md)

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
- **タスク / 承認待ち**: ボード切替、詳細、イベント履歴、タスクごとの git 差分、承認・コメント・中断
- **チャット**: ストリーミング、思考ログ、ツールログ、添付、定型スニペット、セッション横断検索
- **ターミナル**: 実 PTY。OS に応じたコマンドスニペット付き
- **英語・日本語**（既定フォールバックは `en`、`ja` 同梱）、**Dark / Light / System** テーマ、
  **820px 以上でタブレット 2 ペイン**
- **外部プラグイン不要** — リポジトリはプロジェクトフォルダの 1 階層スキャンで見つけ、システム状態は
  Hermes 標準 API だけで組み立てます

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
4. 同梱スキル `quick-review` / `annotation` を `~/.hermes/skills/` へ配置
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
npm test                    # 単体テスト（329 件）
npm run verify              # test + check:pwa（34 項目）+ 本番ビルド
npm run deploy              # 検証付きで dist を原子的に切替（無停止）
npm run migrate:pilot       # init と同じ移行を単体で実行
node bin/hermes-pilot.mjs --help
```

構成:

```text
bin/hermes-pilot.mjs     CLI: init / start / qr / service / migrate
apps/bridge/src/         ブリッジ（server.js, auth.js, review.js, qr.js, capabilities.js, ...）
apps/bridge/test/        ブリッジの単体テスト（qr.test.js は qrencode の参照行列と比較）
apps/web/src/            React PWA（i18n/, features/, lib/pairing.js, lib/theme.js）
apps/web/dist/           ブリッジが配信する本番ビルド
skills/                  同梱スキル quick-review / annotation
docs/                    SPEC-PUBLIC-PLUGIN.md（仕様）, OPERATIONS.md, PLAN.md, EVIDENCE.md
```

QR 生成は依存ゼロ（`apps/bridge/src/qr.js`）です。byte モード・誤り訂正レベル M・型番 1〜10 に対応し、
UI 向けに SVG、ターミナル向けに ANSI 半角ブロックを出します。生成したモジュール行列は
`apps/bridge/test/qr.test.js` で `qrencode` の参照行列と一致することを検証しています。

## ライセンス

MIT
