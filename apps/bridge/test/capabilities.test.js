import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_PILOT_UNIT,
  PILOT_UNITS,
  detectCapabilities,
  detectTailscale,
  getCapabilities,
  hasBinary,
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
  })
  assert.deepEqual(caps, {
    os: 'darwin',
    serviceManager: 'launchd',
    hasTailscale: true,
    hasHermesCli: true,
    pilotServiceUnit: 'ai.hermes.pilot',
  })
  assert.equal(PILOT_UNITS.darwin, caps.pilotServiceUnit)
})

test('detectCapabilities は linux で systemd のユニット名を返す', () => {
  const caps = detectCapabilities({ platform: 'linux', pathEnv: fakeBin([]), appExists: () => false })
  assert.equal(caps.os, 'linux')
  assert.equal(caps.serviceManager, 'systemd')
  assert.equal(caps.hasHermesCli, false)
  assert.equal(caps.hasTailscale, false)
  assert.equal(caps.pilotServiceUnit, 'hermes-pilot.service')
})

test('detectCapabilities は未知の OS でも落ちず、既定ユニットを返す', () => {
  const caps = detectCapabilities({ platform: 'win32', pathEnv: fakeBin([]), appExists: () => false })
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
