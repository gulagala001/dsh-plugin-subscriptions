import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Persist the speed choice independently for each native DSH session. */
export class SessionSpeedStore {
  private cache = new Map<string, 'standard' | 'fast'>()
  private writes = new Map<string, Promise<void>>()
  private readFailures = new Map<string, string>()
  constructor(
    private directory = dshHomePath('plugins', 'subscriptions', 'speed-sessions'),
    private onWarn: (message: string) => void = message => console.warn(`dsh-plugin-subscriptions: ${message}`),
  ) {}
  private filename(id: string): string {
    if (!id || id.length > 200 || id.includes('\0')) throw new Error('Invalid session ID')
    return join(this.directory, createHash('sha256').update(id).digest('hex') + '.json')
  }
  get(id: string): 'standard' | 'fast' {
    const file = this.filename(id)
    if (!this.cache.has(id)) {
      let tier: 'standard' | 'fast' = 'standard'
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as { tier?: unknown } | null
        if (saved === null) throw new Error('Invalid speed preference')
        if (saved.tier !== 'standard' && saved.tier !== 'fast') throw new Error('Invalid speed preference')
        tier = saved.tier
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Avoid logging JSON parser messages, which may echo file contents.
          const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.name : 'UnknownError')
          const message = `Could not read session speed preference at ${file} (${reason}); using standard and preserving the file. Repair or remove it before saving a new preference.`
          this.readFailures.set(id, message)
          // Even a failing diagnostic sink must not interrupt a model request.
          try { this.onWarn(message) } catch {}
        }
      }
      this.cache.set(id, tier)
    }
    return this.cache.get(id)!
  }
  async set(id: string, tier: 'standard' | 'fast'): Promise<void> {
    const file = this.filename(id)
    const operation = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      // Recheck on an explicit save: external damage must not be overwritten,
      // and repairing a preference must not require a host restart.
      this.cache.delete(id)
      this.readFailures.delete(id)
      this.get(id)
      const failure = this.readFailures.get(id)
      if (failure) throw new Error(failure)
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = file + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temporary, JSON.stringify({ tier }) + '\n', { mode: 0o600 })
        await rename(temporary, file)
      } finally { await rm(temporary, { force: true }).catch(() => {}) }
      this.cache.set(id, tier)
    })
    this.writes.set(id, operation)
    try { await operation } finally { if (this.writes.get(id) === operation) this.writes.delete(id) }
  }
}
