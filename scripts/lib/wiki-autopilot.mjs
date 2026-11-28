/**
 * Autopilot Showcase (`AP01`..`AP06`) state recipes for `scripts/capture-wiki.mjs`.
 *
 * Keeps every FocusFlow Autopilot screenshot deterministic without mutating
 * backend SQLite state on the live bridge.
 */

export const AP_PRELUDE = [
  'const __t=(ms)=>new Promise(r=>setTimeout(r,ms));',
  'const __q=(s,ms=10000)=>new Promise(res=>{const end=Date.now()+ms;(function f(){const e=document.querySelector(s);if(e)return res(e);if(Date.now()>end)return res(null);setTimeout(f,100)})()});',
  'const __jsonRes=(obj)=>new Response(JSON.stringify(obj),{status:200,headers:{"content-type":"application/json"}});',
  `const __drawAutopilotMock=async(variant)=>{
    const c=document.createElement('canvas'); c.width=640; c.height=420;
    const g=c.getContext('2d');
    const rr=(x,y,w,h,r)=>{g.beginPath();g.roundRect(x,y,w,h,r);};
    g.fillStyle=variant==='B'?'#151822':'#0f1620'; rr(0,0,640,420,24); g.fill();
    g.strokeStyle=variant==='B'?'rgba(245,158,11,0.38)':'rgba(45,212,191,0.38)';
    g.lineWidth=2; rr(16,16,608,388,20); g.stroke();
    g.fillStyle=variant==='B'?'#f59e0b':'#2dd4bf';
    g.font='700 18px system-ui,-apple-system,sans-serif';
    g.fillText('FocusFlow · Variant '+(variant==='B'?'B':'A'),36,56);
    if(variant==='B'){
      g.fillStyle='rgba(255,255,255,0.06)'; rr(36,84,270,220,18); g.fill();
      rr(334,84,270,104,18); g.fill(); rr(334,200,270,104,18); g.fill();
      g.fillStyle='#f8fafc'; g.font='800 54px system-ui,-apple-system,sans-serif';
      g.fillText('25:00',74,195);
      g.fillStyle='#fbbf24'; g.font='700 18px system-ui,-apple-system,sans-serif';
      g.fillText('🍅 今日 3 / 目標 6',74,238);
      g.fillStyle='#cbd5e1'; g.font='600 18px system-ui,-apple-system,sans-serif';
      g.fillText('1. 仕様レビュー (25m)',354,142);
      g.fillText('2. デザイン調整 (15m)',354,258);
    } else {
      g.strokeStyle='rgba(45,212,191,0.22)'; g.lineWidth=14;
      g.beginPath(); g.arc(210,210,102,0,Math.PI*2); g.stroke();
      g.strokeStyle='#2dd4bf'; g.lineWidth=14; g.lineCap='round';
      g.beginPath(); g.arc(210,210,102,-Math.PI/2,Math.PI*1.05); g.stroke();
      g.fillStyle='#f8fafc'; g.font='800 50px system-ui,-apple-system,sans-serif';
      g.textAlign='center'; g.fillText('24:12',210,222); g.textAlign='start';
      g.fillStyle='#94a3b8'; g.font='600 16px system-ui,-apple-system,sans-serif';
      g.textAlign='center'; g.fillText('集中フェーズ · 🍅 3',210,256); g.textAlign='start';
      g.fillStyle='rgba(255,255,255,0.06)'; rr(352,98,252,64,14); g.fill();
      rr(352,174,252,64,14); g.fill(); rr(352,250,252,64,14); g.fill();
      g.fillStyle='#e2e8f0'; g.font='600 17px system-ui,-apple-system,sans-serif';
      g.fillText('🎨 リング表示 + 大数字',372,136);
      g.fillText('🍅 日次トマト集計',372,212);
      g.fillText('👍 親指スタートボタン',372,288);
    }
    g.fillStyle=variant==='B'?'#f59e0b':'#14b8a6'; rr(36,334,568,48,14); g.fill();
    g.fillStyle='#081016'; g.font='800 18px system-ui,-apple-system,sans-serif';
    g.textAlign='center'; g.fillText('▶ 25分タイマーを開始',320,365); g.textAlign='start';
    return c.toDataURL('image/png');
  };`,
  `const __installMockApi=(cfg)=>{
    const origFetch=window.fetch.bind(window);
    const shotMap=cfg.shots||{};
    if(Object.keys(shotMap).length){
      const desc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
      if(desc&&desc.set){
        Object.defineProperty(HTMLImageElement.prototype,'src',{
          configurable:true,
          get:desc.get,
          set(v){
            const s=String(v||'');
            const hit=Object.keys(shotMap).find((k)=>s.includes(k));
            if(hit) return desc.set.call(this,s.includes('compare=1')?(shotMap.before||shotMap[hit]):shotMap[hit]);
            return desc.set.call(this,v);
          }
        });
      }
    }
    localStorage.setItem('hm.board', 'focusflow');
    if(cfg.runAnchor){
      localStorage.setItem('hm.autopilot.run', JSON.stringify({ focusflow: cfg.runAnchor }));
    } else {
      localStorage.removeItem('hm.autopilot.run');
    }
    window.fetch=async(url,opts)=>{
      const u=String(url);
      if(/\\/api\\/boards(\\?|$)/.test(u)){
        return __jsonRes({boards:[{slug:'focusflow',name:'FocusFlow',label:'FocusFlow (Pomodoro)',icon:'🍅',current:true,counts:{running:cfg.runningCount||0}}]});
      }
      if(/\\/api\\/boards\\/focusflow\\/preview(\\?|$)/.test(u)){
        return __jsonRes(cfg.preview||{ok:false});
      }
      if(/\\/api\\/boards\\/focusflow\\/tasks/.test(u)){
        return __jsonRes({board:'focusflow',tasks:cfg.tasks||[],archivedCount:0});
      }
      if(/\\/api\\/architect\\/jobs/.test(u)){
        return __jsonRes({ok:true,board:'focusflow',runner:'hermes',jobs:cfg.jobs||[],specReady:[],pending:[]});
      }
      if(/\\/api\\/specs\\/reports/.test(u)){
        return __jsonRes({reports:cfg.reports||[]});
      }
      if(/\\/api\\/review(\\?|$)/.test(u)){
        return __jsonRes({board:'focusflow',items:cfg.reviewItems||[]});
      }
      if(/\\/api\\/review\\/[^/]+\\/data/.test(u)){
        return __jsonRes(cfg.reviewData||{data:{questions:[]},answer:null});
      }
      if(/\\/api\\/live/.test(u)){
        return __jsonRes(cfg.live||{ok:true,counts:{turns:0,tasks:0,architect:0},turns:[],tasks:[],architect:[],telemetry:{}});
      }
      if(/\\/api\\/usage/.test(u)){
        return __jsonRes(cfg.usage||{ok:true,cacheHitRate:0.94,cost:0.38,totals:{cost:0.38,input:92000,output:6400,cacheRead:86480}});
      }
      if(/\\/api\\/overview/.test(u)){
        return __jsonRes({hermes:{version:'0.23.1',model:'hermes',gateway:'running'},system:{memory:{percent:42},disk:{percent:31}},bridge:{ok:true,version:'0.3.0'},kanban:{boards:1,running:cfg.runningCount||0,blocked:(cfg.reviewItems||[]).filter((x)=>x.status==='blocked').length,ready:0,reviewWaiting:(cfg.reviewItems||[]).filter((x)=>x.status==='blocked').length},runningTasks:cfg.runningCount||0});
      }
      return origFetch(url,opts);
    };
  };`,
  `const __openAutopilot=async()=>{
    const btn=document.querySelector('.ap-lens-toggle .ap-lens-btn:first-child');
    if(!btn) throw new Error('Autopilot toggle not found');
    btn.click();
    await __t(900);
  };`,
].join('\n')

