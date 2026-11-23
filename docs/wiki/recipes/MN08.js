/**
 * MN08 (チャットのバブル操作メニュー): 再開できる会話を開き、2 つ目のバブルの「…」を押す。
 * 使い方: node scripts/capture-wiki.mjs --id MN08 --lang ja --eval "$(cat docs/wiki/recipes/MN08.js)"
 */
(async () => {
  const S = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 40 && document.querySelectorAll('nav .nav-item').length < 6; i += 1) await S(200);
  const chatNav = document.querySelectorAll('nav .nav-item')[2];
  if (chatNav && !/(^|\s)on(\s|$)/.test(chatNav.className)) chatNav.click();
  await S(1200);
  const pane = document.querySelector('.pane.chat');
  const sessions = (root) => ([...((root && root.querySelectorAll('button.row')) || [])]
    .filter((b) => !b.closest('.list') && b.querySelector('.row-mode'))
    .filter((b) => !/\bro\b/.test(b.className)));
  let rows = sessions(pane);
  if (window.innerWidth < 820) {
    pane?.querySelectorAll('.icon-btn')[0]?.click();
    await S(1100);
    const sheets = [...document.querySelectorAll('.sheet')];
    rows = sessions(sheets[sheets.length - 1]);
  }
  const target = rows[0];
  if (!target) return 'no-session-row';
  target.click();
  for (let i = 0; i < 100 && document.querySelectorAll('.bubble-menu-btn').length < 2; i += 1) await S(200);
  const btn = document.querySelectorAll('.bubble-menu-btn')[1];
  if (!btn) return 'no-bubble';
  btn.click();
  await S(1400);
  return 'ok';
})()
