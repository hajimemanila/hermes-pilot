/**
 * MN09 (セッション一覧ドロワー): 390 はドロワーを開き、1180 は左列の会話を 1 つ選ぶ。
 * 使い方: node scripts/capture-wiki.mjs --id MN09 --lang ja --eval "$(cat docs/wiki/recipes/MN09.js)"
 */
(async () => {
  const S = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 40 && document.querySelectorAll('nav .nav-item').length < 6; i += 1) await S(200);
  const chatNav = document.querySelectorAll('nav .nav-item')[2];
  if (chatNav && !/(^|\s)on(\s|$)/.test(chatNav.className)) chatNav.click();
  await S(1200);
  const pane = document.querySelector('.pane.chat');
  if (window.innerWidth < 820) {
    pane?.querySelectorAll('.icon-btn')[0]?.click();
    await S(1400);
    return document.querySelector('.sheet button.row .row-mode') ? 'drawer' : 'no-drawer';
  }
  const rows = [...((pane && pane.querySelectorAll('button.row')) || [])]
    .filter((b) => !b.closest('.list') && b.querySelector('.row-mode'))
    .filter((b) => !/\bro\b/.test(b.className));
  const target = rows[0];
  if (!target) return 'no-session-row';
  target.click();
  await S(3200);
  return 'ok';
})()
