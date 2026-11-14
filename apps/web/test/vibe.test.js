/**
 * Vibe Mode（Dopamine ⇄ Serotonin）と効果音・触覚の検証（SPEC-PILOT-V5 §3.1 / Batch V5-2 受入条件）。
 *
 * 対象: `src/lib/vibe.js`, `src/lib/soundFx.js`, `src/lib/haptic.js`（`hapticPattern` 追加ぶん）
 *
 * 受入条件（SPEC の 4 点）:
 *  - `dopamine` / `serotonin` の切替
 *  - `prefers-reduced-motion` による自動選択
 *  - `Serotonin` でも基本 `haptic` が呼ばれること
 *  - `Combo` カウンタの遷移
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMBO_WINDOW_MS,
  DEFAULT_VIBE,
  HAPTIC_PLAN,
  VIBE_EVENT,
  VIBE_KEY,
  ComboTracker,
  activeCombo,
  applyVibe,
  celebrateAction,
  getVibe,
  initVibe,
  nextComboState,
  normalizeVibe,
  onVibeChange,
  prefersReducedMotion,
  setVibe,
} from '../src/lib/vibe.js'
import {
  MAX_GAIN,
  SOUND_KEY,
  isSoundEnabled,
  playSound,
  resetSoundEngine,
  setSoundEnabled,
  soundPlan,
} from '../src/lib/soundFx.js'
import { hapticPattern, HAPTIC_PATTERNS } from '../src/lib/haptic.js'

/** localStorage 相当。 */
function fakeStorage(init = {}) {
  const map = new Map(Object.entries(init))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    map,
  }
}

/** `<html>` + `window` 相当の最小スタブ。 */
function fakeDom() {
  const events = []
  const el = { dataset: {} }
  return {
    doc: { documentElement: el, el },
    win: {
      dispatchEvent: (e) => {
        events.push(e)
        return true
      },
    },
    events,
    el,
  }
}

/** `window.matchMedia` 相当（matches を固定）。 */
const media = (matches) => () => ({ matches })
/** 端末設定の関数を渡すバージョン（getVibe は関数を受け取れる）。 */
const reduceOn = () => media(true)
const reduceOff = () => media(false)

test('normalizeVibe: 既知の値だけを通し、未知は null', () => {
  assert.equal(normalizeVibe('dopamine'), 'dopamine')
  assert.equal(normalizeVibe('SEROTONIN'), 'serotonin')
  assert.equal(normalizeVibe('  sero '), 'serotonin')
  assert.equal(normalizeVibe('bogus'), null)
  assert.equal(normalizeVibe(null), null)
})

test('getVibe: 保存値が最優先、未保存は dopamine、reduced-motion の端末は serotonin', () => {
  // 未保存 + 端末は動きを減らさない → 既定の dopamine
  assert.equal(getVibe(fakeStorage(), reduceOff()), DEFAULT_VIBE)
  assert.equal(DEFAULT_VIBE, 'dopamine')
  // 未保存 + prefers-reduced-motion: reduce → 自動で serotonin
  assert.equal(getVibe(fakeStorage(), reduceOn()), 'serotonin')
  // 保存値は端末設定に勝つ（ユーザーの明示選択を尊重）
  assert.equal(getVibe(fakeStorage({ [VIBE_KEY]: 'dopamine' }), reduceOn()), 'dopamine')
  assert.equal(getVibe(fakeStorage({ [VIBE_KEY]: 'serotonin' }), reduceOff()), 'serotonin')
  // 壊れた保存値は未保存と同じ扱い
  assert.equal(getVibe(fakeStorage({ [VIBE_KEY]: 'nope' }), reduceOff()), 'dopamine')
  // localStorage が無い/壊れていても落ちない
  assert.equal(getVibe(null, reduceOff()), 'dopamine')
})

test('prefersReducedMotion: MQL・関数・壊れた値・未対応のどれでも真偽を返す', () => {
  assert.equal(prefersReducedMotion({ matches: true }), true)
  assert.equal(prefersReducedMotion({ matches: false }), false)
  assert.equal(prefersReducedMotion(media(true)), true)
  assert.equal(prefersReducedMotion(null), false)
  assert.equal(
    prefersReducedMotion(() => {
      throw new Error('boom')
    }),
    false,
  )
})

