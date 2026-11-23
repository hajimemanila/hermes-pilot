# カタログ SHA bump PR の手順（`v0.2.0` ピン → `0.2.4`）

カタログ掲載は済んでいる（`plugin-catalog/hermes-pilot.yaml`、pin `5c82ba62` = v0.2.0）。
差分の公開は **SHA bump PR**（規則 4: 旧→新の upstream 差分が再レビュー対象）で行う。
エントリの payload は `docs/catalog/hermes-pilot.yaml` に置いてある。

## 0. 前提（外部送信なので明示指示があるときだけ）

`git push` / PR 作成は外部送信。次の順で、すべて成功してから PR を出します。

```bash
cd ~/Projects/hermes-pilot
npm run verify                      # 1275 pass / check:cold-install を含む
hermes plugins validate .           # security scan が safe
git log --oneline origin/main..HEAD # 未 push のコミットを確認
git push origin main
git tag v0.2.4 && git push origin v0.2.4
```

## 1. エントリを新しい SHA で埋める

```bash
SHA=$(git rev-parse HEAD)           # 40 桁。タグ・ブランチは loader が拒否する
sed -i '' "s/^sha: .*/sha: \"$SHA\"/" docs/catalog/hermes-pilot.yaml
```

## 2. 本物の loader で検証（PR 前に必ず）

```bash
PY=$(ls ~/.hermes/installs/*/environments/*/venv/bin/python3 | head -1)
cd ~/.hermes/hermes-agent
PYTHONPATH=$PWD $PY - <<'PY'
import shutil, tempfile
from pathlib import Path
from hermes_cli.plugin_catalog import load_catalog
src = Path.home()/"Projects/hermes-mobile-pwa/docs/catalog/hermes-pilot.yaml"
tmp = Path(tempfile.mkdtemp()); shutil.copy(src, tmp/src.name)
for e in load_catalog(tmp):
    print(e.name, e.version, e.tier, e.category, e.platforms, len(e.description))
PY
$PY -I scripts/ci/catalog_entry_fields.py \
  ~/Projects/hermes-mobile-pwa/docs/catalog/hermes-pilot.yaml   # "BAD": "" であること
```

## 3. PR 本文に書くこと（レビュアーが最初に見る）

- 差分範囲: `5c82ba62..<新SHA>`（PR 作成時に `git rev-list --count` と `git diff --stat` で実測して書く。
  2026-11-23 時点は 105 コミット / 325 ファイル +46,699 −17,294）
- **新しく増えた権限**を先に列挙する（v0.2.0 の disclosure との diff）
  - gateway 操作（drain / restart / stop / start）を 127.0.0.1:9119 経由で叩ける
  - 緊急停止が `~/.hermes/ESTOP` を CLI 経由で作る
  - 仕様アーカイブが**登録リポジトリ内の `SPEC*.md` に 1 行書き込む**
  - `client-errors.log` を plugin-data 配下に書く
- 検証の実測値: `npm run verify` の内訳（テスト件数・cold install・audit）、
  `hermes plugins validate .` の `security scan — safe`
- 既知の制約（`known_issues`）と、英語 UI の確認方法（設定 → Language → English で
  chrome に CJK が出ないこと。i18n 辞書は ja/en 各 1230 キー一致）

## 4. 出したあと

- レビュアーの指摘は `docs/SPEC-CATALOG-ADMISSION.md` と同じ形（D 番号 → 受入条件 → コミット）で回す
- pin を動かしたくなったら **必ず新しい PR**（同じ PR で sha を差し替えない）
