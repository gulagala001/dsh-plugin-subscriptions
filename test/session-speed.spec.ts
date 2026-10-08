import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionSpeedStore } from '../src/session-speed.js'

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'session-speed-spec-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = (id: string) => join(directory, createHash('sha256').update(id).digest('hex') + '.json')
  return { directory, file }
}

test('missing speed preference defaults to standard without writing', t => {
  const { directory } = fixture(t)
  assert.equal(new SessionSpeedStore(directory).get('new-session'), 'standard')
  assert.deepEqual(readdirSync(directory), [])
})

test('invalid speed preferences cannot interrupt a request or overwrite the bad file', async t => {
  for (const body of ['{broken-json', 'null', '{"tier":"turbo"}', '{"tier":42}']) {
    const { directory, file } = fixture(t)
    const path = file('broken')
    writeFileSync(path, body)
    const warnings: string[] = []
    const store = new SessionSpeedStore(directory, message => warnings.push(message))
    assert.equal(store.get('broken'), 'standard')
    assert.equal(store.get('broken'), 'standard')
    assert.equal(warnings.length, 1, 'cached fallback does not spam warnings')
    assert.match(warnings[0]!, /using standard and preserving the file/)
    assert.equal(warnings[0]!.includes(body), false, 'diagnostics never echo preference contents')
    await assert.rejects(store.set('broken', 'fast'), /preference/i)
    assert.equal(readFileSync(path, 'utf8'), body)
    // An explicit repair permits retry in the same store instance.
    writeFileSync(path, '{"tier":"standard"}\n')
    await store.set('broken', 'fast')
    assert.equal(new SessionSpeedStore(directory).get('broken'), 'fast')
  }
})

test('explicit save preserves corruption even without an earlier get or after a cached good read', async t => {
  const { directory, file } = fixture(t)
  const store = new SessionSpeedStore(directory, () => {})
  writeFileSync(file('new'), '{broken')
  await assert.rejects(store.set('new', 'fast'), /preference/i)
  assert.equal(readFileSync(file('new'), 'utf8'), '{broken')
  writeFileSync(file('cached'), '{"tier":"fast"}')
  assert.equal(store.get('cached'), 'fast')
  writeFileSync(file('cached'), 'null')
  await assert.rejects(store.set('cached', 'standard'), /preference/i)
  assert.equal(readFileSync(file('cached'), 'utf8'), 'null')
})

test('a throwing diagnostic sink cannot interrupt a model request', t => {
  const { directory, file } = fixture(t)
  writeFileSync(file('bad'), '{broken')
  const store = new SessionSpeedStore(directory, () => { throw new Error('logger unavailable') })
  assert.equal(store.get('bad'), 'standard')
})

test('a speed preference read IO error degrades to standard and preserves the entry', async t => {
  const { directory, file } = fixture(t)
  mkdirSync(file('unreadable'))
  const store = new SessionSpeedStore(directory)
  assert.equal(store.get('unreadable'), 'standard')
  await assert.rejects(store.set('unreadable', 'fast'), /preference/i)
  assert.deepEqual(readdirSync(file('unreadable')), [])
})

test('normal writes stay durable, atomic and ordered per session', async t => {
  const { directory, file } = fixture(t)
  const store = new SessionSpeedStore(directory)
  await Promise.all([store.set('first', 'fast'), store.set('first', 'standard'), store.set('first', 'fast'), store.set('second', 'standard')])
  assert.equal(store.get('first'), 'fast')
  assert.equal(store.get('second'), 'standard')
  assert.equal(new SessionSpeedStore(directory).get('first'), 'fast')
  assert.deepEqual(JSON.parse(readFileSync(file('first'), 'utf8')), { tier: 'fast' })
  assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false)
})

test('invalid session ids still reject before accessing the filesystem', async t => {
  const { directory } = fixture(t)
  const store = new SessionSpeedStore(directory)
  for (const id of ['', 'a'.repeat(201), 'a\0b']) {
    assert.throws(() => store.get(id), /Invalid session ID/)
    await assert.rejects(store.set(id, 'fast'), /Invalid session ID/)
  }
  assert.deepEqual(readdirSync(directory), [])
})
