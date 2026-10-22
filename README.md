# Hermes Mobile PWA

Hermes Agent を Android（Tailscale 経由）から**見る・止める・話す**ための軽量 PWA。
既存の標準ダッシュボード（`hermes dashboard` / `hermes serve` = 127.0.0.1:9119）は**変更しない**。

```
[Android PWA] → https://<host>:8444 → [bridge :4097] → http://127.0.0.1:9119
                                          ├ カンバン SQLite（read-only）
                                          ├ ログ末尾 / 監査ログ
                                          └ キルスイッチ（drain / restart / stop / タスク中断）
```

## できること

- **タスク**: カンバンのボード切替・タスク一覧・詳細（イベント / 実行履歴）・5秒ポーリング・実行中バッジ
- **SystemOps**: Clean / Blocked バッジ、メモリ・ディスク、実行中タスク数
- **緊急操作**: 長押し1.5秒＋確認語で drain / restart / stop / start、実行中タスクの中断（reclaim→block）
- **チャット**: Hermes の WS（JSON-RPC）をそのまま中継。ストリーミング、思考ログ、利用トークン、中断、会話一覧の復元
- **端末**: 実 PTY（zsh）。全操作は `~/.hermes/mobile-pwa/audit.jsonl` に記録

## セットアップ

```bash
cd ~/Projects/hermes-mobile-pwa
npm install                 # postinstall が node-pty の権限を直す
npm run build               # apps/web/dist
npm start                   # http://127.0.0.1:4097
```

常駐（launchd）と公開（Tailscale `:8444`）は `docs/OPERATIONS.md`。
初回アクセスは `/auth?t=<~/.hermes/mobile-pwa/token>` を開く（Cookie が入る）。

## 開発

```bash
npm run dev                 # Vite :4098（/api・/ws は 4097 へプロキシ）
npm test                    # 認証・カンバン読み取り・中断ガード（6件）
npm run probe               # Hermes の /api/ws を直接叩くプロトコル探針
npm run probe:bridge        # ブリッジ経由の疎通（BRIDGE_OK が出れば健全）
```

## ドキュメント

- `docs/PLAN.md` — 設計・却下案・リスク・WBS
- `docs/OPERATIONS.md` — 起動停止・公開・API 一覧・チャットのプロトコル・障害切り分け
- `docs/EVIDENCE.md` — 着手前の実測（API / 認証 / キルスイッチの挙動 / カンバン DB）

## 構成

| 項目 | 決定 |
|---|---|
| 公開 | `https://<host>:8444`（別オリジン。443/`/dsh`/8443 は既存のまま） |
| 待受 | 127.0.0.1:4097（Tailscale serve 経由のみ外部公開） |
| 認証 | アプリトークン Cookie（`HttpOnly` / `SameSite=Strict`）+ 書き込み時 `X-Client: mobile` |
| カンバン | ボードごとの SQLite を read-only で読む（HTTP API が無いため） |
| キルスイッチ | Hermes の `/api/gateway/*`。生の launchctl は使わない |
