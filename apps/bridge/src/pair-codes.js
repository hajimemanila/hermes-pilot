import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from './lib/atomic.js'

/**
 * ワンタイム・ペアリングコード（SPEC §8.2 の `?pair=<one-time token>`）。
 *
 * アプリトークン（256-bit hex = 64 文字）をそのまま URL に載せると
 * QR が高密度になり、端末（80x24）に出すと行が溢れてカメラが読めない。
 * ここでは短い使い捨てコード（既定 8 文字）を発行し、認証は
 * 「コード → セッション Cookie」の交換として扱う（1 回使ったら失効）。
 *
 * 保存はハッシュのみ（`pair-codes.json`, 0600）。平文コードは発行時にしか存在しない。
 *
 * @param {object} cfg 設定（`dataDir` を使う）
 * @param {object} [opts] 差し替え
 * @param {number} [opts.ttlMs] 有効期間（既定 10 分）
 * @param {number} [opts.max] 同時に保持する最大件数（既定 20）
 * @param {() => number} [opts.now] 時刻（テスト用）
 * @returns {object} 発行・消費
 */
export function createPairCodes(cfg, { ttlMs = 10 * 60 * 1000, max = 20, now = Date.now } = {}) {
  const file = path.join(cfg.dataDir, 'pair-codes.json')
  // 0/O/1/I/l/o など紛らわしい文字を除く（手入力の取り違え防止）
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

  const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex')

  /** @returns {Record<string, {expires: number, created: number}>} */
  const load = () => {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      return j?.codes && typeof j.codes === 'object' ? j.codes : {}
    } catch {
      return {}
    }
  }

  const save = (codes) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      writeJsonAtomic(file, { version: 1, codes }, { pretty: 0 })
    } catch {
      /* 保存に失敗しても発行済みのコードはこのプロセス内有効（認証は止めない） */
    }
  }

  /** 期限切れを落とす。 */
  const prune = (codes, at) => {
    let changed = false
    for (const [k, v] of Object.entries(codes)) {
      if (!v || !(Number(v.expires) > at)) {
        delete codes[k]
        changed = true
      }
    }
    return changed
  }

  return {
    /**
     * 短いコードを発行する。
     * @param {number} [length] 文字数（既定 8）
     * @returns {{code: string, expiresAt: number}} コードと失効時刻
     */
    mint(length = 8) {
      const at = now()
      const codes = load()
      prune(codes, at)
      // 溢れたら古いものから捨てる
      const keys = Object.keys(codes)
      if (keys.length >= max) {
        keys
          .sort((a, b) => Number(codes[a]?.created ?? 0) - Number(codes[b]?.created ?? 0))
          .slice(0, keys.length - max + 1)
          .forEach((k) => delete codes[k])
      }
      let code = ''
      do {
        code = Array.from(crypto.randomBytes(length))
          .map((b) => ALPHABET[b % ALPHABET.length])
          .join('')
      } while (codes[hash(code)])
      const expiresAt = at + ttlMs
      codes[hash(code)] = { created: at, expires: expiresAt }
      save(codes)
      return { code, expiresAt }
    },

    /**
     * コードを使う（1 回限り）。成功したら true。
     * @param {string} given 入力コード（大文字小文字は問わない）
     * @returns {boolean} 有効だったか
     */
    consume(given) {
      const code = String(given ?? '').trim().toUpperCase()
      if (code.length < 6 || code.length > 16) return false
      if (!/^[A-Z0-9]+$/.test(code)) return false
      const at = now()
      const codes = load()
      const key = hash(code)
      const rec = codes[key]
      if (!rec || !(Number(rec.expires) > at)) {
        if (rec) {
          delete codes[key]
          save(codes)
        }
        return false
      }
      delete codes[key]
      save(codes)
      return true
    },

    /** 未使用コードの件数（診断用。値は返さない）。 */
    pending() {
      const at = now()
      const codes = load()
      const live = Object.values(codes).filter((v) => v && Number(v.expires) > at).length
      return live
    },
  }
}
