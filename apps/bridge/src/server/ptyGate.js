/**
 * PTY の枯渇を「一度きりの事故」で終わらせないための門番（`/ws/term` の前段）。
 *
 * 実測（2026-11-23）: 端末 WS は開くが `pty.spawn` が
 * `posix_spawnp failed.` で落ち、クライアントは open → resize → close(1011) を繰り返していた。
 * 原因は PTY の上限超過（`/dev/ptmx` が ENXIO）で、しかも **ネイティブの失敗経路は
 * master fd を解放しない**（node-pty 1.1.0 の `pty_posix_spawn` は失敗時に `*master` を閉じない）。
 * つまり 1 回失敗するたびに 1 本ずつ漏れ、再接続のたびに悪化する自己増殖ループになる
 * （実測: 6 時間で 312 本。`kern.tty.ptmx_max` は 511）。
 *
 * そこで spawn の前に `/dev/ptmx` が開けるかを 1 回だけ確かめ、開けなければ spawn を呼ばない
 * （＝漏らさない）。失敗後は短いクールダウンを置き、再接続の嵐でも試行回数が増えないようにする。
 */

import fs from 'node:fs'

/** 端末の多重化デバイス（macOS / Linux 共通）。 */
export const PTMX_PATH = '/dev/ptmx'

/** 失敗後に spawn を試さない時間。クライアントの再接続（1s→最大15s）より短くしない。 */
export const DEFAULT_COOLDOWN_MS = 15_000

/**
 * 門番を作る。`openImpl` / `closeImpl` / `now` はテスト用の差し込み口。
 * @param {{openImpl?: (path: string) => number, closeImpl?: (fd: number) => void, now?: () => number, cooldownMs?: number}} [opts]
 */
export function createPtyGate({ openImpl, closeImpl, now = Date.now, cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const open = openImpl ?? ((path) => fs.openSync(path, fs.constants.O_RDWR))
  const close = closeImpl ?? ((fd) => fs.closeSync(fd))
  let cooldownUntil = 0
  let lastError = ''

  /**
   * `/dev/ptmx` を開いてすぐ閉じる（PTY を 1 本作れるかの下見。master は残さない）。
   * @returns {{ok: true} | {ok: false, reason: 'ptmx', code: string, message: string}}
   */
  function probe() {
    let fd
    try {
      fd = open(PTMX_PATH)
    } catch (err) {
      return { ok: false, reason: 'ptmx', code: String(err?.code ?? ''), message: String(err?.message ?? err) }
    }
    try {
      close(fd)
    } catch {
      /* 閉じ損ねても致命的ではない */
    }
    return { ok: true }
  }

  return {
    /**
     * この接続で spawn を試してよいか。駄目なら理由を返す（呼び手は spawn しない）。
     * @returns {{ok: true} | {ok: false, reason: 'cooldown' | 'ptmx', code: string, message: string}}
     */
    attempt() {
      if (now() < cooldownUntil) {
        return { ok: false, reason: 'cooldown', code: 'EBUSY', message: lastError }
      }
      const p = probe()
      if (!p.ok) {
        lastError = `${p.code || 'EUNKNOWN'}: ${p.message}`
        cooldownUntil = now() + cooldownMs
      }
      return p
    },
    /**
     * spawn 自体が例外を投げたときの後始末（下見は通ったのに落ちた場合）。
     * @param {unknown} err
     */
    failed(err) {
      lastError = String(/** @type {{message?: string}} */ (err)?.message ?? err)
      cooldownUntil = now() + cooldownMs
    },
    /** spawn に成功した。クールダウンを解除する。 */
    ok() {
      cooldownUntil = 0
      lastError = ''
    },
    /** 表示・テスト用の現在値。 */
    get state() {
      return { cooldownUntil, lastError, cooling: now() < cooldownUntil }
    },
  }
}

/**
 * 端末へ出す説明文（1 行・PTY が無い理由と次の一手）。
 * **英語で書く**: 端末へ流す行は実行時出力なので D71（`docs/SPEC-EN-ZERO-LEAK.md`）の対象。
 * @param {{reason: string, code?: string, message?: string}} verdict
 * @returns {string}
 */
export function ptyUnavailableLine(verdict) {
  const detail = [verdict.code, verdict.message].filter(Boolean).join(': ')
  if (verdict.reason === 'ptmx') {
    return `PTY unavailable (${detail || 'ptmx'}). The host has run out of PTYs (leaked terminal sessions) — restart the bridge to release them.`
  }
  return `PTY unavailable: the last spawn failed (${detail || 'unknown'}). Retrying shortly.`
}

/**
 * node-pty 1.1.0 の darwin `pty_posix_spawn` は 1 回の spawn で最小の空き fd を 3 つ順に消費する:
 *   1. `low_fds[0] = posix_openpt(O_RDWR)`（`>=3` で即 break するため `count=0` のまま閉じられない）
 *   2. `*master = posix_openpt(O_RDWR)`（`proc._fd`）
 *   3. `slave = open(slave_pty_name, ...)`（親プロセス側で閉じられない）
 * spawn 直前に最小の空き fd 3 つ（`[f0, f1, f2]`）を観測して閉じ、spawn 直後に
 * `proc._fd === f1` が一致したときだけ `f0`（未使用 master）と `f2`（親側 slave）を回収して
 * セッションあたりの ptmx リークを 0 本にする。
 *
 * @param {{platform?: string, openImpl?: (p: string) => number, closeImpl?: (fd: number) => void}} [opts]
 * @returns {[number, number, number]|null}
 */
export function reserveDarwinSpawnSlots({ platform = process.platform, openImpl, closeImpl } = {}) {
  if (platform !== 'darwin') return null
  const open = openImpl ?? ((p) => fs.openSync(p, fs.constants.O_RDONLY))
  const close = closeImpl ?? ((fd) => fs.closeSync(fd))
  const fds = []
  try {
    for (let i = 0; i < 3; i += 1) fds.push(open('/dev/null'))
    return [fds[0], fds[1], fds[2]]
  } catch {
    return null
  } finally {
    for (let i = fds.length - 1; i >= 0; i -= 1) {
      try {
        close(fds[i])
      } catch {
        /* noop */
      }
    }
  }
}

/**
 * `reserveDarwinSpawnSlots` で観測した 3 スロットと実 `masterFd`（`proc._fd`）を照合し、
 * 一致したときだけ漏れた `low_fds[0]` と親側 `slave` を閉じる。
 *
 * @param {[number, number, number]|null} slots 事前観測した 3 つの空き fd
 * @param {unknown} masterFd `proc._fd`
 * @param {{closeImpl?: (fd: number) => void}} [opts]
 * @returns {{reclaimed: number}}
 */
export function reclaimDarwinSpawnLeak(slots, masterFd, { closeImpl } = {}) {
  if (!Array.isArray(slots) || slots.length !== 3) return { reclaimed: 0 }
  const [lowFd, expectedMaster, slaveFd] = slots
  if (typeof masterFd !== 'number' || masterFd !== expectedMaster) return { reclaimed: 0 }
  const close = closeImpl ?? ((fd) => fs.closeSync(fd))
  let reclaimed = 0
  for (const fd of [lowFd, slaveFd]) {
    try {
      close(fd)
      reclaimed += 1
    } catch {
      /* noop */
    }
  }
  return { reclaimed }
}
