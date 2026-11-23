/**
 * MN06 (Annotation エディタ + ツールバー): Review タブの注釈待ちカードを開いてエディタを表示する。
 * 前提: 注釈待ち（mode=annotation, blocked）のカードが 1 件あること。
 *       「＋ 注釈」からライブラリ画像を選ぶと 1 件作れる（撮影だけなら送信せず閉じる）。
 * 使い方: node scripts/capture-wiki.mjs --id MN06 --lang ja --eval "$(cat docs/wiki/recipes/MN06.js)"
 */
(async () => {
  const S = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 40 && document.querySelectorAll('nav .nav-item').length < 6; i += 1) await S(200);
  const reviewNav = document.querySelectorAll('nav .nav-item')[1];
  if (reviewNav && !/(^|\s)on(\s|$)/.test(reviewNav.className)) reviewNav.click();
  for (let i = 0; i < 60 && !document.querySelector('.ak-row'); i += 1) await S(200);
  await S(600);
  const rows = [...document.querySelectorAll('.ak-row')].filter((r) => /r1|annotation/.test(r.innerText || ''));
  const row = rows[0] || document.querySelector('.ak-row');
  if (!row) return 'no-review-row';
  row.click();
  for (let i = 0; i < 80 && !document.querySelector('.ak-anno'); i += 1) await S(150);
  await S(1500);
  return document.querySelector('.ak-anno') ? 'ok' : 'no-editor';
})()