function liveMockPayload(now = Date.now(), { waitingItems = [] } = {}) {
  return {
    runningCount: 2,
    jobs: [
      {
        id: 'j_ff_live',
        board: 'focusflow',
        status: 'running',
        phase: 'round2_spec',
        seed: 'FocusFlow — 25分集中＆完了トマト集計アプリ',
        startedAt: now - 83_000,
        createdAt: now - 85_000,
        elapsedSec: 83,
      },
    ],
    tasks: [
      { id: 't_ff_0', board: 'focusflow', title: '[FF-1] タイマー状態管理と履歴保存', status: 'done', createdAt: now - 82_000, completedAt: now - 45_000 },
      { id: 't_ff_1', board: 'focusflow', title: '[FF-2] 円環カウントダウン UI 実装', status: 'done', createdAt: now - 80_000, completedAt: now - 22_000 },
      { id: 't_ff_2', board: 'focusflow', title: '[FF-3] 休憩切替とバイブ通知', status: 'running', assignee: 'mobile', createdAt: now - 40_000, startedAt: now - 40_000 },
      { id: 't_ff_3', board: 'focusflow', title: '[FF-4] レスポンシブ検証＆スクリーンショット', status: 'running', assignee: 'mobile', createdAt: now - 20_000, startedAt: now - 20_000 },
    ],
    reviewItems: waitingItems,
    live: {
      ok: true,
      counts: { turns: 2, tasks: 2, architect: 1 },
      turns: [
        {
          sessionId: 'ff-w1',
          title: 'W1: 円環ゲージ＆スタイル調整',
          lastActivity: 'edit_file',
          lastTool: { name: 'edit_file', at: now - 4_000, durationMs: 320, filePath: 'src/styles/timer.css', addedLines: 24, removedLines: 6 },
          contextPct: 44,
          tokens: { input: 12_200, output: 3_400, total: 15_600, cacheRead: 11_400, costUsd: 0.03 },
        },
        {
          sessionId: 'ff-w2',
          title: 'W2: 実機プレビュー検証',
          lastActivity: 'browser_exec',
          lastTool: { name: 'browser_exec', at: now - 9_000, durationMs: 1_820 },
          contextPct: 38,
          tokens: { input: 2_000, output: 800, total: 2_800, cacheRead: 1_800, costUsd: 0.01 },
        },
      ],
      telemetry: {
        activeWorkers: 2,
        toolCount: 18,
        runTokens: 18_400,
        runCacheRead: 17_300,
        runCostUsd: 0.04,
        cacheHitPct: 94,
        contextPct: 44,
        fileChanges: {
          fileCount: 3,
          totalAdded: 74,
          totalRemoved: 15,
          items: [
            { file: 'src/styles/timer.css', added: 24, removed: 6, at: now - 4_000 },
            { file: 'src/FocusRing.jsx', added: 38, removed: 9, at: now - 11_000 },
            { file: 'src/storage.js', added: 12, removed: 0, at: now - 26_000 },
          ],
        },
        recentTools: [
          { name: 'edit_file', at: now - 4_000, durationMs: 320, filePath: 'src/styles/timer.css', addedLines: 24, removedLines: 6, taskTitle: '[FF-3] 休憩切替とバイブ通知' },
          { name: 'terminal', at: now - 8_000, durationMs: 1_450, command: 'npm test && npm run build', failed: false, taskTitle: '[FF-3] 休憩切替とバイブ通知' },
          { name: 'browser_exec', at: now - 13_000, durationMs: 1_820, taskTitle: '[FF-4] レスポンシブ検証' },
          { name: 'read_file', at: now - 19_000, durationMs: 160, filePath: 'src/App.jsx', taskTitle: '[FF-2] 円環カウントダウン UI 実装' },
        ],
      },
    },
  }
}

