import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDiscord } from '../src/discord.js'

/** sessions.json のフィクスチャ。 */
function fixture(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-dc-'))
  const file = path.join(root, 'sessions.json')
  fs.writeFileSync(file, JSON.stringify(entries, null, 2))
  return { root, file }
}

const THREAD_KEY = 'agent:main:discord:thread:1562746287588114463:1562746287588114463'

test('origin から guild/thread を拾ってリンクを作る', () => {
  const { file } = fixture({
    [THREAD_KEY]: {
      session_id: '20261022_163552_3305cfe1',
      platform: 'discord',
      chat_type: 'thread',
      origin: {
        platform: 'discord',
        chat_id: '1562746287588114463',
        thread_id: '1562746287588114463',
        guild_id: '1560581479648469033',
        message_id: '1562746287588114463',
        chat_name: 'Hajime@Hemes Agent🔥 / #一般 / テスト',
      },
    },
  })
  const dc = createDiscord({ home: '/nonexistent', sessionsFile: file })
  const link = dc.forSession('20261022_163552_3305cfe1')
  assert.equal(link.url, 'https://discord.com/channels/1560581479648469033/1562746287588114463')
  assert.equal(link.threadId, '1562746287588114463')
  assert.equal(link.guildId, '1560581479648469033')
})

test('guild_id が無い（DM 等）ならリンクを作らない', () => {
  const { file } = fixture({
    'agent:main:discord:dm:123': {
      session_id: 'sess-dm',
      platform: 'discord',
      chat_type: 'dm',
      origin: { platform: 'discord', chat_id: '123' },
    },
  })
  const dc = createDiscord({ home: '/nonexistent', sessionsFile: file })
  assert.equal(dc.forSession('sess-dm'), null)
})

test('discord 以外のセッションは対象外', () => {
  const { file } = fixture({
    'agent:main:local:abc': { session_id: 'sess-local', platform: 'local' },
  })
  const dc = createDiscord({ home: '/nonexistent', sessionsFile: file })
  assert.equal(dc.forSession('sess-local'), null)
})

test('origin が文字列（Python dict 形式）でも解釈する', () => {
  const { file } = fixture({
    [THREAD_KEY]: {
      session_id: 'sess-str',
      platform: 'discord',
      chat_type: 'thread',
      origin:
        "{'platform': 'discord', 'chat_id': '111', 'thread_id': '111', 'guild_id': '222', 'chat_name': 'x'}",
    },
  })
  const dc = createDiscord({ home: '/nonexistent', sessionsFile: file })
  const link = dc.forSession('sess-str')
  assert.equal(link.url, 'https://discord.com/channels/222/111')
})

test('タスクのアンカーからリンクを引く（message_id はアンカー優先）', () => {
  const { file } = fixture({
    [THREAD_KEY]: {
      session_id: 'sess-1',
      platform: 'discord',
      chat_type: 'thread',
      origin: { thread_id: '999', guild_id: '888', message_id: '777' },
    },
  })
  const dc = createDiscord({ home: '/nonexistent', sessionsFile: file })
  const link = dc.forAnchor({ session_id: 'sess-1', message_id: '4242' })
  assert.equal(link.url, 'https://discord.com/channels/888/999')
  assert.equal(link.messageId, '4242')
  assert.equal(dc.forAnchor(null), null)
  assert.equal(dc.forAnchor({ session_id: 'unknown' }), null)
})

test('sessions.json が無くても落ちない', () => {
  const dc = createDiscord({ home: '/nonexistent', sessionsFile: '/nonexistent/sessions.json' })
  assert.equal(dc.forSession('x'), null)
})
