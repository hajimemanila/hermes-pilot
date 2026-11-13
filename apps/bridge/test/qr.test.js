/**
 * QR エンコーダとペアリング候補検出の自動検証（SPEC §8.1 / §8.2・Batch T6 受入条件）。
 *
 * 一番大事なのは **参照実装との一致**。ここでは `qrencode(1)` が生成した行列を
 * フィクスチャとして埋め込み、こちらの 8 マスクのどれかがそれと完全一致することを確かめる
 * （マスクの選び方は実装差が出るので、マスク非依存で比較する）。
 * これで byte モードの符号化・Reed-Solomon・ブロックインターリーブ・形式/型番情報の配置まで
 * 一度に検証できる。目視に頼らない。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MARGIN,
  MAX_VERSION,
  buildCodewords,
  chooseVersion,
  collectPairing,
  detectLanIp,
  parseTailscaleDnsName,
  pairingTargets,
  qrMatrix,
  qrSvg,
  qrPng,
  qrRows,
  qrTerminal,
  reedSolomon,
  tailscaleCommandCandidates,
} from '../src/qr.js'

// qrencode -t ASCII -m 0 -l M -8 -- 'hermes-pilot'  (21x21 / 型番 1)
const FIXTURE_V1 = [
  '111111101011101111111',
  '100000101011101000001',
  '101110101110101011101',
  '101110100110001011101',
  '101110101100101011101',
  '100000100111101000001',
  '111111101010101111111',
  '000000000111100000000',
  '100111111100110010111',
  '111001010000101101100',
  '010000111010001000111',
  '110100010001010110100',
  '011000111100010000010',
  '000000001000110010110',
  '111111101100100110000',
  '100000101010111101101',
  '101110101110100101010',
  '101110101000011100000',
  '101110100110111010111',
  '100000100101001101111',
  '111111101001011010000',
]

// qrencode -t ASCII -m 0 -l M -8 -- 'http://192.168.1.23:4097/?token=deadbeef'  (29x29 / 型番 3)
const FIXTURE_V3 = [
  '11111110011101100000101111111',
  '10000010101111000010001000001',
  '10111010111000011000001011101',
  '10111010111101001110001011101',
  '10111010011000001001001011101',
  '10000010001110101100001000001',
  '11111110101010101010101111111',
  '00000000100110100000100000000',
  '10000010101101110110111001110',
  '11101101000000110111110010110',
  '00011110010010111100000110000',
  '11001000111000101001001010000',
  '01101110000010011010011000001',
  '00110000111000011101011010111',
  '11001011100001110100111000100',
  '00011001011110100001101100101',
  '01110011110000010100110000100',
  '10110001110101011001001011111',
  '11011110000110010101100100001',
  '10100101011101001011001010000',
  '10001010010010101100111110111',
  '00000000101100111111100011000',
  '11111110010100010101101011100',
  '10000010001100111000100010000',
  '10111010010101101001111110010',
  '10111010001011111110100100001',
  '10111010010110011111101011010',
  '10000010011100000000001110101',
  '11111110110111110100000001100',
]

// qrencode -t ASCII -m 0 -l M -8 -- 'https://mac-mini.tail975a79.ts.net:8444/?token=bbb…'  (45x45 / 型番 7)
const FIXTURE_V7 = [
  '111111100001011110010100010111110000101111111',
  '100000100110010000101111101100001101001000001',
  '101110101100000000000001111111101101001011101',
  '101110101000100001111111101001110001101011101',
  '101110101101010010011111111111101011101011101',
  '100000101000101010101000100100000100001000001',
  '111111101010101010101010101010101010101111111',
  '000000001101101001101000101110101010100000000',
  '101111100010011000111111110000010000001111100',
  '001111010001011011111100110001101001100011011',
  '111010100011000011100111001100000110011100010',
  '100001001111110110111000000100101010101111100',
  '100100100001011111101111001100010010000000001',
  '010010000100100001011100010111111100100110101',
  '010001111001111000101001101100001010111100010',
  '110100001010111000010100000111001101100111101',
  '010000111100011011101000101000010110001000000',
  '111011001111001000000100010111110001110110101',
  '111000101010100010101001101100011111001100010',
  '010110011100011010010100000111001101000011101',
  '110111111010010011101111110000010110111110000',
  '111110001100111010011000100110101001100011101',
  '011110101101111101001010110101000111101010110',
  '000110001001100000001000111110101100100011101',
  '101111111000100011001111100000010000111111011',
  '100011010010000010110010100101101001101101101',
  '010011111001111101001101011000000110110111110',
  '100011011000010000100110100110101011001111111',
  '100000101000101011111001001000010010101011011',
  '010101000010010000100111110111111001101000101',
  '011111110001111100101101101100011010000100010',
  '010101010010011000100110100110001101101101101',
  '001100100001010111000001101001110110110110000',
  '001000001011101101111110110110110000000000101',
  '000010111100110010100010001100011110100110010',
  '011110010100111111110111111111001101111101101',
  '100110101011010010101111101001110110111110000',
  '000000001010101101101000111111101001100011101',
  '111111100110111111111010100100000111101010100',
  '100000101101100100011000101010101101100011111',
  '101110101000010010101111110000010011111111000',
  '101110101010100011101010000111101100000111101',
  '101110101000100011000100111010000111101000110',
  '100000100110110000111000000110101000010110100',
  '111111101000001101000011101000010100101101010',
]

/**
 * フィクスチャ（'0'/'1' の文字列配列）を真偽値行列にする。
 * @param {string[]} rows 行
 * @returns {boolean[][]} 行列
 */