test('setVibe: 正規化して保存し、<html data-vibe> を即時更新し、hm:vibe を通知する', () => {
  const s = fakeStorage()
  const { doc, win, events, el } = fakeDom()
  const seen = []
  const off = onVibeChange((m) => seen.push(m))

  assert.equal(setVibe('SEROTONIN', s, doc, win), 'serotonin')
  assert.equal(s.getItem(VIBE_KEY), 'serotonin')
  assert.equal(el.dataset.vibe, 'serotonin')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, VIBE_EVENT)
  assert.deepEqual(events[0].detail, { vibe: 'serotonin' })
  assert.deepEqual(seen, ['serotonin'])

  // 不正値は既定へフォールバック（壊れた値で無装飾のまま放置しない）
  assert.equal(setVibe('bogus', s, doc, win), 'dopamine')
  assert.equal(el.dataset.vibe, 'dopamine')
  off()
  setVibe('dopamine', s, doc, win)
  assert.deepEqual(seen, ['serotonin', 'dopamine'], '解除後は購読者を呼ばない')
})

test('applyVibe: DOM が無くても落ちない（Node / SSR）', () => {
  assert.equal(applyVibe('serotonin', null), 'serotonin')
  assert.equal(applyVibe(undefined, null), DEFAULT_VIBE)
})

test('initVibe: 保存値を適用し、未保存なら端末設定で自動選択する', () => {
  const a = fakeDom()
  const s1 = fakeStorage()
  assert.equal(initVibe({ storage: s1, doc: a.doc, win: a.win, matchMedia: reduceOn() }), 'serotonin')
  assert.equal(a.el.dataset.vibe, 'serotonin')

  const b = fakeDom()
  assert.equal(initVibe({ storage: fakeStorage(), doc: b.doc, win: b.win, matchMedia: reduceOff() }), 'dopamine')
  assert.equal(b.el.dataset.vibe, 'dopamine')

  const c = fakeDom()
  assert.equal(
    initVibe({ storage: fakeStorage({ [VIBE_KEY]: 'serotonin' }), doc: c.doc, win: c.win, matchMedia: reduceOff() }),
    'serotonin',
  )
  assert.equal(c.el.dataset.vibe, 'serotonin')
})

test('nextComboState: 20 秒窓で 1 -> 2 -> 3 と上がり、窓を超えたら 1 に戻る', () => {
  let state = { combo: 0, at: 0 }
  state = nextComboState(state, { vibe: 'dopamine', now: 1000 })
  assert.equal(state.combo, 1)
  state = nextComboState(state, { vibe: 'dopamine', now: 2000 })
  assert.equal(state.combo, 2)
  state = nextComboState(state, { vibe: 'dopamine', now: 3000 })
  assert.equal(state.combo, 3)
  // 窓（20 秒）ちょうどは継続
  state = nextComboState(state, { vibe: 'dopamine', now: 3000 + COMBO_WINDOW_MS })
  assert.equal(state.combo, 4)
  state = nextComboState(state, { vibe: 'dopamine', now: 3000 + COMBO_WINDOW_MS + 1 })
  assert.equal(state.combo, 5)
  // 窓を超えたらリセット（タイムアウトは 0 扱い → 次の操作で 1 から）
  const expiredAt = 3000 + COMBO_WINDOW_MS + 1
  state = nextComboState(state, { vibe: 'dopamine', now: expiredAt + COMBO_WINDOW_MS + 1 })
  assert.equal(state.combo, 1)
  assert.equal(activeCombo(state, { vibe: 'dopamine', now: expiredAt + COMBO_WINDOW_MS + 1 }), 1)
  // 20 秒経つと「いま生きているコンボ」は 0
  assert.equal(activeCombo(state, { vibe: 'dopamine', now: expiredAt + COMBO_WINDOW_MS * 3 }), 0)
})

test('nextComboState / activeCombo: serotonin は常に 0', () => {
  const s = nextComboState({ combo: 5, at: 1000 }, { vibe: 'serotonin', now: 1500 })
  assert.deepEqual(s, { combo: 0, at: 0 })
  assert.equal(activeCombo({ combo: 5, at: 1000 }, { vibe: 'serotonin', now: 1500 }), 0)
})

test('ComboTracker: 時計を注入して遷移を検証できる（切替で 0 に戻る）', () => {
  let now = 10_000
  let vibe = 'dopamine'
  const tracker = new ComboTracker({ vibe: () => vibe, now: () => now })
  assert.equal(tracker.bump('approve'), 1)
  now += 500
  assert.equal(tracker.bump('approve'), 2)
  now += 1000
  assert.equal(tracker.bump('stamp'), 3)
  assert.equal(tracker.combo, 3)
  // タイムアウト
  now += COMBO_WINDOW_MS + 1
  assert.equal(tracker.combo, 0)
  assert.equal(tracker.bump('approve'), 1)
  // Serotonin では連続操作してもコンボにならない
  vibe = 'serotonin'
  assert.equal(tracker.bump('approve'), 0)
  assert.equal(tracker.combo, 0)
  // 戻せば 1 から数え直す
  vibe = 'dopamine'
  assert.equal(tracker.bump('launch'), 1)
  assert.equal(tracker.reset(), 0)
  assert.equal(tracker.combo, 0)
})

