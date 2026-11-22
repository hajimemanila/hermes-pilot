/**
 * Review のメディア / ライブラリ API（画像・注釈・target 解決・ライブラリ）。
 * `review.js` の `createReview` から分割した。「ctx」で閉包のヘルパを受け取り、公開契約は
 * `review.js` が組み立てる（呼び出し側の API 形は変えない）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readTailText } from '../tail.js'
import { outputOf } from '../lib/cli.js'
import { parseReviewLine } from './parse.js'
import { opsText } from './text.js'
import { writeFileAtomic, writeJsonAtomic } from '../lib/atomic.js'

export function createReviewMedia(ctx = {}) {
  const {
    opts,
    workdir,
    resolveInside,
    readJsonIfExists,
    bodyOf,
    siblingIndex,
    compareRelOf,
    rememberTaskChat,
    openDb,
    runKanban,
    transitions,
  } = ctx

  function thumb(rel) {
    const s = String(rel || '')
    if (!s.startsWith('thumbs/') || !/\.(png|jpe?g|webp)$/i.test(s)) {
      return { ok: false, code: 'BAD_THUMB' }
    }
    const abs = resolveInside(s)
    if (!abs) return { ok: false, code: 'THUMB_MISSING' }
    const ext = path.extname(abs).toLowerCase()
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return { ok: true, data: fs.readFileSync(abs), type }
  }


  /** 注釈の下地画像（annotated=true なら赤入れ済み、compare=true なら前回の赤入れ）。 */
  function image(id, opts = {}) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.image) return { ok: false, code: 'NO_IMAGE' }
    let rel = ak.image
    if (opts?.compare) {
      // 比較（Before）: 前回の赤入れ／前ラウンドの画像。無ければ 404 で UI がトグルを隠す
      const cmp = compareRelOf(id, ak, siblingIndex())
      if (!cmp) return { ok: false, code: 'NO_COMPARE' }
      rel = cmp
    } else if (opts?.annotated) {
      const jsonAbs = resolveInside(ak.image.replace(/\.(png|jpe?g)$/i, '.annotation.json'))
      const data = jsonAbs ? readJsonIfExists(jsonAbs) : null
      if (data?.annotated_image) rel = data.annotated_image
    }
    const abs = resolveInside(rel)
    if (!abs) return { ok: false, code: 'IMAGE_MISSING' }
    const ext = path.extname(abs).toLowerCase()
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return { ok: true, data: fs.readFileSync(abs), type, path: abs, rel }
  }

  /** 送信済みの注釈（無ければ null）。 */
  function annotation(id) {
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.image) return { ok: false, code: 'NO_IMAGE' }
    const rel = ak.image.replace(/\.(png|jpe?g)$/i, '.annotation.json')
    const abs = resolveInside(rel)
    const data = abs ? readJsonIfExists(abs) : null
    if (!data) return { ok: false, code: 'NO_ANNOTATION' }
    return { ok: true, data, status: b.status }
  }

  /**
   * 注釈の送信。annotated_image は data URL（JPEG/PNG）。
   * 冪等: 同じ画像（sha256）の再送は duplicate を返し、遷移だけ補完する。
   *
   * @param {string} id タスク ID
   * @param {{annotated_image?: string, marks?: Array, note?: string, by?: string}} payload
   * @param {'ja'|'en'} [lang] 運用 1 行の言語（既定 en）
   */
  async function saveAnnotation(id, payload, lang = 'en') {
    const ops = opsText(lang)
    const b = bodyOf(id)
    if (!b) return { ok: false, code: 'NOT_FOUND' }
    const ak = parseReviewLine(b.body)
    if (!ak?.image) return { ok: false, code: 'NO_IMAGE' }
    if (!transitions.canApply('annotation.fresh', b.status)) {
      return { ok: false, code: 'NOT_WAITING', status: b.status, params: { status: b.status } }
    }
    if (payload?.chat) rememberTaskChat(id, payload.chat)

    const raw = String(payload?.annotated_image || '')
    const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(raw)
    if (!m) return { ok: false, code: 'BAD_IMAGE' }
    const buf = Buffer.from(m[2], 'base64')
    const MAX = 12 * 1024 * 1024
    if (buf.length > MAX) return { ok: false, code: 'TOO_LARGE' }

    const baseAbs = resolveInside(ak.image)
    if (!baseAbs) return { ok: false, code: 'IMAGE_MISSING' }
    const sha = crypto.createHash('sha256').update(buf).digest('hex')
    const baseSha = crypto.createHash('sha256').update(fs.readFileSync(baseAbs)).digest('hex')
    const ext = m[1] === 'image/png' ? '.png' : '.jpg'
    const relAnnotated = ak.image.replace(/\.(png|jpe?g)$/i, `.annotated${ext}`)
    const relJson = ak.image.replace(/\.(png|jpe?g)$/i, '.annotation.json')
    const annotatedAbs = path.join(path.resolve(workdir(), relAnnotated))
    const jsonAbs = path.join(path.resolve(workdir(), relJson))

    const existing = readJsonIfExists(jsonAbs)
    if (existing && existing.image_sha256 === sha) {
      // 冪等: 同じ画像の再送は保存をやり直さず、遷移だけ補完する（transitions 側で no-op 判定）
      const moved = await transitions.apply('annotation.again', { id, reason: ops.annotationReceivedAgain })
      const status = moved.code === 0 ? moved.status || b.status : b.status
      return { ok: moved.code === 0, duplicate: true, status, moved: status, sha256: sha }
    }

    const marks = Array.isArray(payload?.marks) ? payload.marks.slice(0, 200) : []
    const note = String(payload?.note ?? '').slice(0, 2000)
    writeFileAtomic(annotatedAbs, buf)
    const record = {
      task_id: id,
      label: ak.label ?? null,
      round: Number(ak.round ?? 1),
      note,
      marks: marks.map((k) => ({
        tool: String(k?.tool ?? 'pen'),
        points: Array.isArray(k?.points) ? k.points.slice(0, 400) : [],
      })),
      base_image: ak.image,
      annotated_image: relAnnotated,
      base_sha256: baseSha,
      image_sha256: sha,
      annotated_at: new Date().toISOString(),
    }
    writeJsonAtomic(jsonAbs, record)

    const summary = ops.annotationSummary(marks.length, note ? note.slice(0, 60) : '', relAnnotated)
    const comment = await runKanban(['comment', id, summary, '--author', String(payload?.by ?? 'mobile')])
    const moved = await transitions.apply('annotation.fresh', { id, reason: ops.annotationReceived })
    const status = moved.code === 0 ? moved.status || b.status : b.status
    return {
      ok: comment.code === 0 && moved.code === 0,
      duplicate: false,
      sha256: sha,
      files: { annotated: relAnnotated, json: relJson },
      marks: marks.length,
      status,
      moved: status,
      output: `${outputOf(comment)}\n${moved.out}`.trim().slice(0, 600),
    }
  }



  /**
   * 注釈の反映先として選べるリポジトリ（`repos.list()` が唯一の一覧）。
   * 自由入力は受けない（存在しないパスへ誤って起票しないため）。
   */
  function targets() {
    const list = typeof opts.targets === 'function' ? opts.targets() : []
    if (!Array.isArray(list)) return []
    const out = []
    for (const r of list) {
      const abs = String(r?.path ?? '')
      const id = String(r?.id ?? '').trim()
      if (!abs || !id) continue
      out.push({ id, label: String(r.label ?? id), path: abs })
    }
    return out
  }

  /** target を登録済みリポジトリに解決する（未登録なら null）。 */
  function resolveTarget(raw) {
    const list = targets()
    if (!list.length) return null
    const want = raw ? path.resolve(String(raw).replace(/^~/, os.homedir())) : null
    if (want) return list.find((x) => x.path === want) || null
    return list.find((x) => x.id === 'hermes-mobile-pwa') || list[0]
  }

  /**
   * 反映先パス → 登録済みリポジトリ（**最長一致**）。
   *
   * macOS は大文字小文字を区別しないので比較は小文字で行う（実測: ボードの
   * `target=` は `~/projects/hermes-mobile-pwa` と `~/Projects/hermes-mobile-pwa`
   * が混在している）。`~/.hermes` のような広いリポジトリがあるため、短い一致で
   * 打ち切らず最長一致を採る。
   */
  function repoForTarget(target) {
    const raw = String(target || '')
    if (!raw || !(raw.startsWith('/') || raw.startsWith('~'))) return null
    const abs = path.resolve(raw.replace(/^~/, os.homedir())).toLowerCase()
    let best = null
    for (const t of targets()) {
      const p = t.path.toLowerCase()
      if (abs !== p && !abs.startsWith(p + path.sep)) continue
      if (!best || p.length > best.p.length) best = { id: t.id, label: t.label, p }
    }
    return best ? { id: best.id, label: best.label } : null
  }

  /**
   * 画像 → 反映先リポジトリの手掛かり。
   *
   * 画像そのものにリポジトリ情報は無い（library の名前は取得時刻と slug だけ）。
   * レビューのタスク本文 `[review] label=… image=shots/x.png target=<path>` の対応を集め、
   * `image=` の完全一致 → `label=` の前方一致の順で当てる。撮影名は
   * `<label>-<stamp>-<round>.<kind>.png`（実測 33 枚中 27 枚がこれで解決）。
   */
  function imageRepos() {
    const byImage = new Map()
    const byLabel = new Map()
    let db
    try {
      db = openDb()
    } catch {
      return { byImage, labels: [] }
    }
    let rs = []
    try {
      rs = db.prepare("SELECT body FROM tasks WHERE body LIKE '%[review]%' OR body LIKE '%[akapen]%'").all()
    } catch {
      rs = []
    } finally {
      db.close()
    }
    for (const r of rs) {
      const ak = parseReviewLine(r.body)
      if (!ak?.target) continue
      if (ak.image) byImage.set(String(ak.image), ak.target)
      if (ak.label) byLabel.set(String(ak.label), ak.target)
    }
    // ラベルは丸ごと一致しないことが多い（`sheet-form` の撮影名に対し
    // タスクは `sheet-form-202611121013`）。ハイフン境界で切った前方部分も候補にする。
    const labels = []
    for (const [label, target] of byLabel) {
      const parts = label.split('-')
      const seen = new Set()
      for (let i = parts.length; i >= 2; i--) {
        const cand = parts.slice(0, i).join('-')
        if (seen.has(cand)) continue
        seen.add(cand)
        labels.push([cand, target])
      }
    }
    labels.sort((a, b) => b[0].length - a[0].length)
    return { byImage, labels }
  }

  /** 撮影名から target を引く（ハイフン境界だけを見る。部分文字列の誤爆を避ける）。 */
  function labelTarget(name, labels) {
    const ext = path.extname(name)
    for (const [label, target] of labels) {
      if (
        name === `${label}${ext}` ||
        name === label ||
        name.startsWith(`${label}-`) ||
        name.startsWith(`${label}.`) ||
        name.includes(`-${label}-`) ||
        name.includes(`-${label}.`)
      ) {
        return target
      }
    }
    return null
  }

  /** 注釈の下地にできる画像（library/** と shots/*.png|jpg、注釈済みは除く）。 */
  function library(limit = 60) {
    const root = workdir()
    const items = []
    const { byImage, labels } = imageRepos()
    const exts = new Set(['.png', '.jpg', '.jpeg', '.webp'])
    const walk = (dir, source) => {
      let ents = []
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of ents) {
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) {
          walk(abs, source || e.name)
          continue
        }
        const ext = path.extname(e.name).toLowerCase()
        if (!exts.has(ext) || /\.(annotated|answer)\./.test(e.name)) continue
        let st
        try {
          st = fs.statSync(abs)
        } catch {
          continue
        }
        const rel = path.relative(root, abs)
        const target = byImage.get(rel) || labelTarget(e.name, labels)
        items.push({
          path: rel,
          source: source || (rel.startsWith('shots') ? 'capture' : 'library'),
          name: e.name,
          bytes: st.size,
          // 取得日時: 一覧の並びもこれ。library への取り込みは copy2 なので
          // 元画像の撮影時刻が残る（実測: chat の取り込み 1746 のファイルが 16:42）
          mtime: Math.round(st.mtimeMs),
          repo: repoForTarget(target), // 分からなければ null（UI は '—'）
          target: target || null,
        })
      }
    }
    walk(path.join(root, 'library'), '')
    walk(path.join(root, 'shots'), 'capture')
    items.sort((a, b) => b.mtime - a.mtime)
    return items.slice(0, limit)
  }

  /**
   * 作業フィード（内蔵 reviewWatcher が書く 1 行ログ）。
   *
   * 旧来は外部 cron（`mobile-akapen-watch`）が Discord と `plugin-data/akapen/feed.jsonl` を
   * 書いていた。D7 でブリッジ内蔵の `reviewWatcher` に移し、`review/feed.jsonl` をここから読む。
   *
   * @param {number} [limit] 末尾から何行読むか（1..200）
   * @param {number} [since] この epoch ms より新しい行だけ返す（0 なら全部）
   * @returns {Array<{at: number, text: string}>} 古い順
   */

  return { thumb, image, annotation, saveAnnotation, targets, resolveTarget, repoForTarget, imageRepos, labelTarget, library }
}
