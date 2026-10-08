// Opt-in stock-host acceptance. Build and `npm pack --ignore-scripts` first.
// SUBSCRIPTIONS_NATIVE=1 SUBSCRIPTIONS_PACKAGE=/path/candidate.tgz
// DSH_NATIVE_RC_CLI=/path/rc/lib/bin.js DSH_NATIVE_ALPHA_CLI=/path/alpha/lib/bin.js
// PLAYWRIGHT_PATH=/path/playwright CFT_EXECUTABLE=/path/Chrome-for-Testing
// Optional SUBSCRIPTIONS_BASELINE_PACKAGE=/path/original-manifest.tgz asserts
// the stock alpha install rejection. No account, OAuth or model request is used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)
const enabled = process.env.SUBSCRIPTIONS_NATIVE === '1'
const packagePath = process.env.SUBSCRIPTIONS_PACKAGE
const hosts = [
  { version: '0.2.0-rc.2', cli: process.env.DSH_NATIVE_RC_CLI },
  { version: '0.2.1-alpha.1', cli: process.env.DSH_NATIVE_ALPHA_CLI },
]
const redact = value => String(value).replace(/token=[\w-]+/g, 'token=[redacted]')
async function until(fn, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(50) }
  throw Error('Native subscriptions acceptance timed out')
}

async function fixture(t, host, install = true) {
  assert.ok(host.cli, `Configure the stock ${host.version} CLI entry`)
  const root = await mkdtemp(join(tmpdir(), 'subscriptions-native-'))
  const dshRoot = join(root, 'dsh'), workspace = join(root, 'workspace'), profile = 'subscriptions-native'
  await mkdir(dshRoot); await mkdir(workspace)
  // Preserve HOME/CODEX_HOME values, but omit inherited provider credentials,
  // proxy configuration, DSH overrides and injected Node startup code.
  const env = Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(env, { DSH_HOME: dshRoot, DSH_PERMISSION_MODE: 'danger-full-access' })
  const profileDir = join(dshRoot, 'profiles', profile)
  let child, browser, context, page, origin, cookie = '', log = ''
  const errors = [], resources = [], subscriptionCalls = []
  const command = async args => {
    try { return await execute(process.execPath, [host.cli, ...args], { cwd: workspace, env, timeout: 180000, maxBuffer: 16 * 1024 * 1024 }) }
    catch (error) { error.message = redact(error.stderr || error.stdout || error.message); throw error }
  }
  const stop = async () => {
    if (!child || child.exitCode !== null) return
    const exited = new Promise(resolveExit => child.once('exit', resolveExit))
    child.kill('SIGTERM')
    await Promise.race([exited, delay(5000, undefined, { ref: false })])
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited }
  }
  t.after(async () => {
    if (!t.passed) t.diagnostic(JSON.stringify({ host: host.version, root, log: redact(log), errors, resources,
      body: await page?.locator('body').innerText().catch(() => '') }))
    await browser?.close(); await stop()
    if (!process.env.SUBSCRIPTIONS_NATIVE_KEEP) await rm(root, { recursive: true, force: true })
  })
  const cliPath = await realpath(host.cli)
  const installAnchor = join(dirname(dirname(cliPath)), 'package.json')
  const cliManifest = JSON.parse(await readFile(installAnchor, 'utf8'))
  assert.equal(cliManifest.version, host.version, 'use the specified unmodified stock host')
  await command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  if (install) await command(['plugin', '--profile', profile, 'add', 'file:' + resolve(packagePath)])
  // Configure the profile before boot. Legacy settings.yaml migration occurs
  // after plugins activate and cannot safely constrain their initial startup.
  const configuration = [
    { id: 'locale', config: { preference: 'zh' } },
    { id: 'llm-subscriptions', config: { providers: ['codex'], codexClientVersion: '0.134.0' } },
  ]
  await writeFile(join(profileDir, 'cordis.patch.yml'), JSON.stringify(configuration))
  if (install) {
    const dump = await command(['--profile', profile, '--dump-config'])
    assert.match(dump.stdout, /codexClientVersion: ['"]?0\.134\.0/)
    assert.match(dump.stdout, /providers:\s*\n\s*- codex/)
    assert.doesNotMatch(dump.stdout, /providers:\s*\n\s*- codex\s*\n\s*- claude/)
  }
  const bootEntry = createRequire(cliPath).resolve('@deepseek-ai/dsh-app-boot')
  const boot = await import(pathToFileURL(bootEntry).href)
  const loadedProfile = boot.loadProfileDirectory('dsh', profileDir, installAnchor)
  const resolution = await boot.createRuntimeResolution({ installAnchor, profile: loadedProfile, home: dshRoot })
  const names = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-conversation']
  const sdk = await Promise.all(names.map(async name => {
    const row = resolution.entries.find(item => item.name === name)
    assert.ok(row, 'runtime table contains ' + name)
    assert.equal(row.version, host.version, 'the plugin shares the stock host SDK')
    return { name, version: row.version, directory: await realpath(row.packageDir), declarer: row.declarer }
  }))
  const evidence = { host: host.version, cli: cliPath, sdk, versionBypass: false, linkedSource: false }
  if (install) Object.assign(evidence, { tarball: resolve(packagePath), sha256: createHash('sha256').update(await readFile(packagePath)).digest('hex') })
  const request = (path, options) => fetch(origin + path, { ...options, headers: { cookie, ...options?.headers } })
  const envelope = async (method, payload) => {
    const response = await request('/api/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) })
    const value = await response.json()
    assert.equal(response.status, 200, JSON.stringify(value))
    assert.equal(value.result?.ok, true, JSON.stringify(value))
    return value.result.value
  }
  const call = (method, args = {}) => envelope(method, { args })
  const rpc = (method, value) => call(method, value === undefined ? {} : { request: value })
  const subscriptions = (endpoint, payload = {}) => envelope('subscriptions-auth.' + endpoint, payload)
  const start = async () => {
    log = ''
    child = spawn(process.execPath, [host.cli, '--profile', profile, '--no-open', '--port', '0'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-30000) })
    const bootstrap = await until(() => {
      if (child.exitCode !== null) throw Error(redact(log))
      return log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)?.[0]
    }, 60000)
    origin = new URL(bootstrap).origin
    const response = await fetch(bootstrap, { redirect: 'manual' })
    cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    await until(async () => (await request('/')).status === 200)
  }
  const open = async () => {
    if (!browser) {
      assert.ok(process.env.PLAYWRIGHT_PATH, 'Configure PLAYWRIGHT_PATH')
      assert.ok(process.env.CFT_EXECUTABLE, 'Configure an isolated CFT_EXECUTABLE')
      const playwrightEntry = createRequire(import.meta.url).resolve(resolve(process.env.PLAYWRIGHT_PATH))
      const playwright = await import(pathToFileURL(playwrightEntry).href)
      const chromium = playwright.chromium ?? playwright.default.chromium
      browser = await chromium.launch({ headless: true, executablePath: process.env.CFT_EXECUTABLE, args: ['--use-mock-keychain', '--password-store=basic'] })
    }
    await context?.close()
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    await context.addCookies(cookie.split('; ').filter(Boolean).map(value => {
      const split = value.indexOf('='); return { name: value.slice(0, split), value: value.slice(split + 1), url: origin }
    }))
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      errors.push('Unexpected external browser request: ' + route.request().url()); return route.abort()
    })
    page = await context.newPage(); page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push(error.stack || error.message))
    page.on('response', async response => {
      if (response.url().includes('dsh-plugin-subscriptions') || response.url().includes('subscriptions-auth.')) {
        resources.push({ url: response.url(), status: response.status() })
      }
    })
    page.on('request', request => {
      if (request.url().includes('/api/subscriptions-auth.')) subscriptionCalls.push(request.url().split('/api/')[1])
    })
    // The stock preview notice is shown once per DSH home, so a new process
    // may omit it. Dismiss it through its own button whenever it blocks UI.
    const welcome = page.getByRole('button', { name: '继续', exact: true })
    await page.addLocatorHandler(welcome, async locator => { await locator.click() })
    const deferSetup = page.getByRole('button', { name: '稍后配置', exact: true })
    await page.addLocatorHandler(deferSetup, async locator => { await locator.click() })
    await page.goto(origin)
    await page.getByRole('button', { name: '设置', exact: true }).waitFor()
    return page
  }
  await start()
  return { root, dshRoot, workspace, profileDir, evidence, errors, resources, subscriptionCalls, command, call, rpc, request, subscriptions,
    start, stop, open, async restart() { await context?.close(); context = null; await stop(); await start(); return open() } }
}