test('celebrateAction: Serotonin は基本ハプティックだけ（演出・効果音ゼロ）', () => {
  const haptics = []
  const sounds = []
  const bursts = []
  const result = celebrateAction('allClear', {
    vibe: 'serotonin',
    hapticFn: (k) => haptics.push(k),
    soundFn: (k) => sounds.push(k),
    target: { dispatchEvent: (e) => bursts.push(e) },
  })
  assert.deepEqual(haptics, ['success'], 'Serotonin でも基本ハプティックは必ず残す')
  assert.deepEqual(sounds, [], 'Serotonin では効果音を鳴らさない')
  assert.deepEqual(bursts, [], 'Serotonin ではパーティクルを出さない')
  assert.equal(result.fx, false)
  assert.equal(result.sound, false)

  // tap 系は tap のまま（押した感触を落とさない）
  const taps = []
  celebrateAction('tap', { vibe: 'serotonin', hapticFn: (k) => taps.push(k) })
  assert.deepEqual(taps, ['tap'])
})

test('celebrateAction: Dopamine は多段ハプティック → パーティクル → 効果音の順に発火', () => {
  const order = []
  const pulses = []
  const bursts = []
  const result = celebrateAction('allClear', {
    vibe: 'dopamine',
    combo: 3,
    x: 120,
    y: 240,
    vibrateFn: (p) => {
      order.push('vibrate')
      pulses.push(p)
    },
    hapticFn: () => order.push('haptic'),
    soundFn: (k, o) => {
      order.push(`sound:${k}:${o.combo}`)
      return true
    },
    target: { dispatchEvent: (e) => bursts.push(e) },
  })
  assert.deepEqual(pulses, [[10, 30, 16, 30, 40]], 'allClear は 5 段のバイブ')
  assert.deepEqual(order, ['vibrate', 'sound:allClear:3'])
  assert.equal(bursts.length, 1)
  assert.deepEqual(bursts[0].detail, { kind: 'allClear', combo: 3, x: 120, y: 240 })
  assert.equal(result.fx, true)
  assert.equal(result.sound, true)

  // fastTrack / launch / stamp は success の単発
  const singles = []
  celebrateAction('fastTrack', { vibe: 'dopamine', hapticFn: (k) => singles.push(k) })
  celebrateAction('launch', { vibe: 'dopamine', hapticFn: (k) => singles.push(k) })
  celebrateAction('stamp', { vibe: 'dopamine', hapticFn: (k) => singles.push(k) })
  assert.deepEqual(singles, ['success', 'success', 'success'])
  assert.deepEqual(HAPTIC_PLAN.allClear, [10, 30, 16, 30, 40])
})

test('celebrateAction: 座標が無いイベントでも落ちない（x/y は null）', () => {
  const bursts = []
  celebrateAction('approve', { vibe: 'dopamine', target: { dispatchEvent: (e) => bursts.push(e) } })
  assert.equal(bursts.length, 1)
  assert.deepEqual(bursts[0].detail, { kind: 'approve', combo: 0, x: null, y: null })
})

test('hapticPattern: 多段バイブは hm.haptic=0 で止まり、未対応環境でも落ちない', () => {
  const calls = []
  const nav = { vibrate: (p) => calls.push(p) > 0 }
  const s = fakeStorage()
  assert.equal(hapticPattern([10, 30, 16, 30, 40], nav, s), true)
  assert.deepEqual(calls[0], [10, 30, 16, 30, 40])
  s.setItem('hm.haptic', '0')
  assert.equal(hapticPattern([10, 30], nav, s), false)
  assert.equal(calls.length, 1)
  assert.equal(hapticPattern([10], {}, fakeStorage()), false)
  assert.equal(hapticPattern(null, nav, fakeStorage()), false)
  assert.equal(hapticPattern('noop', nav, fakeStorage()), false)
  assert.deepEqual(HAPTIC_PATTERNS.success, [8, 35, 10])
})

