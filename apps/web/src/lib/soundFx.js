/**
 * Web Audio API の合成効果音（外部ファイル・外部依存ゼロ）。SPEC-PILOT-V5 §3.1 / D24
 *
 * 方針:
 * - 音源ファイルを一切持たない。`OscillatorNode` + `GainNode` の短いエンベロープだけで作る
 *   （iOS Safari でも動く。Autoplay 制限はユーザー操作ハンドラ内の `ctx.resume()` で解除する）
 * - `AudioContext` 非対応環境は **no-op**（例外を投げない）。音が出ないだけで操作は続く
 * - 音量は `MAX_GAIN` 以下に固定する（耳障りにしない）
 * - どの音を鳴らすかは純関数 `soundPlan()` が返す。テストはこれを直接検証する
 *   （`AudioContext` を作らずに音の設計を確かめられる）
 *
 * 保存キー: `hm.sound`（既定 `'1'` = ON、`'0'` でミュート）。設定タブの効果音スイッチが書く。
 */

import { HM_STORAGE } from '../contracts/storage.js'

/** `localStorage` のキー。 */
export const SOUND_KEY = HM_STORAGE.SOUND

/** 1 音あたりの上限ゲイン。合計が大きくならないよう控えめにする。 */
export const MAX_GAIN = 0.14

/** 使う音階（平均律・A4=440）。 */
export const NOTES = {
  C5: 523.25,
  D5: 587.33,
  E5: 659.25,
  G5: 783.99,
  A5: 880.0,
  C6: 1046.5,
}

/** localStorage が無い/壊れている環境でも落ちない取得。 */
function safeStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * 効果音が有効か。既定 ON（`'0'` が保存されているときだけ OFF）。
 * @param {{getItem: Function}} [storage]
 * @returns {boolean}
 */
export function isSoundEnabled(storage = safeStorage()) {
  try {
    return storage?.getItem(SOUND_KEY) !== '0'
  } catch {
    return true
  }
}

/**
 * 効果音の ON/OFF を保存する。
 * @param {boolean} enabled
 * @param {{setItem: Function}} [storage]
 * @returns {boolean} 保存後の状態
 */
export function setSoundEnabled(enabled, storage = safeStorage()) {
  const on = Boolean(enabled)
  try {
    storage?.setItem(SOUND_KEY, on ? '1' : '0')
  } catch {
    /* 保存できなくても表示は切り替える */
  }
  return on
}

/**
 * コンボ数に応じた半音シフト（`+2` 半音 / 1 コンボ、上限 1 オクターブ）。
 * @param {number} combo
 * @returns {number} 周波数の倍率
 */
export function comboShift(combo) {
  const n = Math.max(1, Math.min(7, Math.floor(Number(combo) || 1)))
  return 2 ** (((n - 1) * 2) / 12)
}

/**
 * 鳴らす音の設計図を作る（純関数）。
 *
 * @param {string} [kind] `approve` / `stamp` / `launch` / `combo` / `allClear` / `receipt` / `tap`
 * @param {number} [combo] 連続操作コンボ数（`combo` のピッチにだけ効く）
 * @returns {{notes: {freq: number, at: number, dur: number, type: string, gain: number}[], total: number, gain: number}}
 */