function toGrid(rows) {
  return rows.map((row) => [...row].map((c) => c === '1'))
}

/**
 * 8 マスクのどれかが参照行列と完全一致するか。
 * @param {string} text 内容
 * @param {string[]} rows 参照
 * @returns {number[]} 一致したマスク番号
 */
function matchingMasks(text, rows) {
  const ref = toGrid(rows)
  const hits = []
  for (let mask = 0; mask < 8; mask++) {
    const mine = qrMatrix(text, { mask })
    assert.equal(mine.size, ref.length, `型番の大きさが違う: ${mine.size} vs ${ref.length}`)
    let same = true
    for (let y = 0; y < mine.size && same; y++) {
      for (let x = 0; x < mine.size; x++) {
        if (mine.modules[y][x] !== ref[y][x]) {
          same = false
          break
        }
      }
    }
    if (same) hits.push(mask)
  }
  return hits
}

test('参照実装（qrencode）の行列と完全一致する: 型番 1', () => {
  const hits = matchingMasks('hermes-pilot', FIXTURE_V1)
  assert.ok(hits.length >= 1, 'どのマスクも一致しない = 符号化か配置が間違っている')
})

test('参照実装（qrencode）の行列と完全一致する: 型番 3', () => {
  const hits = matchingMasks('http://192.168.1.23:4097/?token=deadbeef', FIXTURE_V3)
  assert.ok(hits.length >= 1, '型番 3 で一致するマスクが無い')
})

test('参照実装（qrencode）の行列と完全一致する: 型番 7（型番情報つき）', () => {
  const hits = matchingMasks('https://mac-mini.tail975a79.ts.net:8444/?token=' + 'b'.repeat(64), FIXTURE_V7)
  assert.ok(hits.length >= 1, '型番 7 で一致するマスクが無い（型番情報の配置が怪しい）')
})

test('chooseVersion: 誤り訂正レベル M の容量境界で型番が変わる', () => {
  assert.equal(chooseVersion(1), 1)
  assert.equal(chooseVersion(14), 1)
  assert.equal(chooseVersion(15), 2)
  assert.equal(chooseVersion(26), 2)
  assert.equal(chooseVersion(27), 3)
  assert.equal(chooseVersion(213), 10)
  assert.throws(() => chooseVersion(214), /PAIRING_TOO_LONG/)
  assert.equal(MAX_VERSION, 10)
})

test('qrMatrix: 位置検出・タイミング・ダークモジュールが仕様どおり', () => {
  for (const text of ['a', 'hermes-pilot', 'https://x.test/?token=' + 'f'.repeat(64)]) {
    const { size, modules, version } = qrMatrix(text)
    assert.equal(size, version * 4 + 17)
    assert.equal(modules.length, size)
    // 3 隅の位置検出パターン（7x7 の枠＋3x3 の中心）
    for (const [ox, oy] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ]) {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const dark = modules[oy + y][ox + x]
          const expectDark = !((x >= 1 && x <= 5 && (y === 1 || y === 5)) || (y >= 1 && y <= 5 && (x === 1 || x === 5)))
          assert.equal(dark, expectDark, `位置検出 (${ox + x},${oy + y})`)
        }
      }
    }
    // タイミングパターン（6 行目・6 列目が交互）
    for (let i = 8; i < size - 8; i++) {
      assert.equal(modules[6][i], i % 2 === 0, `水平タイミング ${i}`)
      assert.equal(modules[i][6], i % 2 === 0, `垂直タイミング ${i}`)
    }
    // 常時ダークモジュール
    assert.equal(modules[size - 8][8], true, 'ダークモジュール')
  }
})

