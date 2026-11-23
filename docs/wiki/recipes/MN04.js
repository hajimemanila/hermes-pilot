/**
 * MN04 (タスク詳細 + Git Diff): hermes-mobile-pwa ボードの完了タスクを開き、変更ファイルとパッチを展開する。
 * 使い方: node scripts/capture-wiki.mjs --id MN04 --lang ja --eval "$(cat docs/wiki/recipes/MN04.js)"
 */
(async () => {
  const S = (ms) => new Promise((r) => setTimeout(r, ms));
  const picker = document.querySelector('.pick-item.board-now');
  if (picker) { picker.click(); await S(900); }
  const boardRow = [...document.querySelectorAll('.sheet .pick-item')]
    .find((b) => /^hermes-mobile-pwa/.test((b.innerText || '').trim()));
  if (boardRow) { boardRow.click(); await S(1800); }
  const row = [...document.querySelectorAll('.list .row')].find((e) => /PWAチャットUI/.test(e.innerText || ''));
  if (!row) return 'no-task-row';
  row.click();
  for (let i = 0; i < 60 && !document.querySelector('.accordion'); i += 1) await S(150);
  const acc = document.querySelector('.accordion');
  if (!acc) return 'no-accordion';
  acc.click();
  for (let i = 0; i < 60 && !document.querySelector('.diff-row'); i += 1) await S(150);
  const dr = document.querySelector('.diff-row');
  if (dr) { dr.click(); await S(1400); }
  const scroller = [document.querySelector('.split-detail'), document.querySelector('.sheet-body')]
    .filter(Boolean)
    .find((e) => e.scrollHeight > e.clientHeight + 8);
  const target = document.querySelector('.diff-row');
  if (scroller && target) {
    scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 120;
  }
  await S(600);
  return 'ok';
})()
