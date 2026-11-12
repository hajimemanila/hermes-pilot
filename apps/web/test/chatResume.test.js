import test from 'node:test'
import assert from 'node:assert/strict'
import { pickResumeTarget, recentSessions } from '../src/lib/chatResume.js'

const S = (id, profile, t) => ({ id, profile, started_at: t })

test('stored があればそれを優先する（直近より端末の記憶を信じる）', () => {
  const r = pickResumeTarget({ storedSid: 'old', sessions: [S('new', 'mobile', 99)], profile: 'mobile' })
  assert.deepEqual(r, { sid: 'old', from: 'stored' })
})

test('stored が無ければ同じプロファイルの直近を選ぶ', () => {
  const sessions = [S('a', 'mobile', 10), S('b', 'mobile', 30), S('c', 'default', 99)]
  const r = pickResumeTarget({ storedSid: null, sessions, profile: 'mobile' })
  assert.deepEqual(r, { sid: 'b', from: 'recent' })
})

test('プロファイル違いは選ばない／候補が無ければ null', () => {
  assert.equal(pickResumeTarget({ storedSid: null, sessions: [S('x', 'default', 5)], profile: 'mobile' }), null)
  assert.equal(pickResumeTarget({ storedSid: null, sessions: [], profile: 'mobile' }), null)
})

test('recentSessions は同プロファイルを新しい順に絞る', () => {
  const sessions = [S('a', 'mobile', 10), S('b', 'mobile', 40), S('c', 'mobile', 30), S('d', 'default', 50)]
  assert.deepEqual(recentSessions(sessions, 'mobile', 2).map((s) => s.id), ['b', 'c'])
})
