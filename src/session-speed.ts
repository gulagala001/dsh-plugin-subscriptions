import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Persist the speed choice independently for each native DSH session. */
export class SessionSpeedStore {
  private cache = new Map<string, 'standard' | 'fast'>()
  private writes = new Map<string, Promise<void>>()
  constructor(private directory = dshHomePath('plugins', 'subscriptions', 'speed-sessions')) {}
  private filename(id: string): string {
    if (!id || id.length > 200 || id.includes('\0')) throw new Error('Invalid session ID')
    return join(this.directory, createHash('sha256').update(id).digest('hex') + '.json')
  }
  get(id: string): 'standard' | 'fast' {
    if (!this.cache.has(id)) {
      let tier: 'standard' | 'fast' = 'standard'
      try {
        const saved = JSON.parse(readFileSync(this.filename(id), 'utf8')) as { tier?: unknown }
        if (saved.tier !== 'standard' && saved.tier !== 'fast') throw new Error('Invalid speed preference')
        tier = saved.tier
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      this.cache.set(id, tier)
    }
    return this.cache.get(id)!
  }
  async set(id: string, tier: 'standard' | 'fast'): Promise<void> {
    const file = this.filename(id)
    const operation = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = file + '.' + randomUUID() + '.tmp'
      await writeFile(temporary, JSON.stringify({ tier }) + '\n', { mode: 0o600 })
      await rename(temporary, file)
      this.cache.set(id, tier)
    })
    this.writes.set(id, operation)
    try { await operation } finally { if (this.writes.get(id) === operation) this.writes.delete(id) }
  }
}
