# SPEC — ターミナルの Enter と、レポートバナーの `Open`

- **Status**: archived
- **アーカイブ日**: 2026-11-21（COH-4・全バッチ完了済み。以後は参照用に保持し、新規起票の対象外）

対象: `~/Projects/hermes-mobile-pwa`
赤ペン: `spec-enter-enter-discuss-next-ste` round 1（4 問すべて A・既定 0）
決定: 2026-11-21

## 1. まず否定された説（実測）

報告の説「チャットの Enter ガードがターミナルへ漏れている」は成り立たない。

- `shouldSendOnEnter`（`apps/web/src/lib/composerKey.js:10-13`）の消費者はチャット入力欄だけ
  （`ChatPane.jsx` の import と textarea のハンドラ 1 箇所）。
- `TermPane.jsx` にターミナル用のキーハンドラは無かった（唯一の `onKeyDown` は定型コマンドの
  シート行）。入力は `term.onData` → `{t:'in'}`（`TermPane.jsx`）→ ブリッジが PTY へ素通し
  （`apps/bridge/src/server.js:1840`）で、`\r` を送れば必ず実行される。

残る原因は 2 つ。**フォーカス**（タブは `visibility:hidden + inert` で生かしたまま隠れる＝
`App.jsx` の `TabHost` なので、戻っても xterm の隠し textarea にキーボードが繋がらない）と、
**IME**（日本語入力のまま確定 Enter を押すと、その Enter は PTY へ `\r` として届かない）。

## 2. 決定（Q1〜Q4 = A）

| 問い | 決定 |
| --- | --- |
| Q1 Enter をどこで保証するか | **ターミナルのホスト（`.term-host`）で明示的に `\r` を書く**＋**タブ復帰時に xterm へ再フォーカス** |
| Q2 IME 変換中の Enter | **常に実行**（`isComposing` を見ない）。ターミナルは文章ではなくコマンドで、日本語入力のまま Enter が死ぬのが報告された症状そのもの |
| Q3 バナーの `Open` | **移動だけ**。相談文を置くのは到着先のレポートカードの「💬 次の一手を相談」（`discussReport`）だけ |
| Q4 何で証明するか | **純関数の単体テスト** ＋ **実ブラウザで「本物の Enter 1 回 → `{t:'in',d:'\r'}` が 1 フレーム」**（Chrome が無い環境は `skipped:` を 1 行出して可視化） |

### 2.1 書き手を 1 つに保つ方法（Q1 の設計上の要点）

xterm は keydown を**自分の textarea のキャプチャ段**で購読している
（`@xterm/xterm/lib/xterm.js` の `_bindKeys`）。祖先である `.term-host` の**キャプチャ段**で
Enter を拾って `preventDefault` + `stopPropagation` すれば、xterm のハンドラは動かない。
つまり「xterm と自前ハンドラの両方が `\r` を送る」二重実行は構造的に起きない
（`apps/web/test/termKey.test.js` と実ブラウザ実測の両方でフレーム 1 本を固定）。

### 2.2 実装

- `apps/web/src/lib/termKey.js` — `termKeyBytes(event)` / `isEnterKey(event)`（純関数）。
  `key` だけでなく `code` と旧 `keyCode` も見る（Android の IME は `key` を省く／`Process` にする）。
- `apps/web/src/features/TermPane.jsx`
  - `writeToPty(data)` に送信を集約（定型コマンドの `sendToPty` もこれを使う）。
  - `.term-host` に**キャプチャ段**の `keydown` を張り、Enter なら `\r` を書いてイベントを止める。
  - `active` が true になった直後（60ms）に `term.focus()` = タブ復帰でキーボードを繋ぎ直す。
- `apps/web/src/features/ChatPane.jsx` — バナー `Open` から `prefillComposer(followUpPromptFor(...))`
  を 2 箇所（`__latest__` の新規会話経路と通常会話経路）削除。導線（`openSessionSafe` /
  `startSession`）はそのまま。

### 2.3 何を捨てたか（トレードオフの記録）

- **Q2=A のコスト**: 日本語を「プログラムへ」入力する場面（コミットメッセージを訊かれる等）では、
  最初の Enter が確定ではなく実行になる。この画面では稀で、報告された症状を閉じる側に倒した。
- **Q3=A のコスト**: 相談文まで一度で置きたかった人は、着地後にカードの「💬 次の一手を相談」を
  1 回押す（1 タップ増）。ラベルと動作が一致することを優先した。
- **採らなかった案**: ⏎ キーをヘッダに足す（毎コマンド 2 タップ）、`Open` を
  「開いて相談文を置く」に改名（390px で折れる）、バナーに 3 つ目のボタンを足す。

## 3. 検証（実測）

```sh
node --test apps/web/test/termKey.test.js apps/web/test/bannerOpenDraft.test.js   # 9/9 pass
npm test                                                                         # 1005 pass / 0 fail
npm run build                                                                    # ✓ built
npm run check:term-enter   # 3 回連続 ok（フォーカス復帰・実 Enter・IME 中 Enter の 3 点）
```

`npm run verify` の末尾に `check:term-enter` を足した（`build` の**後**。測るのは配信中の `dist`）。

- `apps/web/test/termKey.test.js` — Enter / Shift+Enter / IME 中 Enter → `\r`、矢印・Ctrl+C・
  その他のキーは `null`（xterm に任せる）。
- `apps/web/test/bannerOpenDraft.test.js` — `Open` の JSX ブロックに `prefillComposer` /
  `followUpPromptFor` が**無い**こと、`discussReport` 側には**有る**こと（ソースのブロックを読む）。
- `scripts/check-term-enter.mjs`（`scripts/lib/cdp.mjs` を使う）— headless Chrome で
  390x844 のアプリを開き、
  1. `WebSocket.prototype.send` を差し替えて送信フレームを記録（`{t:'in'}` は**送らない**ので
     本番 PTY に空行を流さない）、
  2. ターミナルタブ → タスクタブ → ターミナルタブと往復し、復帰時に `activeElement` が
     `xterm-helper-textarea` か、
  3. CDP の `Input.dispatchKeyEvent` で**本物の Enter** を 1 回撃ち、`{t:'in',d:'\r'}` が
     ちょうど 1 フレームか、
  4. `isComposing: true` の合成 keydown でも同じフレームが出るか（＝ハンドラが効いているか）。
- ガードの効きは**注入して赤を確認**した（実測）:
  - 復帰フォーカスを止める → `タブに戻っても xterm にフォーカスが戻らない` で exit 1
  - 逆に Enter ハンドラだけ止めると、フォーカスがある回は xterm 自身が `\r` を送るため
    **フレーム数だけでは検出できない** — その差を埋めるのが 4 の composition ケース。

## 4. 未検証・残件

- 実端末（Android Chrome / ホーム画面 PWA）での日本語キーボード実機確認は未実施。
  ブラウザ実測はデスクトップ Chrome の合成イベントなので、「Android IME が Enter を
  `keydown Enter` として出すか」までは踏み込んでいない（出さない IME では
  composition 中の `beforeinput` 経路になるので、症状が残る場合はそこを次に測る）。
- 配信は `npm run build` まで（`apps/web/dist` 更新済み）。ホーム画面 PWA は Service Worker の
  `CACHE` 名を上げていないため、端末は再読み込み 1 回で新バンドルになる。
