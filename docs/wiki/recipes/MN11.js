/**
 * MN11 (メモ → ブレストの引き継ぎ): 本文を持つメモカードの 🧠 ブレスト を押し、文面が引き継がれたシートを出す。
 * 使い方: node scripts/capture-wiki.mjs --id MN11 --lang ja --eval "$(cat docs/wiki/recipes/MN11.js)"
 */
(async () => {
  const S = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 40 && document.querySelectorAll('nav .nav-item').length < 6; i += 1) await S(200);
  const notesNav = document.querySelectorAll('nav .nav-item')[3];
  if (notesNav && !/(^|\s)on(\s|$)/.test(notesNav.className)) notesNav.click();
  for (let i = 0; i < 40 && !document.querySelector('.pane.memos-pane .memo-card'); i += 1) await S(200);
  await S(600);
  const sheetWith = (re) => [...document.querySelectorAll('.sheet')].filter((s) => re.test(s.innerText || '')).pop();
  const cards = [...document.querySelectorAll('.pane.memos-pane .memo-card')];
  for (const card of cards.slice(0, 6)) {
    const btn = card.querySelector('.memo-card-actions .report-card-btn');
    if (!btn) continue;
    btn.click();
    for (let i = 0; i < 40 && !document.querySelector('textarea.seed-input'); i += 1) await S(150);
    await S(900);
    const ta = [...document.querySelectorAll('textarea.seed-input')].pop();
    if (ta && String(ta.value || '').trim()) {
      await S(700);
      return 'ok';
    }
    const sheet = sheetWith(/ブレスト/);
    sheet?.querySelector('.icon-btn')?.click();
    await S(700);
  }
  return 'no-seed';
})()
