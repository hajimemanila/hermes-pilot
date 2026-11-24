/**
 * Showcase (`SC01`..`SC09`) state recipes for `scripts/capture-wiki.mjs`.
 *
 * Extracted from `scripts/capture-wiki.mjs` to keep every file well below the
 * 800-line coherence ratchet while ensuring `SC01`..`SC09` tell a consistent
 * FocusFlow (Pomodoro timer) story without mutating backend SQLite state.
 */

export const SHOWCASE_SEEDS = Object.freeze({
  ja: {
    seed: 'シンプルなポモドーロタイマーを作って。25分集中＋5分休憩の切替、今日の完了トマト数の記録、スマホで見やすい大きな残り時間表示',
    annotation: '① 残り時間のフォントを1.5倍大きくして中央寄せに / ② スタート・一時停止ボタンを親指が届く下部エリアに配置',
    memo: 'ポモドーロ完了時にどのタスクに何分使ったか選べるようにしたい。あと夜間作業用にダークテーマ切替が欲しい',
    brainstorm: 'タスク別の集中時間サマリバーとダークモード切替ボタンを追加',
  },
  en: {
    seed: "Build a minimal Pomodoro timer with 25m focus / 5m break toggle, today's completed tomato counter, and a large mobile-friendly countdown display",
    annotation: '1. Make the countdown timer font 1.5x larger and centered / 2. Move the Start/Pause button to the bottom thumb zone',
    memo: 'Track which task each completed Pomodoro belonged to, and add a dark theme toggle for late-night focus sessions',
    brainstorm: 'Add a per-task focus duration summary bar and a dark mode toggle button',
  },
})

const SC_PRELUDE = [
  'const __t=(ms)=>new Promise(r=>setTimeout(r,ms));',
  'const __q=(s,ms=10000)=>new Promise(res=>{const end=Date.now()+ms;(function f(){const e=document.querySelector(s);if(e)return res(e);if(Date.now()>end)return res(null);setTimeout(f,120)})()});',
  "const __api=async(p)=>(await fetch(p,{headers:{'x-client':'mobile'},credentials:'same-origin'})).json();",
  'const __tab=(i)=>{const n=document.querySelectorAll(\'nav .nav-item\')[i];if(n)n.click();return !!n};',
  'const __click=(s)=>{const e=document.querySelector(s);if(e)e.click();return !!e};',
  'const __jsonRes=(obj)=>new Response(JSON.stringify(obj),{status:200,headers:{"content-type":"application/json"}});',
  `const __drawFocusFlow=async(after)=>{
    const c=document.createElement('canvas'); c.width=660; c.height=1120;
    const g=c.getContext('2d');
    const rr=(x,y,w,h,r)=>{g.beginPath();g.roundRect(x,y,w,h,r);};
    g.fillStyle='#ffffff'; rr(0,0,660,1120,36); g.fill();
    g.fillStyle='#0d8a72'; g.font='800 34px system-ui,-apple-system,sans-serif';
    g.fillText('FocusFlow',44,74);
    if(!after){
      g.fillStyle='#1a1423'; g.font='800 44px system-ui,-apple-system,sans-serif';
      g.fillText('24:12',44,126);
      g.fillStyle='#0d8a72'; rr(436,36,180,68,20); g.fill();
      g.fillStyle='#ffffff'; g.font='700 26px system-ui,-apple-system,sans-serif';
      g.fillText('▶ スタート',462,79);
    } else {
      g.fillStyle='#1a1423'; g.font='800 116px system-ui,-apple-system,sans-serif';
      g.textAlign='center'; g.fillText('24:12',330,192); g.textAlign='start';
    }
    const cardsY=after?240:184;
    g.strokeStyle='#e4e9f0'; g.lineWidth=2;
    rr(40,cardsY,278,128,22); g.stroke();
    rr(342,cardsY,278,128,22); g.stroke();
    g.fillStyle='#687385'; g.font='600 20px system-ui,-apple-system,sans-serif';
    g.fillText('今日の完了トマト',64,cardsY+42);
    g.fillText('集中時間',366,cardsY+42);
    g.fillStyle='#1a1423'; g.font='800 38px system-ui,-apple-system,sans-serif';
    g.fillText('🍅 3 個',64,cardsY+96);
    g.fillText('1 時間 15 分',366,cardsY+96);
    const rows=[['#0d8a72','資料作成','25:00 集中'],['#d8dee8','コードレビュー','5:00 休憩'],['#d8dee8','日報の下書き','未着手']];
    rows.forEach((r,i)=>{
      const y=cardsY+152+i*126;
      g.strokeStyle='#e4e9f0'; rr(40,y,580,108,22); g.stroke();
      g.fillStyle=r[0]; g.beginPath(); g.arc(82,y+54,18,0,Math.PI*2); g.fill();
      g.fillStyle='#1a1423'; g.font='700 26px system-ui,-apple-system,sans-serif'; g.fillText(r[1],120,y+48);
      g.fillStyle='#687385'; g.font='500 20px system-ui,-apple-system,sans-serif'; g.fillText(r[2],120,y+80);
    });
    if(after){
      g.fillStyle='#0d8a72'; rr(40,874,580,108,30); g.fill();
      g.fillStyle='#ffffff'; g.font='800 36px system-ui,-apple-system,sans-serif';
      g.textAlign='center'; g.fillText('▶ スタート',330,940); g.textAlign='start';
    }
    g.strokeStyle='#eef2f6'; g.beginPath(); g.moveTo(0,1010); g.lineTo(660,1010); g.stroke();
    for(let i=0;i<5;i++){
      g.fillStyle=i===0?'#0d8a72':'#d8dee8';
      rr(72+i*118,1036,42,42,10); g.fill();
    }
    return c.toDataURL('image/png');
  };
  const __hookImgSrc=(targetId,beforeUrl,afterUrl)=>{
    const desc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
    if(!desc||!desc.set) return;
    Object.defineProperty(HTMLImageElement.prototype,'src',{
      configurable:true,
      get:desc.get,
      set(v){
        const s=String(v||'');
        if(s.includes('/api/review/'+targetId+'/image')){
          return desc.set.call(this,s.includes('compare=1')?beforeUrl:afterUrl);
        }
        return desc.set.call(this,v);
      }
    });
  };`,
].join('\n')

