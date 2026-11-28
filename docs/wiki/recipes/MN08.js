/**
 * MN08 (チャットのバブル操作メニュー): 会話を開き、2 つ目のバブルの「…」を押す。
 */
(async () => {
  const S = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 40 && document.querySelectorAll('nav .nav-item').length < 6; i += 1) await S(200);
  const chatNav = document.querySelectorAll('nav .nav-item')[2];
  if (chatNav && !/(^|\s)on(\s|$)/.test(chatNav.className)) chatNav.click();
  await S(1200);
  const pane = document.querySelector('.pane.chat');
  const allSessions = (root) => ([...((root && root.querySelectorAll('button.row')) || [])]
    .filter((b) => !b.closest('.list') && b.querySelector('.row-mode')));
  const pickTarget = (root) => {
    const all = allSessions(root);
    return all.find((b) => !/\bro\b/.test(b.className)) || all[0] || null;
  };
  let target = pickTarget(pane);
  if (window.innerWidth < 820) {
    pane?.querySelectorAll('.icon-btn')[0]?.click();
    await S(1100);
    const sheets = [...document.querySelectorAll('.sheet')];
    target = pickTarget(sheets[sheets.length - 1]);
  }
  if (!target) return 'no-session-row';
  target.click();
  for (let i = 0; i < 100 && document.querySelectorAll('.bubble-menu-btn').length < 2; i += 1) await S(200);
  const btns = document.querySelectorAll('.bubble-menu-btn');
  const btn = btns[1] || btns[0];
  if (!btn) return 'no-bubble';
  btn.click();
  await S(1200);
  return 'ok';
})()