test('qrMatrix: 形式情報の 2 か所が同じビット列になる（マスク 0..7）', () => {
  for (let mask = 0; mask < 8; mask++) {
    const { size, modules } = qrMatrix('hermes-pilot', { mask })
    const copy1 = []
    const copy2 = []
    const read = (x, y) => (modules[y][x] ? 1 : 0)
    for (let i = 0; i <= 5; i++) copy1.push(read(8, i))
    copy1.push(read(8, 7))
    copy1.push(read(8, 8))
    copy1.push(read(7, 8))
    for (let i = 9; i < 15; i++) copy1.push(read(14 - i, 8))
    for (let i = 0; i < 8; i++) copy2.push(read(size - 1 - i, 8))
    for (let i = 8; i < 15; i++) copy2.push(read(8, size - 15 + i))
    assert.deepEqual(copy1, copy2, `マスク ${mask}: 形式情報の 2 か所が一致しない`)
    const value = copy1.reduce((acc, bit, i) => acc | (bit << i), 0)
    // 形式情報は 0x5412 でマスクされている（仕様）。戻すと上位 5 ビットが ECL(2)+マスク(3)。
    const unmasked = value ^ 0x5412
    assert.equal((unmasked >>> 10) & 0b111, mask, `形式情報にマスク番号が入っていない（mask=${mask}）`)
    assert.equal((unmasked >>> 13) & 0b11, 0b00, 'ECL が M(00) になっていない')
  }
  // 既知の値: ECL=M・マスク 0 の形式情報は 101010000010010
  assert.equal(0x5412, 0b101010000010010)
})

test('qrMatrix: 型番 7 以上は型番情報の 2 か所が一致し、値が型番と対応する', () => {
  const { size, modules, version } = qrMatrix('x'.repeat(107))
  assert.equal(version, 7)
  const a = []
  const b = []
  for (let i = 0; i < 18; i++) {
    const x = size - 11 + (i % 3)
    const y = Math.floor(i / 3)
    a.push(modules[y][x] ? 1 : 0)
    b.push(modules[x][y] ? 1 : 0)
  }
  assert.deepEqual(a, b, '型番情報の 2 か所が一致しない')
  const value = a.reduce((acc, bit, i) => acc | (bit << i), 0)
  assert.equal(value >>> 12, 7, '型番情報の上位 6 ビットが型番になっていない')
})

test('qrMatrix: UTF-8 のバイト列として符号化する（日本語が入っても落ちない）', () => {
  const text = 'ペアリングの確認'
  const bytes = Buffer.byteLength(text, 'utf8')
  const { version } = qrMatrix(text)
  assert.equal(version, chooseVersion(bytes))
})

test('buildCodewords: Reed-Solomon の EC コードワード長とインターリーブ後長', () => {
  const ecc = reedSolomon([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236], 10)
  assert.equal(ecc.length, 10)
  // 既知の QR 仕様例（型番 1-M: データ 16 + EC 10 = 26 コードワード）
  const codewords = buildCodewords(new Uint8Array([1, 2, 3]), 1)
  assert.equal(codewords.length, 26)
  const v10 = buildCodewords(new Uint8Array(213).fill(7), 10)
  assert.equal(v10.length, 346)
})

test('qrSvg: 余白込みの viewBox と黒モジュールのパスを持つ', () => {
  const svg = qrSvg('hermes-pilot')
  const { size } = qrMatrix('hermes-pilot')
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, new RegExp(`viewBox="0 0 ${size + DEFAULT_MARGIN * 2} ${size + DEFAULT_MARGIN * 2}"`))
  assert.match(svg, /shape-rendering="crispEdges"/)
  assert.ok((svg.match(/M\d+ \d+h1v1h-1z/g) ?? []).length > 50, '黒モジュールのパスが足りない')
})

