# Interactive Demo（静的同梱物）

`npm run build:demo` が生成する **自己完結の単一 HTML**（外部参照 0・約 950 KB）です。
Hermes に接続せず、モック API で PWA の主要フロー（Spec Seed → Quick Review → Spec Launchpad →
Architect 進行 → Mission Receipt）を試せます。

- そのまま開く: `demo/index.html` をブラウザで開く（`file://` でも可）
- 公開 URL: https://hajimemanila.github.io/hermes-pilot/
- Google Sites: 「挿入 → 埋め込む → URL で」に公開 URL を貼る、または
  「埋め込みコード」にこのファイルの中身を貼る
- モックは `Hermes Native`（Hermes 内蔵の Architect）固定です。外部 AI CLI を起動する
  ランナー切替はありません（A2B は「`docs/SPEC-*.md` 配置 → 1 タップ自律実装」と
  「`Hermes Native` 仕様策定」の 2 軸のみ）。

再生成は `npm run build:demo`（出力は `apps/web/dist-demo/`、追跡されるのは本ディレクトリの写しのみ）。