function deckMockPayload(now = Date.now()) {
  return {
    reviewItems: [
      {
        id: 't_ff_ap_deck',
        board: 'focusflow',
        status: 'blocked',
        title: '[FF-1] FocusFlow 設計インタビュー',
        createdAt: now - 90_000,
        review: { mode: 'standard', label: 'focusflow-deck', round: 1, title: 'FocusFlow 設計インタビュー' },
      },
    ],
    reviewData: {
      ok: true,
      data: {
        title: 'FocusFlow UI・振る舞いの設計決定',
        deck: true,
        questions: [
          {
            id: 'q1',
            text: 'タイマー表示のレイアウトはどちらにしますか？',
            visualMock: { shot: 'ap-mock-a.png', layoutVariant: 'A', template: 'layout-card' },
            options: [
              {
                id: 'A',
                label: '円環リング＋大きい中央カウントダウン',
                detail: '残り時間と進行率を一目で把握でき、片手操作のスタートボタンも下部に収まります。',
                recommended: true,
                visualMock: { shot: 'ap-mock-a.png', layoutVariant: 'A', theme: 'cyan' },
              },
              {
                id: 'B',
                label: '2カラム・タスク分割ダッシュボード',
                detail: 'タイマーと今日のタスクを横並びに配置し、複数項目を切り替えて使いたい人向けです。',
                recommended: false,
                visualMock: { shot: 'ap-mock-b.png', layoutVariant: 'B', theme: 'amber' },
              },
            ],
          },
          {
            id: 'q2',
            text: '25分終了後の5分休憩は自動で始めますか？',
            options: [
              { id: 'A', label: '手動でスタート（推奨）', detail: 'キリの良いところまで続けてから休憩へ入れます。', recommended: true },
              { id: 'B', label: '00:00 で即スタート', detail: '完全にリズム固定で回します。', recommended: false },
            ],
          },
          {
            id: 'q3',
            text: '完了トマト数の保存方法は？',
            options: [
              { id: 'A', label: 'ブラウザに日次保存', detail: 'サーバー不要で当日分を自動リセットします。', recommended: true },
              { id: 'B', label: 'セッション中のみ保持', detail: '一時利用向けの軽量動作です。', recommended: false },
            ],
          },
        ],
      },
    },
  }
}