test('qrSvg: タイトルの XML 特殊文字をエスケープする', () => {
  const svg = qrSvg('hermes-pilot', { title: 'a & b <c>' })
  assert.match(svg, /aria-label="a &amp; b &lt;c&gt;"/)
})

test('qrTerminal: 半角ブロックで 2 モジュールを 1 行に圧縮する', () => {
  const { size } = qrMatrix('hermes-pilot')
  const margin = 2
  const total = size + margin * 2
  const text = qrTerminal('hermes-pilot', { margin })
  const lines = text.split('\n')
  assert.equal(lines.length, Math.ceil(total / 2))
  for (const line of lines) {
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '')
    assert.equal([...visible].length, total, '行の長さが揃っていない')
    assert.match(visible, /^[█▀▄ ]+$/)
  }
  // 色なしモードは 1 モジュール 2 文字（等幅端末で正方形に見せる）
  const plain = qrTerminal('hermes-pilot', { margin, color: false }).split('\n')
  assert.equal([...plain[0]].length, total * 2)
  assert.match(plain[0], /^[█▀▄ ]+$/)
})

test('parseTailscaleDnsName: 末尾ドットを落として MagicDNS 名を返す', () => {
  const status = JSON.stringify({ Self: { DNSName: 'mac-mini.tail1234.ts.net.' } })
  assert.equal(parseTailscaleDnsName(status), 'mac-mini.tail1234.ts.net')
  assert.equal(parseTailscaleDnsName({ Self: { DNSName: 'host.example.net.' } }), 'host.example.net')
  assert.equal(parseTailscaleDnsName({ Self: {} }), null)
  assert.equal(parseTailscaleDnsName('not json'), null)
  assert.equal(parseTailscaleDnsName(null), null)
})

test('detectLanIp: loopback と link-local を避け、192.168 を最優先・Tailscale CGNAT は最後', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    utun3: [{ address: '100.75.238.77', family: 'IPv4', internal: false }],
    en0: [
      { address: '169.254.10.2', family: 'IPv4', internal: false },
      { address: '192.168.1.42', family: 'IPv4', internal: false },
    ],
    en1: [{ address: '10.0.0.9', family: 4, internal: false }],
  }
  assert.equal(detectLanIp(ifaces), '192.168.1.42')
  assert.equal(detectLanIp({ en0: [{ address: '10.0.0.9', family: 'IPv4', internal: false }] }), '10.0.0.9')
  assert.equal(detectLanIp({}), null)
  // 100.64/10（Tailscale）しか無い場合はそれを使う（localhost 候補は別途出る）
  assert.equal(
    detectLanIp({
      utun3: [{ address: '100.75.238.77', family: 'IPv4', internal: false }],
      en0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
    }),
    '192.168.1.42',
    'Tailscale より LAN を優先する',
  )
})

test('pairingTargets: Tailscale → LAN → localhost の順に URL を組む', () => {
  const targets = pairingTargets({
    token: 'abc123',
    port: 4097,
    dnsName: 'mac-mini.tail1234.ts.net',
    lanIp: '192.168.1.42',
  })
  assert.deepEqual(
    targets.map((t) => t.kind),
    ['tailscale', 'lan', 'local'],
  )
  assert.equal(targets[0].url, 'https://mac-mini.tail1234.ts.net/?token=abc123')
  assert.equal(targets[1].url, 'http://192.168.1.42:4097/?token=abc123')
  assert.equal(targets[2].url, 'http://127.0.0.1:4097/?token=abc123')
  // Tailscale serve が 443 以外に出す構成
  const withPort = pairingTargets({ token: 't', dnsName: 'h.ts.net', tlsPort: 8444 })
  assert.equal(withPort[0].url, 'https://h.ts.net:8444/?token=t')
})

test('collectPairing: 検出材料から最良候補（Tailscale 優先）を返す', () => {
  const info = collectPairing({
    token: 'tok',
    port: 4097,
    tailscaleJson: JSON.stringify({ Self: { DNSName: 'mini.tail1.ts.net.' } }),
    ifaces: { en0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }] },
  })
  assert.equal(info.dnsName, 'mini.tail1.ts.net')
  assert.equal(info.lanIp, '192.168.1.42')
  assert.equal(info.best.kind, 'tailscale')
  assert.equal(info.best.url, 'https://mini.tail1.ts.net/?token=tok')

  const lanOnly = collectPairing({
    token: 'tok',
    port: 5000,
    tailscaleJson: null,
    ifaces: { en0: [{ address: '192.168.0.5', family: 'IPv4', internal: false }] },
  })
  assert.equal(lanOnly.best.kind, 'lan')
  assert.equal(lanOnly.best.url, 'http://192.168.0.5:5000/?token=tok')
})