test('soundFx: 効果音トグルは既定 ON で、0 を保存するとミュート', () => {
  const s = fakeStorage()
  assert.equal(isSoundEnabled(s), true)
  setSoundEnabled(false, s)
  assert.equal(s.getItem(SOUND_KEY), '0')
  assert.equal(isSoundEnabled(s), false)
  setSoundEnabled(true, s)
  assert.equal(isSoundEnabled(s), true)
  assert.equal(isSoundEnabled(null), true)
})

test('soundPlan: 承認音は上昇する 2 音（523→784Hz・80ms 級）で、音量は上限以下', () => {
  const approve = soundPlan('approve')
  assert.equal(approve.notes.length, 2)
  assert.equal(approve.notes[0].freq, 523.25)
  assert.equal(approve.notes[1].freq, 783.99)
  assert.ok(approve.notes[0].freq < approve.notes[1].freq)
  assert.equal(approve.notes[0].dur, 0.08)
  assert.ok(approve.gain <= MAX_GAIN)
  assert.ok(approve.total <= 0.5)

  // stamp は approve と同じ設計（赤入れ送信も同じ手触り）
  assert.deepEqual(soundPlan('stamp'), approve)
})

test('soundPlan: コンボ音はコンボ数でピッチが上がる（+2 半音ずつ・上限あり）', () => {
  const one = soundPlan('combo', 1)
  const two = soundPlan('combo', 2)
  const three = soundPlan('combo', 3)
  assert.ok(two.notes[0].freq > one.notes[0].freq)
  assert.ok(three.notes[0].freq > two.notes[0].freq)
  // 長 2 度 = 2^(2/12)
  assert.ok(Math.abs(two.notes[0].freq / one.notes[0].freq - 2 ** (2 / 12)) < 0.01)
  assert.equal(one.notes.length, 3)
})

test('soundPlan: オールクリアは C5-E5-G5-C6 の和音で ~300ms・音量 <= 0.14', () => {
  const plan = soundPlan('allClear')
  assert.deepEqual(
    plan.notes.map((n) => n.freq),
    [523.25, 659.25, 783.99, 1046.5],
  )
  assert.ok(plan.total >= 0.2 && plan.total <= 0.5)
  assert.ok(plan.gain <= MAX_GAIN)
  for (const n of plan.notes) assert.ok(n.gain <= MAX_GAIN)
  assert.deepEqual(soundPlan('receipt'), plan)
})

test('playSound: AudioContext 非対応・ミュートは no-op（例外を投げない）', () => {
  resetSoundEngine()
  const s = fakeStorage()
  assert.equal(playSound('approve', { storage: s, AudioContext: undefined }), false)
  // ミュート中は AudioContext を作らない
  s.setItem(SOUND_KEY, '0')
  let constructed = 0
  const Spy = function () {
    constructed += 1
  }
  assert.equal(playSound('approve', { storage: s, AudioContext: Spy }), false)
  assert.equal(constructed, 0)
})

test('playSound: 対応環境ではオシレータを作って鳴らし、コンテキストは使い回す', () => {
  resetSoundEngine()
  const made = []
  const started = []
  function FakeAudioContext() {
    this.currentTime = 1
    this.state = 'suspended'
    this.resumed = 0
    this.destination = {}
    this.createOscillator = () => {
      const osc = {
        type: '',
        frequency: { setValueAtTime: () => {} },
        connect: () => {},
        start: (at) => started.push(at),
        stop: () => {},
      }
      made.push(osc)
      return osc
    }
    this.createGain = () => ({
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: () => {},
    })
    this.resume = () => {
      this.resumed += 1
      this.state = 'running'
      return Promise.resolve()
    }
    this.close = () => {}
  }

  const s = fakeStorage()
  assert.equal(playSound('approve', { storage: s, AudioContext: FakeAudioContext }), true)
  assert.equal(made.length, 2, '2 音ぶんのオシレータ')
  assert.equal(started.length, 2)
  assert.equal(made[0].type, 'triangle')
  assert.equal(made[1].type, 'sine')

  // 2 回目は同じコンテキストを使う（iOS の制限対策）
  assert.equal(playSound('allClear', { storage: s, AudioContext: FakeAudioContext }), true)
  assert.equal(made.length, 6, '2 + 4 音')
  resetSoundEngine()
})

test('playSound: 壊れた AudioContext でも演奏中の例外を握りつぶす', () => {
  resetSoundEngine()
  class Broken {
    get currentTime() {
      throw new Error('broken')
    }
  }
  assert.equal(playSound('approve', { storage: fakeStorage(), AudioContext: Broken }), false)
  resetSoundEngine()
})
