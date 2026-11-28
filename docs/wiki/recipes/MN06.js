/**
 * MN06 (Annotation エディタ + ツールバー): Review タブの注釈待ちカードを開いてエディタを表示する。
 * ライブ盤面に注釈待ちが無い場合も非破壊フォールバックで赤入れエディタを再現する。
 */
(async () => {
  const S = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 40 && document.querySelectorAll('nav .nav-item').length < 6; i += 1) await S(200);
  const reviewNav = document.querySelectorAll('nav .nav-item')[1];
  if (reviewNav && !/(^|\s)on(\s|$)/.test(reviewNav.className)) reviewNav.click();
  for (let i = 0; i < 30 && !document.querySelector('.ak-row'); i += 1) await S(200);
  await S(400);
  const rows = [...document.querySelectorAll('.ak-row')].filter((r) => /r1|annotation/.test(r.innerText || ''));
  let row = rows[0];
  if (!row) {
    const targetId = 't_mn06_demo_anno';
    const c = document.createElement('canvas');
    c.width = 660; c.height = 1040;
    const g = c.getContext('2d');
    g.fillStyle = '#0e1720'; g.fillRect(0, 0, 660, 1040);
    g.fillStyle = '#142634'; g.fillRect(32, 36, 596, 86);
    g.fillStyle = '#2dd4bf'; g.font = '700 28px system-ui,sans-serif';
    g.fillText('FocusFlow · Timer Preview', 56, 88);
    g.fillStyle = '#f8fafc'; g.font = '800 72px system-ui,sans-serif';
    g.fillText('24:12', 220, 260);
    g.fillStyle = '#182b3a'; g.fillRect(40, 340, 580, 110);
    g.fillRect(40, 470, 580, 110);
    g.fillStyle = '#2dd4bf'; g.fillRect(40, 880, 580, 96);
    g.fillStyle = '#06161a'; g.font = '800 32px system-ui,sans-serif';
    g.fillText('Start Session', 230, 940);
    const dataUrl = c.toDataURL('image/png');
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (desc?.set) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true,
        get: desc.get,
        set(v) {
          if (String(v || '').includes('/api/review/' + targetId + '/image')) return desc.set.call(this, dataUrl);
          return desc.set.call(this, v);
        },
      });
    }
    const item = {
      id: targetId, board: 'default', status: 'blocked', bucket: 'waiting',
      title: 'スクリーンショットの配置調整', createdAt: Date.now() - 120000,
      review: { label: 'ui-review-01', round: 1, mode: 'annotation', hasCompare: false, title: 'スクリーンショットの配置調整' },
    };
    const orig = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      if (/\/api\/review(\?|$)/.test(String(url))) {
        return new Response(JSON.stringify({ items: [item] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return orig(url, opts);
    };
    const refreshBtn = [...document.querySelectorAll('.ak-head-actions button')].pop();
    refreshBtn?.click();
    for (let i = 0; i < 40 && !document.querySelector('.ak-row'); i += 1) await S(150);
    row = document.querySelector('.ak-row');
  }
  if (!row) return 'no-review-row';
  row.click();
  for (let i = 0; i < 80 && !document.querySelector('.ak-anno'); i += 1) await S(150);
  await S(1200);
  return document.querySelector('.ak-anno') ? 'ok' : 'no-editor';
})()
