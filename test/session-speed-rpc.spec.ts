import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createFakeConnection } from './fake-connection.js'

// Isolate all plugin storage before import; only the logged-out Codex route
// mounts, and a fixed client version avoids even a public npm metadata lookup.
const home = mkdtempSync(join(tmpdir(), 'session-speed-rpc-'))
process.env.DSH_HOME = home
const plugin = await import('../src/index.js')

test('corrupt speed preference degrades at the actual RPC boundary and recovers after repair', async t => {
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const ctx = new Context()
  ctx.provide('llm', { registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) })
  const fake = createFakeConnection()
  ctx.provide('connection', fake.connection)
  const runtime = ctx.plugin(plugin, { providers: ['codex'], codexClientVersion: '0.134.0' })
  t.after(() => runtime.dispose())
  for (let attempt = 0; !fake.registered() && attempt < 20; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(fake.registered())
  const directory = join(home, 'plugins', 'subscriptions', 'speed-sessions')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, createHash('sha256').update('bad').digest('hex') + '.json')
  writeFileSync(file, '{broken')
  const signal = new AbortController().signal
  assert.deepEqual(await fake.handler('speed', { sessionId: 'bad' }, signal), {
    ok: true, value: { tier: 'standard', fastModels: [] },
  })
  const failed = await fake.handler('setSpeed', { sessionId: 'bad', tier: 'fast' }, signal)
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.match(failed.error.message, /preserving the file/)
  assert.equal(readFileSync(file, 'utf8'), '{broken')
  writeFileSync(file, '{"tier":"standard"}')
  assert.deepEqual(await fake.handler('setSpeed', { sessionId: 'bad', tier: 'fast' }, signal), { ok: true, value: { ok: true } })
  assert.deepEqual(await fake.handler('speed', { sessionId: 'bad' }, signal), {
    ok: true, value: { tier: 'fast', fastModels: [] },
  })
})