export function soundPlan(kind = 'tap', combo = 1) {
  const note = (freq, at, dur, type = 'triangle', gain = 0.1) => ({
    freq: Number(freq.toFixed(2)),
    at: Number(at.toFixed(3)),
    dur,
    type,
    gain: Math.min(MAX_GAIN, gain),
  })

  let notes
  switch (kind) {
    case 'send':
      // チャット送信: 軽やかな上昇ジップ（~80ms、音量控えめ）
      notes = [note(NOTES.E5, 0, 0.045, 'sine', 0.065), note(NOTES.G5, 0.03, 0.05, 'sine', 0.055)]
      break
    case 'approve':
    case 'stamp':
      // 上昇系のデュアルクリック（~80ms ずつ、523Hz → 784Hz）
      notes = [note(NOTES.C5, 0, 0.08, 'triangle', 0.1), note(NOTES.G5, 0.05, 0.08, 'sine', 0.1)]
      break
    case 'launch':
      // 3 音の上昇（バッチ起票）
      notes = [
        note(NOTES.C5, 0, 0.08, 'triangle', 0.1),
        note(NOTES.E5, 0.045, 0.08, 'triangle', 0.1),
        note(NOTES.G5, 0.09, 0.1, 'sine', 0.1),
      ]
      break
    case 'combo': {
      // ピッチ上昇アルペジオ（コンボ数に応じて +2 半音ずつ）
      const k = comboShift(combo)
      notes = [
        note(NOTES.C5 * k, 0, 0.07, 'sine', 0.09),
        note(NOTES.E5 * k, 0.045, 0.07, 'sine', 0.09),
        note(NOTES.G5 * k, 0.09, 0.08, 'sine', 0.09),
      ]
      break
    }
    case 'allClear':
    case 'receipt':
      // 和音ファンファーレ（C5-E5-G5-C6 の軽いシンセパッド、~300ms）
      notes = [
        note(NOTES.C5, 0, 0.16, 'triangle', 0.11),
        note(NOTES.E5, 0.05, 0.16, 'sine', 0.11),
        note(NOTES.G5, 0.1, 0.16, 'sine', 0.11),
        note(NOTES.C6, 0.15, 0.18, 'sine', 0.1),
      ]
      break
    default:
      notes = [note(NOTES.C5, 0, 0.05, 'triangle', 0.06)]
  }

  const total = notes.reduce((acc, n) => Math.max(acc, n.at + n.dur), 0)
  const gain = notes.reduce((acc, n) => Math.max(acc, n.gain), 0)
  return { notes, total: Number(total.toFixed(3)), gain: Math.min(MAX_GAIN, gain) }
}

/** 使い回す `AudioContext`（ユーザー操作のたびに作ると iOS で失敗する）。 */
let engineCtx = null

/**
 * 効果音を鳴らす。無効・非対応・失敗はすべて `false`（例外は投げない）。
 *
 * @param {string} kind 音の種類（`soundPlan` と同じ）
 * @param {{combo?: number, storage?: object, AudioContext?: Function}} [opts]
 * @returns {boolean} 鳴らしたか
 */
export function playSound(kind, opts = {}) {
  if (!isSoundEnabled(opts.storage ?? safeStorage())) return false
  const Ctor = opts.AudioContext ?? globalThis.AudioContext ?? globalThis.webkitAudioContext
  if (typeof Ctor !== 'function') return false
  try {
    if (!engineCtx) engineCtx = new Ctor()
    const ctx = engineCtx
    // Autoplay 制限: ユーザー操作ハンドラから呼ばれるので resume() だけで足りる
    let resumePromise = null
    if (typeof ctx.resume === 'function') {
      try {
        const p = ctx.resume()
        if (p && typeof p.then === 'function') {
          resumePromise = p
          if (typeof p.catch === 'function') p.catch(() => {})
        }
      } catch {
        /* resume できない環境は無音のまま */
      }
    }
    const plan = soundPlan(kind, opts.combo)
    const schedule = () => {
      const t0 = Number(ctx.currentTime) || 0
      for (const n of plan.notes) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = n.type
        osc.frequency.setValueAtTime(n.freq, t0 + n.at)
        gain.gain.setValueAtTime(0.0001, t0 + n.at)
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, n.gain), t0 + n.at + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(t0 + n.at)
        osc.stop(t0 + n.at + n.dur + 0.02)
      }
    }
    // 実機では resume() 完了前に start() すると先頭の音が途切れるため、まだ suspended なら完了後に鳴らす
    if (ctx.state === 'suspended' && resumePromise) {
      resumePromise.then(schedule, () => {})
    } else {
      schedule()
    }
    return true
  } catch {
    return false
  }
}

/** テスト用: 使い回している `AudioContext` を捨てる。 */
export function resetSoundEngine() {
  try {
    engineCtx?.close?.()
  } catch {
    /* 閉じられなくても参照は捨てる */
  }
  engineCtx = null
}

/** @returns {'idle'|'ready'} 現在のエンジン状態（診断用） */
export function soundEngineState() {
  return engineCtx ? 'ready' : 'idle'
}
