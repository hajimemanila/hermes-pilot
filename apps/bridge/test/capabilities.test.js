import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_PILOT_UNIT,
  PILOT_UNITS,
  agyCliDirs,
  detectCapabilities,
  detectTailscale,
  getCapabilities,
  hasBinary,
  hermesCliDirs,
  resetCapabilitiesCache,
  serviceCommands,
  serviceManagerFor,
} from '../src/capabilities.js'

/** 実行ビット付きのダミー実行ファイルを置いた PATH。 */
function fakeBin(names = [], { mode = 0o755 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-bin-'))
  for (const n of names) fs.writeFileSync(path.join(dir, n), '#!/bin/sh\n', { mode })
  return dir
}

test('serviceManagerFor: darwin=launchd / linux=systemd / それ以外=none', () => {
  assert.equal(serviceManagerFor('darwin'), 'launchd')
  assert.equal(serviceManagerFor('linux'), 'systemd')
  assert.equal(serviceManagerFor('win32'), 'none')
  assert.equal(serviceManagerFor('freebsd'), 'none')
})

test('hasBinary は PATH 上の実行ファイルを見つける（spawn しない）', () => {
  const dir = fakeBin(['hermes'])
  assert.equal(hasBinary('hermes', dir), true)
  assert.equal(hasBinary('tailscale', dir), false)
  assert.equal(hasBinary('', dir), false)
  assert.equal(hasBinary('hermes', ''), false)
  // 実行ビットが無いものは対象外
  const noExec = fakeBin(['hermes'], { mode: 0o644 })
  assert.equal(hasBinary('hermes', noExec), false)
})

test('hasBinary は複数ディレクトリを跨いで探す', () => {
  const a = fakeBin([])
  const b = fakeBin(['tailscale'])
  assert.equal(hasBinary('tailscale', [a, b].join(path.delimiter)), true)
})

test('detectTailscale は CLI かアプリのどちらかで true', () => {
  assert.equal(detectTailscale({ pathEnv: fakeBin(['tailscale']), appExists: () => false }), true)
  assert.equal(detectTailscale({ pathEnv: fakeBin([]), appExists: (p) => p.includes('Tailscale.app') }), true)
  assert.equal(detectTailscale({ pathEnv: fakeBin([]), appExists: () => false }), false)
})

test('detectCapabilities は SPEC §5.3 の 5 項目を返す（darwin）', () => {
  const caps = detectCapabilities({
    platform: 'darwin',
    pathEnv: fakeBin(['hermes', 'tailscale']),
    appExists: () => false,
    // `agy` は Opt-in の追加項目なので、実機の有無に左右されない HOME を渡す
    home: fakeBin([]),
  })
  assert.deepEqual(caps, {
    os: 'darwin',
    serviceManager: 'launchd',
    hasTailscale: true,
    hasHermesCli: true,
    hasAgyCli: false,
    pilotServiceUnit: 'ai.hermes.pilot',
  })
  assert.equal(PILOT_UNITS.darwin, caps.pilotServiceUnit)
})

test('detectCapabilities は agy CLI を PATH でも既知の置き場所でも見つける（Opt-in の前提）', () => {
  // PATH にある場合
  assert.equal(
    detectCapabilities({ platform: 'darwin', pathEnv: fakeBin(['agy']), appExists: () => false, home: fakeBin([]) })
      .hasAgyCli,
    true,
  )
  // PATH に無くても ~/.local/bin にあれば拾う（実測: ~/.local/bin/agy）
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-home-'))
  const localBin = path.join(home, '.local', 'bin')
  fs.mkdirSync(localBin, { recursive: true })
  fs.writeFileSync(path.join(localBin, 'agy'), '#!/bin/sh\n', { mode: 0o755 })
  assert.equal(
    detectCapabilities({ platform: 'linux', pathEnv: fakeBin([]), appExists: () => false, home }).hasAgyCli,
    true,
  )
  assert.ok(agyCliDirs(home).includes(localBin))
})

test('detectCapabilities は linux で systemd のユニット名を返す', () => {
  // `home` に空ディレクトリを渡し、実機の ~/.hermes/hermes-agent/.hermes/bin を拾わないようにする
  const caps = detectCapabilities({
    platform: 'linux',
    pathEnv: fakeBin([]),
    appExists: () => false,
    home: fakeBin([]),
  })
  assert.equal(caps.os, 'linux')
  assert.equal(caps.serviceManager, 'systemd')
  assert.equal(caps.hasHermesCli, false)
  assert.equal(caps.hasTailscale, false)
  assert.equal(caps.pilotServiceUnit, 'hermes-pilot.service')
})

test('detectCapabilities は PATH に無くても ~/.hermes/hermes-agent/.hermes/bin の hermes を見つける', () => {
  // 常駐（launchd / systemd）の PATH はログインシェルより狭く、hermes CLI が落ちている実測がある
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-home-'))
  const binDir = path.join(home, '.hermes', 'hermes-agent', '.hermes', 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(binDir, 'hermes'), '#!/bin/sh\n', { mode: 0o755 })
  const caps = detectCapabilities({ platform: 'darwin', pathEnv: fakeBin([]), appExists: () => false, home })
  assert.equal(caps.hasHermesCli, true)
  assert.ok(hermesCliDirs(home).includes(binDir))
})

test('detectCapabilities は未知の OS でも落ちず、既定ユニットを返す', () => {
  const caps = detectCapabilities({ platform: 'win32', pathEnv: fakeBin([]), appExists: () => false, home: fakeBin([]) })
  assert.equal(caps.serviceManager, 'none')
  assert.equal(caps.pilotServiceUnit, DEFAULT_PILOT_UNIT)
})

test('serviceCommands は launchd のラベルで再起動・状態確認を組み立てる', () => {
  const cmd = serviceCommands({ serviceManager: 'launchd', pilotServiceUnit: 'ai.hermes.pilot' })
  assert.equal(cmd.restart, 'launchctl kickstart -k gui/$(id -u)/ai.hermes.pilot')
  assert.match(cmd.status, /launchctl print gui\/\$\(id -u\)\/ai\.hermes\.pilot/)
  assert.match(cmd.list, /launchctl list/)
})

test('serviceCommands は systemd --user で再起動・状態確認を組み立てる', () => {
  const cmd = serviceCommands({ serviceManager: 'systemd', pilotServiceUnit: 'hermes-pilot.service' })
  assert.equal(cmd.restart, 'systemctl --user restart hermes-pilot.service')
  assert.match(cmd.status, /systemctl --user status hermes-pilot\.service/)
  assert.match(cmd.list, /systemctl --user list-units/)
})

test('serviceCommands は個人環境のサービス名を一切含まない', () => {
  const all = [
    ...Object.values(serviceCommands({ serviceManager: 'launchd', pilotServiceUnit: 'ai.hermes.pilot' })),
    ...Object.values(serviceCommands({ serviceManager: 'systemd', pilotServiceUnit: 'hermes-pilot.service' })),
  ].join('\n')
  assert.ok(!/\b(8787|dsh|system-ops|git-ops|nanokvm)\b/i.test(all), all)
})

test('getCapabilities は 1 度検出したらキャッシュする（テストでは opts で上書き可）', () => {
  resetCapabilitiesCache()
  const first = getCapabilities({ platform: 'linux', pathEnv: '', appExists: () => false })
  assert.equal(first.serviceManager, 'systemd')
  const second = getCapabilities()
  assert.equal(second, first, '同じオブジェクトを返す')
  const forced = getCapabilities({ platform: 'darwin', pathEnv: '', appExists: () => false })
  assert.equal(forced.serviceManager, 'launchd', 'opts 付きは再検出')
  resetCapabilitiesCache()
})