test('tailscaleCommandCandidates: macOS はアプリ版のバイナリも候補に入れる', () => {
  assert.deepEqual(tailscaleCommandCandidates('darwin', { env: {} }), [
    'tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ])
  assert.deepEqual(tailscaleCommandCandidates('linux', { env: {} }), [
    'tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ])
  // HP_TAILSCALE_BIN で明示指定でき、重複は畳む
  assert.deepEqual(tailscaleCommandCandidates('linux', { env: { HP_TAILSCALE_BIN: '/opt/bin/tailscale' } }), [
    '/opt/bin/tailscale',
    'tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ])
})

test('collectPairing: CLI が読めない環境では config の tailscaleDns を控えに使う', () => {
  // launchd からアプリ版 Tailscale を叩くと「GUI failed to start」で JSON が返らない実測への対処
  const withFallback = collectPairing({
    token: 'tok',
    port: 4097,
    tailscaleJson: null,
    dnsName: 'mini.tail1.ts.net.',
    tlsPort: 8444,
    ifaces: { en0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }] },
  })
  assert.equal(withFallback.dnsName, 'mini.tail1.ts.net', '末尾ドットは落とす')
  assert.equal(withFallback.best.kind, 'tailscale')
  assert.equal(withFallback.best.url, 'https://mini.tail1.ts.net:8444/?token=tok')

  // CLI の応答があればそちらを優先する
  const fromCli = collectPairing({
    token: 'tok',
    port: 4097,
    tailscaleJson: JSON.stringify({ Self: { DNSName: 'real.tail1.ts.net.' } }),
    dnsName: 'stale.tail1.ts.net',
    ifaces: { en0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }] },
  })
  assert.equal(fromCli.dnsName, 'real.tail1.ts.net')
})

test('qrPng: PNG として妥当で、余白は白・モジュールは黒（整数スケール）', async () => {
  const zlib = await import('node:zlib')
  const png = qrPng('hermes-pilot', { margin: 4, scale: 4 })
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 署名が違う')
  const { size } = qrMatrix('hermes-pilot')
  const w = (size + 8) * 4
  assert.equal(png.readUInt32BE(16), w, 'IHDR の幅が違う')
  assert.equal(png.readUInt32BE(20), w, 'IHDR の高さが違う')
  assert.equal(png[24], 8, 'bit depth')
  assert.equal(png[25], 0, 'colorType 0（グレースケール）')
  // IDAT を取り出して展開し、余白とモジュールを確認する
  const idatStart = png.indexOf(Buffer.from('IDAT', 'ascii')) + 4
  const idatLen = png.readUInt32BE(png.indexOf(Buffer.from('IDAT', 'ascii')) - 4)
  const raw = zlib.inflateSync(png.subarray(idatStart, idatStart + idatLen))
  assert.equal(raw.length, (w + 1) * w, 'IDAT の長さ（フィルタ 1 バイト + 幅）')
  assert.equal(raw[0], 0, '先頭行のフィルタ種別は 0')
  assert.equal(raw[1], 0xff, '左上は余白（白）')
  // 余白 4 モジュール分ずらした位置は左上のファインダ（暗）
  const x = 4 * 4 + 1
  const y = 4 * 4
  assert.equal(raw[y * (w + 1) + 1 + x], 0x00, '左上ファインダが黒くない')
})

test('qrRows: フロントが canvas に描ける 0/1 行を返す（正方形・全行同長）', () => {
  const rows = qrRows('http://192.168.100.67:4097/?token=ABCDEFGH')
  assert.ok(rows.length >= 21)
  assert.equal(rows.every((r) => r.length === rows.length), true, '正方形でない')
  assert.equal(rows.every((r) => /^[01]+$/.test(r)), true, '0/1 以外が混じっている')
  assert.equal(rows[0].slice(0, 7), '1111111', '左上ファインダが無い')
})