export const SC_STATE = Object.freeze({
  /** SC01: Spec Seed sheet with FocusFlow 1-line prompt and Visual-gate selected. */
  SC01: (lang) => `(async()=>{${SC_PRELUDE}
    const chip=document.querySelectorAll('.snippet-chip.trigger')[0];
    if(!chip) throw new Error('Spec Seed chip not found'); chip.click();
    const ta=await __q('textarea.seed-input'); await __t(350);
    if(!ta) throw new Error('seed textarea not found');
    const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    set.call(ta, ${JSON.stringify(SHOWCASE_SEEDS[lang === 'en' ? 'en' : 'ja'].seed)});
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    const vis=[...document.querySelectorAll('.seed-seg-btn')].find((b)=>/Visual/i.test(b.textContent));
    if(vis){vis.click(); await __t(250);}
    ta.scrollIntoView({block:'center'}); await __t(300);
    return true})()`,

  /** SC02: Active 3-question Quick Review interview sheet (waiting state with Fast-Track & radio options). */
  SC02: () => `(async()=>{${SC_PRELUDE}
    const ffItem={
      id:'t_focusflow_q1',
      board:'hermes-pilot',
      status:'blocked',
      bucket:'waiting',
      title:'Q1–Q3: FocusFlow ポモドーロタイマーの設計方針',
      createdAt:Date.now()-180000,
      review:{
        label:'spec-focusflow',
        round:1,
        mode:'standard',
        questions:3,
        title:'Q1–Q3: FocusFlow ポモドーロタイマーの設計方針',
        sheet:'sheets/spec-focusflow-1.json',
        target:'/Users/hajimenakagawa/projects/hermes-mobile-pwa'
      }
    };
    const ffData={
      ok:true,
      data:{
        title:'Q1–Q3: FocusFlow ポモドーロタイマーの設計方針',
        topic:'1行のSpec Seedから抽出した3つの設計分岐',
        questions:[
          {
            id:'Q1',
            text:'25分終了後の5分休憩は自動で開始する？',
            options:[
              {id:'A',label:'手動開始（スタートボタン押下で休憩開始）',recommended:true,detail:'過集中時やキリの良いところまで続けたい場面で勝手に休憩へ切り替わらない'},
              {id:'B',label:'自動開始（00:00 到達と同時に5分休憩へ遷移）',recommended:false,detail:'タップ不要だが画面を見ていない間に休憩が終わるリスクあり'}
            ]
          },
          {
            id:'Q2',
            text:'「今日の完了トマト数」の保存とリセット方式は？',
            options:[
              {id:'A',label:'localStorage に日付キーで保存し翌日自動リセット',recommended:true,detail:'バックエンド不要で日次履歴もそのまま残せる'},
              {id:'B',label:'セッションメモリのみ（リロードでリセット）',recommended:false,detail:'実装は最小だがPWA再起動でカウントが消える'}
            ]
          },
          {
            id:'Q3',
            text:'タイマー終了時の通知方式は？',
            options:[
              {id:'A',label:'画面フラッシュ＋Web Audio合成チャイム＋振動',recommended:true,detail:'外部音源不要でVibe設定（Dopamine/Serotonin）にも連動'},
              {id:'B',label:'画面内の完了バナー表示のみ',recommended:false,detail:'無音環境向きだが別作業中に気づきにくい'}
            ]
          }
        ]
      },
      answer:null
    };
    if(!window.__ffSc02Installed){
      window.__ffSc02Installed=true;
      const orig=window.fetch.bind(window);
      window.fetch=async(url,opts)=>{
        const u=String(url);
        if(/\\/api\\/review(\\?|$)/.test(u)){
          const r=await orig(url,opts);
          const j=await r.clone().json().catch(()=>({items:[]}));
          const others=(j.items||[]).filter((x)=>x.id!=='t_focusflow_q1');
          return __jsonRes({...j,items:[ffItem,...others]});
        }
        if(u.includes('/api/review/t_focusflow_q1/data')) return __jsonRes(ffData);
        return orig(url,opts);
      };
    }
    const refreshBtn=[...document.querySelectorAll('.ak-head-actions button')].pop();
    if(refreshBtn) refreshBtn.click();
    await __t(700);
    window.dispatchEvent(new CustomEvent('hm:open-review',{detail:{taskId:'t_focusflow_q1'}}));
    await __q('.ak-fasttrack, .ak-opt'); await __t(700);
    return true})()`,

  /** SC03: Spec Launchpad showing batches with Execution Mode & Recommended Role expanded. */
  SC03: () => `(async()=>{${SC_PRELUDE}
    if(!__click('.spec-bar')) throw new Error('spec bar not found');
    const body=await __q('.sheet .sheet-body'); await __t(700);
    const batches=[...document.querySelectorAll('.spec-batch')];
    if(!batches.length) throw new Error('no batch in the launchpad');
    const batch=batches.find((b)=>b.querySelector('.spec-mode'))||batches[0];
    const tog=batch.querySelector('.spec-batch-toggle');
    if(tog&&tog.getAttribute('aria-expanded')!=='true'){tog.click(); await __t(500);}
    body.scrollTop=Math.max(0,(batch.getBoundingClientRect().top-body.getBoundingClientRect().top)+body.scrollTop-8);
    await __t(300); return true})()`,

  /** SC04: Live WorkerFeed expanded and scrolled cleanly to the worker heading without clipping above it. */
  SC04: () => `(async()=>{${SC_PRELUDE}
    const boards=await __api('/api/boards');
    const board=((boards.boards||[]).find((b)=>b.current)||(boards.boards||[])[0]||{}).slug;
    if(!board) throw new Error('no board');
    const list=await __api('/api/boards/'+encodeURIComponent(board)+'/tasks?limit=40');
    const tasks=list.tasks||[];
    const target=tasks.find((t)=>t.status==='running')||tasks.find((t)=>/WIKI-3|FocusFlow/i.test(t.title||''))||tasks[0];
    if(!target) throw new Error('no task on '+board);
    window.dispatchEvent(new CustomEvent('hm:open-task',{detail:{board,taskId:target.id}}));
    const body=await __q('.sheet .sheet-body, .split-detail-body'); await __t(1800);
    const workerDet=document.querySelector('details.ak-worker');
    if(workerDet&&!workerDet.open){workerDet.open=true; await __t(500);}
    const head=workerDet||[...document.querySelectorAll('.sheet *, .split-detail-body *')]
      .filter((e)=>e.children.length<=1&&/^(worker|ワーカー|[▼▶]\\s*worker)/i.test((e.textContent||'').trim()))[0];
    if(head){
      let p=head.parentElement;
      while(p&&p!==document.body){
        const st=getComputedStyle(p);
        if(/(auto|scroll)/.test(st.overflowY)&&p.scrollHeight>p.clientHeight+40){
          p.scrollTop=Math.max(0,p.scrollTop+(head.getBoundingClientRect().top-p.getBoundingClientRect().top)-8);
          break;
        }
        p=p.parentElement;
      }
    } else if(body){ body.scrollTop=body.scrollHeight; }
    await __t(400); return true})()`,

  /** SC05: Step 5 red-pen annotation on the BEFORE FocusFlow screen (small top-left timer + top-right Start button). */
  SC05: () => `(async()=>{${SC_PRELUDE}
    const targetId='t_focusflow_anno';
    const ffAnno={
      id:targetId,
      board:'hermes-pilot',
      status:'blocked',
      bucket:'waiting',
      title:'FocusFlow — 残り時間の大きさとスタートボタンの位置',
      createdAt:Date.now()-120000,
      review:{
        label:'focusflow-ui',
        round:1,
        mode:'annotation',
        hasCompare:false,
        title:'FocusFlow — 残り時間の大きさとスタートボタンの位置',
        shot:'shots/focusflow-ui-1.png',
        target:'/Users/hajimenakagawa/projects/hermes-mobile-pwa'
      }
    };
    const beforeUrl=await __drawFocusFlow(false);
    __hookImgSrc(targetId,beforeUrl,beforeUrl);
    if(!window.__ffSc05Installed){
      window.__ffSc05Installed=true;
      const orig=window.fetch.bind(window);
      window.fetch=async(url,opts)=>{
        const u=String(url);
        if(/\\/api\\/review(\\?|$)/.test(u)){
          const r=await orig(url,opts);
          const j=await r.clone().json().catch(()=>({items:[]}));
          const others=(j.items||[]).filter((x)=>x.id!==targetId);
          return __jsonRes({...j,items:[ffAnno,...others]});
        }
        return orig(url,opts);
      };
    }
    const refreshBtn=[...document.querySelectorAll('.ak-head-actions button')].pop();
    if(refreshBtn) refreshBtn.click();
    await __t(700);
    window.dispatchEvent(new CustomEvent('hm:open-review',{detail:{taskId:targetId}}));
    let canvas=null;
    for(let i=0;i<80;i++){canvas=document.querySelector('canvas.ak-anno-canvas');if(canvas&&canvas.width>=300)break;await __t(150);}
    if(!canvas||canvas.width<300) throw new Error('annotation canvas never sized');
    await __t(600);
    for(let i=0;i<6;i++){const u=[...document.querySelectorAll('.ak-anno-tool')].find((x)=>/戻す|Undo/i.test(x.getAttribute('aria-label')||''));if(u)u.click();await __t(80);}
    const pick=(re)=>{const b=[...document.querySelectorAll('.ak-anno-tool')].find((x)=>re.test(x.getAttribute('aria-label')||''));if(b)b.click();return !!b};
    const stroke=async(pts)=>{
      const c=document.querySelector('canvas.ak-anno-canvas'); const r=c.getBoundingClientRect();
      const fire=(type,fx,fy)=>c.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:r.left+fx*r.width,clientY:r.top+fy*r.height,pointerId:1,pointerType:'pen',isPrimary:true}));
      fire('pointerdown',pts[0][0],pts[0][1]);
      for(let i=1;i<pts.length;i++){await __t(16);fire('pointermove',pts[i][0],pts[i][1]);}
      const last=pts[pts.length-1]; await __t(16); fire('pointerup',last[0],last[1]); await __t(140);
    };
    if(!pick(/矩形|Rect/i)) throw new Error('rect tool not found'); await __t(350);
    await stroke([[0.05,0.08],[0.18,0.085],[0.30,0.09],[0.30,0.14]]);
    if(!pick(/矢印|Arrow/i)) throw new Error('arrow tool not found'); await __t(350);
    await stroke([[0.80,0.09],[0.80,0.38],[0.64,0.62],[0.50,0.82]]);
    const note=[...document.querySelectorAll('input,textarea')].find((e)=>/ひとこと|optional|note/i.test(e.placeholder||''));
    if(note){
      const proto=note.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(note, ${JSON.stringify(SHOWCASE_SEEDS.ja.annotation)});
      note.dispatchEvent(new Event('input',{bubbles:true}));
    }
    await __t(350); return true})()`,

  /** SC06: Step 6 Before <-> After comparison showing the AFTER screen (large centered 24:12 + bottom Start button) with After pill. */
  SC06: () => `(async()=>{${SC_PRELUDE}
    const targetId='t_focusflow_anno';
    const ffAnno={
      id:targetId,
      board:'hermes-pilot',
      status:'blocked',
      bucket:'waiting',
      title:'FocusFlow — 残り時間の大きさとスタートボタンの位置',
      createdAt:Date.now()-60000,
      review:{
        label:'focusflow-ui',
        round:2,
        mode:'annotation',
        hasCompare:true,
        title:'FocusFlow — 残り時間の大きさとスタートボタンの位置',
        shot:'shots/focusflow-ui-2.png',
        prevShot:'shots/focusflow-ui-1.png',
        target:'/Users/hajimenakagawa/projects/hermes-mobile-pwa'
      }
    };
    const afterUrl=await __drawFocusFlow(true);
    const beforeUrl=await __drawFocusFlow(false);
    __hookImgSrc(targetId,beforeUrl,afterUrl);
    if(!window.__ffSc06Installed){
      window.__ffSc06Installed=true;
      const orig=window.fetch.bind(window);
      window.fetch=async(url,opts)=>{
        const u=String(url);
        if(/\\/api\\/review(\\?|$)/.test(u)){
          const r=await orig(url,opts);
          const j=await r.clone().json().catch(()=>({items:[]}));
          const others=(j.items||[]).filter((x)=>x.id!==targetId);
          return __jsonRes({...j,items:[ffAnno,...others]});
        }
        return orig(url,opts);
      };
    }
    const refreshBtn=[...document.querySelectorAll('.ak-head-actions button')].pop();
    if(refreshBtn) refreshBtn.click();
    await __t(700);
    window.dispatchEvent(new CustomEvent('hm:open-review',{detail:{taskId:targetId}}));
    let canvas=null;
    for(let i=0;i<80;i++){canvas=document.querySelector('canvas.ak-anno-canvas');if(canvas&&canvas.width>=300)break;await __t(150);}
    if(!canvas||canvas.width<300) throw new Error('annotation canvas never sized');
    await __q('.ak-compare-pill'); await __t(600);
    for(let i=0;i<6;i++){const u=[...document.querySelectorAll('.ak-anno-tool')].find((x)=>/戻す|Undo/i.test(x.getAttribute('aria-label')||''));if(u)u.click();await __t(60);}
    const pick=(re)=>{const b=[...document.querySelectorAll('.ak-anno-tool')].find((x)=>re.test(x.getAttribute('aria-label')||''));if(b)b.click();return !!b};
    const stroke=async(pts)=>{
      const c=document.querySelector('canvas.ak-anno-canvas'); const r=c.getBoundingClientRect();
      const fire=(type,fx,fy)=>c.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:r.left+fx*r.width,clientY:r.top+fy*r.height,pointerId:1,pointerType:'pen',isPrimary:true}));
      fire('pointerdown',pts[0][0],pts[0][1]);
      for(let i=1;i<pts.length;i++){await __t(16);fire('pointermove',pts[i][0],pts[i][1]);}
      const last=pts[pts.length-1]; await __t(16); fire('pointerup',last[0],last[1]); await __t(140);
    };
    if(pick(/矩形|Rect/i)){
      await __t(250);
      await stroke([[0.22,0.08],[0.50,0.085],[0.78,0.09],[0.78,0.19]]);
    }
    if(pick(/矢印|Arrow/i)){
      await __t(250);
      await stroke([[0.50,0.21],[0.50,0.45],[0.50,0.65],[0.50,0.78]]);
    }
    await __t(400);
    return true})()`,

  /** SC07: Step 7 Mission Receipt with complete 4/4 FocusFlow KPIs (exact receiptCanvas.js fields). */
  SC07: () => `(async()=>{${SC_PRELUDE}
    if(!window.__ffSc07Installed){
      window.__ffSc07Installed=true;
      const orig=window.fetch.bind(window);
      window.fetch=async(url,opts)=>{
        const u=String(url);
        if(u.includes('/api/telemetry/receipt')){
          const r=await orig(url,opts);
          const j=await r.clone().json().catch(()=>({}));
          return __jsonRes({
            ...j,
            ok:true,
            label:'FocusFlow — ミニマル・ポモドーロ＆タスクタイマー',
            board:'hermes-pilot',
            spec:'docs/SPEC-FOCUSFLOW.md',
            windowHours:24,
            scope:{sessions:4,tasks:4},
            kpi:{
              ...(j.kpi||{}),
              costUsd:0.384,
              cachePct:96.4,
              savedUsd:0.345,
              savedRatio:0.9,
              zeroTypingScore:94,
              tests:42,
              durationMin:14,
              wallDurationMin:16,
              apiCalls:18,
              totalTokens:142800,
              batchesDone:4,
              batchesTotal:4
            }
          });
        }
        return orig(url,opts);
      };
    }
    const btn=[...document.querySelectorAll('.report-card-btn')].find((b)=>/完了レシート|receipt/i.test(b.textContent));
    if(!btn) throw new Error('completion receipt button not found'); btn.click();
    const body=await __q('.sheet .sheet-body'); await __t(3000);
    if(body) body.scrollTop=0; await __t(400);
    return true})()`,

  /** SC08: Step 8 Memos -> Brainstorm populated with the FocusFlow expansion memo and expanded into 4 checklist items. */
  SC08: (lang) => `(async()=>{${SC_PRELUDE}
    __tab(3); await __t(1400);
    const buttons=[...document.querySelectorAll('.memo-card button')].filter((b)=>/ブレスト|brainstorm/i.test(b.textContent||''));
    if(!buttons.length) throw new Error('no brainstorm button in Memos');
    buttons[0].click();
    const ta=await __q('.sheet textarea'); await __t(600);
    if(!ta) throw new Error('brainstorm textarea not found');
    const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    set.call(ta, ${JSON.stringify(SHOWCASE_SEEDS[lang === 'en' ? 'en' : 'ja'].memo)});
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    await __t(350);
    const expand=[...document.querySelectorAll('.sheet button')].find((b)=>/チェックリストに展開|Expand/i.test(b.textContent||''));
    if(expand){expand.click(); await __t(700);}
    return true})()`,

  /** SC09: Step 9 Coherence live diagnostics & Refactor sheet. */
  SC09: () => `(async()=>{${SC_PRELUDE}
    const chip=[...document.querySelectorAll('.snippet-chip.trigger')].find((b)=>/リファクタリング|Refactor/i.test(b.textContent));
    if(!chip) throw new Error('refactor chip not found'); chip.click();
    await __q('.sheet'); await __t(2600);
    return true})()`,
})