test('stock alpha rejects the original manifest without a peer bypass', { timeout: 240000,
  skip: !enabled || !hosts[1].cli || !process.env.SUBSCRIPTIONS_BASELINE_PACKAGE ? 'Configure the optional baseline tgz and alpha CLI' : false }, async t => {
  const f = await fixture(t, hosts[1], false)
  let refusal
  await assert.rejects(f.command(['plugin', '--profile', 'subscriptions-native', 'add', 'file:' + resolve(process.env.SUBSCRIPTIONS_BASELINE_PACKAGE)]),
    error => { refusal = error.message; return /incompatible|compatib|peer|4\.0\.5-alpha\.1|3\.18\.5-alpha\.1/i.test(refusal) })
  assert.deepEqual((await f.call('pluginManager/listVersionExemptions')).exemptions, {})
  assert.equal((await f.request('/api/subscriptions-auth.speed')).status, 404)
  t.diagnostic(JSON.stringify({ ...f.evidence, originalManifestRejected: true, refusal }))
})

for (const host of hosts) test(`stock ${host.version}: packed Subscriptions settings, Fast RPC, client, restart and lifecycle`, { timeout: 360000,
  skip: !enabled || !host.cli || !packagePath ? 'Configure SUBSCRIPTIONS_NATIVE=1, tgz and stock CLI paths' : false }, async t => {
  assert.match(packagePath, /\.tgz$/)
  const f = await fixture(t, host)
  const installed = JSON.parse(await readFile(join(f.profileDir, 'node_modules', 'dsh-plugin-subscriptions', 'package.json'), 'utf8'))
  const expected = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(installed.version, expected.version)
  const manifest = JSON.parse(await readFile(join(f.profileDir, 'package.json'), 'utf8'))
  assert.match(manifest.dependencies['dsh-plugin-subscriptions'], /^(?:file:|\/)/)
  assert.equal(Object.values(manifest.dependencies).some(value => String(value).startsWith('link:')), false)
  assert.deepEqual((await f.call('pluginManager/listVersionExemptions')).exemptions, {})
  const status = await f.subscriptions('status')
  assert.deepEqual(status.providers.codex.accounts, [])
  assert.deepEqual(status.providers.codex.clientVersion, { version: '0.134.0', source: 'config' })
  assert.equal(status.providers.claude.clientVersion, undefined, 'Claude is not configured or probed')
  assert.deepEqual((await f.subscriptions('providerSettings', { provider: 'codex' })).accounts, [])
  assert.deepEqual(await f.subscriptions('speed', { sessionId: 'native-speed' }), { tier: 'standard', fastModels: [] })
  await f.subscriptions('setSpeed', { sessionId: 'native-speed', tier: 'fast' })
  assert.deepEqual(await f.subscriptions('speed', { sessionId: 'native-speed' }), { tier: 'fast', fastModels: [] })
  const registered = await f.rpc('workspace/create', { path: f.workspace })
  const { sessionId } = await f.rpc('session/create', { workspaceId: registered.workspace.workspaceId })
  await f.rpc('session/rename', { sessionId, title: 'Subscriptions 原生验收' })
  let page = await f.open()
  const selectSession = async () => {
    // Stock sidebars omit unsent sessions. Its fresh composer already binds a
    // native session and invokes the actual injected speed slot; no paid prompt
    // is needed merely to make a named row appear in the sidebar.
    await page.locator('[data-composer-input]').waitFor()
    await until(() => f.subscriptionCalls.includes('subscriptions-auth.speed'))
    assert.equal(await page.getByRole('button', { name: 'Fast 模式', exact: true }).count(), 0)
  }
  await selectSession()
  assert.equal(await page.evaluate(() => typeof window.__ModuleLoader__?.load), 'function')
  assert.ok(f.resources.some(row => row.status === 200 && row.url.includes('dsh-plugin-subscriptions/client.js')))
  const settings = () => page.getByRole('dialog', { name: '设置', exact: true })
  const openSettings = async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await settings().getByRole('button', { name: '订阅', exact: true }).click()
    await settings().getByText('CLI 0.134.0', { exact: false }).waitFor()
  }
  await openSettings()
  assert.equal(await settings().getByRole('combobox', { name: '状态栏额度显示', exact: true }).count(), 1)
  await page.keyboard.press('Escape')
  page = await f.restart(); await selectSession(); await openSettings(); await page.keyboard.press('Escape')
  assert.deepEqual(await f.subscriptions('speed', { sessionId: 'native-speed' }), { tier: 'fast', fastModels: [] })
  assert.equal((await f.call('pluginManager/setBundleEnabled', { name: 'dsh-plugin-subscriptions', enabled: false })).application, 'applied')
  await until(async () => (await f.request('/api/subscriptions-auth.speed')).status === 404)
  await page.reload(); await selectSession()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  assert.equal(await settings().getByRole('button', { name: '订阅', exact: true }).count(), 0)
  await page.keyboard.press('Escape')
  assert.equal((await f.call('pluginManager/setBundleEnabled', { name: 'dsh-plugin-subscriptions', enabled: true })).application, 'applied')
  await until(async () => { try { return (await f.subscriptions('speed', { sessionId: 'native-speed' })).tier === 'fast' } catch { return false } })
  await page.reload(); await selectSession(); await openSettings(); await page.keyboard.press('Escape')
  assert.equal((await f.call('pluginManager/removeBundle', { name: 'dsh-plugin-subscriptions' })).application, 'applied')
  await until(async () => (await f.request('/api/subscriptions-auth.speed')).status === 404)
  await page.reload(); await selectSession()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  assert.equal(await settings().getByRole('button', { name: '订阅', exact: true }).count(), 0)
  assert.deepEqual((await f.call('pluginManager/listVersionExemptions')).exemptions, {})
  assert.deepEqual(f.errors, [])
  t.diagnostic(JSON.stringify({ ...f.evidence, packageVersion: installed.version, actualModuleLoader: true, settingsHooksRendered: true,
    accountlessFastHidden: true, fastRpcPersistence: true, processRestart: true, bundleDisableEnable: true, uninstall404: true,
    removedSettingsSlot: true, clickableFast: 'not exercised without a synthetic account/catalog', subscriptionCalls: [...new Set(f.subscriptionCalls)] }))
})
