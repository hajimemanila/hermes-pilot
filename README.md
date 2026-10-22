# Hermes Mobile PWA

Hermes Agent を Android（Tailscale 経由）から見る・止める・少し話すための軽量 PWA。

- 既存の標準ダッシュボード（`hermes dashboard` / `hermes serve` = 127.0.0.1:9119）は**変更しない**
- 別ポート **4097** に軽量ブリッジ + PWA を独立ホストし、REST / WS をプロキシする

**現状: 計画のみ（実装未着手）**

- `docs/PLAN.md` — アーキテクチャ、V1 / V2 の機能、セキュリティ、リスク、WBS
- `docs/EVIDENCE.md` — 前提となる実測（API 一覧、認証、キルスイッチの挙動、カンバン DB）

## 要点

| 項目 | 決定 |
|---|---|
| 構成 | PWA(4097) → bridge → 127.0.0.1:9119（トークンはサーバ側で注入） |
| V1 | DSH アプリの 4 タブ（チャット / モデル / ターミナル / 設定）を Hermes 向けに |
| V2 | タスクビューア / SystemOps パネル / キルスイッチ |
| 認証 | Tailscale 限定 + アプリトークン Cookie |
| 見積 | 約 6.5 日（V1 4.0 / V2 2.5） |