export const AP_STATE = Object.freeze({
  /** AP01: Act 1 StarterStage with FocusFlow 1-line prompt in the launcher. */
  AP01: () => `(async()=>{${AP_PRELUDE}
    __installMockApi({});
    await __openAutopilot();
    const inp=await __q('.ap-starter-panel .ap-launcher-input');
    if(!inp) throw new Error('Starter input not found');
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(inp, 'シンプルなポモドーロタイマー「FocusFlow」を作って');
    inp.dispatchEvent(new Event('input',{bubbles:true}));
    await __t(400);
    return Boolean(document.querySelector('.ap-starter-panel'));
  })()`,

  /** AP02: Act 2 Autopilot Option-Cycle swipe deck with FocusFlow visual mock. */
  AP02: () => `(async()=>{${AP_PRELUDE}
    const shotA=await __drawAutopilotMock('A');
    const shotB=await __drawAutopilotMock('B');
    const d=deckMockPayload_PLACEHOLDER;
    __installMockApi({...d, shots:{'ap-mock-a.png':shotA,'ap-mock-b.png':shotB}});
    await __openAutopilot();
    const deck=await __q('.ap-deck-shell .ap-card-shot');
    if(!deck) throw new Error('Deck shot not found');
    await __t(500);
    return true;
  })()`.replace('deckMockPayload_PLACEHOLDER', JSON.stringify(deckMockPayload())),

  /** AP03: Act 2 Autopilot Style Gacha & Remix bar open over the deck card. */
  AP03: () => `(async()=>{${AP_PRELUDE}
    const shotA=await __drawAutopilotMock('A');
    const shotB=await __drawAutopilotMock('B');
    const d=deckMockPayload_PLACEHOLDER;
    __installMockApi({...d, shots:{'ap-mock-a.png':shotA,'ap-mock-b.png':shotB}});
    await __openAutopilot();
    const gachaBtn=await __q('.ap-deck-shell .ap-gacha-btn');
    if(!gachaBtn) throw new Error('Gacha button not found');
    gachaBtn.click();
    const bar=await __q('.ap-remix-bar .ap-gacha-bar');
    if(!bar) throw new Error('Remix / Style Gacha bar did not open');
    await __t(400);
    return true;
  })()`.replace('deckMockPayload_PLACEHOLDER', JSON.stringify(deckMockPayload())),

  /** AP04: Act 3 LiveStudioCard & Panoptes Radar with 2 parallel workers. */
  AP04: () => `(async()=>{${AP_PRELUDE}
    const payload=livePayload_PLACEHOLDER;
    const shotA=await __drawAutopilotMock('A');
    __installMockApi({
      ...payload,
      shots:{'t_ff_live':shotA},
      runAnchor:{runId:'j_ff_live',startedAt:Date.now()-83000,maxTokens:18400,nudges:[]}
    });
    await __openAutopilot();
    const radar=await __q('.ap-live-studio .ap-radar-svg');
    if(!radar) throw new Error('LiveRadarCard did not render');
    await __t(600);
    return Boolean(document.querySelector('.ap-radar-workers-row'));
  })()`.replace('livePayload_PLACEHOLDER', JSON.stringify(liveMockPayload())),

  /** AP05: Act 3 X-Ray inline preview + Step review drawer + Live Nudge pin. */
  AP05: () => `(async()=>{${AP_PRELUDE}
    const payload=livePayload_PLACEHOLDER;
    const shotA=await __drawAutopilotMock('A');
    __installMockApi({
      ...payload,
      shots:{'t_ff_live':shotA},
      runAnchor:{
        runId:'j_ff_live',
        startedAt:Date.now()-83000,
        maxTokens:18400,
        nudges:[{id:'n-ff-1',text:'休憩終了3秒前に控えめバイブも入れて',at:Date.now()-12000,taskId:'t_ff_2',status:'queued'}]
      }
    });
    await __openAutopilot();
    const filesNode=await __q('[data-station="files"]');
    if(!filesNode) throw new Error('FILES radar station not found');
    filesNode.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    const peek=await __q('.ap-radar-peek.files');
    if(!peek) throw new Error('X-Ray files peek did not open');
    const stepBtns=[...document.querySelectorAll('.ap-step-track .ap-step-btn')];
    if(stepBtns[1] && !stepBtns[1].disabled){ stepBtns[1].click(); await __t(250); }
    await __t(400);
    return Boolean(document.querySelector('.ap-step-drawer') && document.querySelector('.ap-radar-peek.files'));
  })()`.replace('livePayload_PLACEHOLDER', JSON.stringify(liveMockPayload())),

  /** AP06: Act 4 CompletionCard with Before/After timelapse & deliverable actions. */
  AP06: () => `(async()=>{${AP_PRELUDE}
    const shotBefore=await __drawAutopilotMock('B');
    const shotAfter=await __drawAutopilotMock('A');
    const now=Date.now();
    __installMockApi({
      shots:{before:shotBefore,'/api/review/t_ff_vis/image':shotAfter},
      preview:{ok:true,kind:'static',board:'focusflow',url:'/api/boards/focusflow/preview-files/',entry:'dist/index.html',launchCmd:'npm run dev',updatedAt:now},
      reports:[{taskId:'t_ff_done',board:'focusflow',spec:'docs/SPEC-FOCUSFLOW.md',label:'FocusFlow — ポモドーロ＆トマト集計',at:now-60000,text:'4/4 バッチ完了・verify 42/42 pass'}],
      tasks:[{id:'t_ff_done',board:'focusflow',spec:'docs/SPEC-FOCUSFLOW.md',title:'FocusFlow — ミニマル・ポモドーロタイマー完成',status:'done',completed_at:Math.floor((now-60000)/1000),result:'4/4 バッチ完了（テスト 42/42 合格）\\nLaunch: npm run dev'}],
      reviewItems:[{id:'t_ff_vis',board:'focusflow',status:'done',review:{mode:'annotation',hasCompare:true,image:'shots/focusflow-after.png'}}],
    });
    await __openAutopilot();
    const card=await __q('.ap-complete-card');
    if(!card) throw new Error('CompletionCard did not render');
    await __t(500);
    return Boolean(document.querySelector('.ap-complete-card'));
  })()`,
})
