/**
 * Codex Speed toggle: one small control in the composer's right tool row
 * (`conversation.input.right`), switching the session between standard routing
 * and the fast (priority) service tier — the Codex desktop app's Speed menu.
 * The choice persists per session in the node half; this
 * component holds only viewing state. The control renders nothing until the
 * first load proves the session's current model is a codex model whose catalog
 * advertises the fast tier.
 *
 * Every color resolves through a `--dsw-alias-*` design token and every
 * user-visible string goes through the locale `t` of the
 * 'settings.subscriptions' namespace, same as the settings section.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

/** One session's speed choice: standard routing or the fast (priority) tier. */
export type SpeedTier = 'standard' | 'fast'

/** `speed` endpoint value, mirrored from the node half. */
export interface SpeedState {
  tier: SpeedTier
  fastModels: string[]
}

/** What {@link SpeedSelect} renders from: visibility plus the current tier. */
export interface SpeedSelectState {
  visible: boolean
  tier: SpeedTier
}

/**
 * Minimal structural face of ui-model-selection's `ctx.modelDirectories`
 * service (the sanctioned cross-plugin channel: cordis services, not value
 * imports — same mirroring discipline as ToolCallOwnerProps). Both dsh lines
 * ship it with this shape; it replaces rc.2's `connection.api.sessions.models`
 * read, which the 0.1.2-alpha removed along with the whole `.api` face.
 */
export interface ModelDirectoriesLike {
  /** Resolve one session's shared model directory (throws for unknown sessions). */
  directoryFor(sessionId: string): {
    /** Load the directory; `current` is the session's effective model selection. */
    load(): Promise<{ current: { provider: string; model: string } | null }>
  }
}

/** Injected dependencies of {@link SpeedSelect} (slot `inject`, session-bound). */
export interface SpeedSelectInjected {
  sessionId?: string
  selectionStore?: { subscribe(fn: () => void): () => void; getSnapshot(): { next?: { provider: string; model: string }; lastUsed?: { provider: string; model: string } } | undefined } | undefined
  /** Load the session's speed state; `visible` false keeps the control hidden. */
  loadSpeed: () => Promise<SpeedSelectState>
  /** Set the session's speed tier; resolves false when the write failed. */
  setSpeed: (tier: SpeedTier) => Promise<boolean>
}

/**
 * Props delivered by the slot outlet: the framework session kit and InputZone
 * owner share (unused — everything arrives session-bound through the inject
 * face), the injected callbacks, and the locale seat.
 */
export type SpeedSelectProps = PropsRuntime<'conversation.input.right'>
  & Partial<SpeedSelectInjected>
  & Partial<PropsLocale<'settings.subscriptions'>>

/**
 * The `loadSpeed` half of the inject face: the plugin's own speed state plus
 * the host's current model selection (the visibility gate). A model-RPC
 * failure throws rather than answering "hidden" — the caller keeps its last
 * known state, so a transient failure never locks the toggle away.
 *
 * `sessionId` is a plain string: slot and command contexts brand it through
 * different dsh-session copies, and only the service boundary needs one.
 *
 * `models` resolves lazily per call: the ui-model-selection service may
 * register after this plugin applies, and a shell without it (no model seat
 * at all) simply keeps the toggle hidden.
 */
export function createSpeedLoader(
  connection: ConnectionHandle,
  models: () => ModelDirectoriesLike | undefined,
  sessionId: string,
): SpeedSelectInjected['loadSpeed'] {
  return async () => {
    const state = await callSubscriptionsAuth<SpeedState>(connection.rpc, 'speed', { sessionId })
    const directories = models()
    if (directories === undefined) return { visible: false, tier: state.tier }
    const { current } = await directories.directoryFor(sessionId).load()
    const visible = current !== null && ['codex', 'openai-codex'].includes(current.provider)
      && state.fastModels.includes(current.model)
    return { visible, tier: state.tier }
  }
}

/** The `setSpeed` half of the inject face: boolean outcome for the component's busy state. */
export function createSpeedSetter(
  connection: ConnectionHandle,
  sessionId: string,
): SpeedSelectInjected['setSpeed'] {
  return tier => callSubscriptionsAuth(connection.rpc, 'setSpeed', { sessionId, tier })
    .then(() => true, () => false)
}

/** English-dictionary fallback for a missing inject `t` (standalone renders). */
function fallbackTranslate(key: SubscriptionsKey): string {
  return en[key]
}

const emptySelection = { subscribe: (_fn: () => void) => () => {}, getSnapshot: () => undefined }

/** Compact one-click Fast switch, scoped to the active native session. */
export function SpeedSelect({ loadSpeed, setSpeed, t, sessionId, selectionStore }: SpeedSelectProps) {
  const translate = t ?? fallbackTranslate
  const [state, setState] = useState<SpeedSelectState | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const generation = useRef(0)
  const revision = useRef(0)
  const writing = useRef(false)
  const loadRef = useRef(loadSpeed)
  loadRef.current = loadSpeed
  const store = selectionStore ?? emptySelection
  const selection = useSyncExternalStore(fn => store.subscribe(fn), () => store.getSnapshot())
  const selected = selection?.next ?? selection?.lastUsed
  const scope = JSON.stringify([sessionId, selected?.provider, selected?.model])
  const [stateScope, setStateScope] = useState<string | null>(null)
  useEffect(() => {
    const ticket = ++generation.current
    writing.current = false
    setState(null)
    setStateScope(null)
    setBusy(false)
    setSaveFailed(false)
    let inflight = false
    const reload = (): void => {
      if (!loadRef.current || inflight || writing.current) return
      const readRevision = revision.current
      inflight = true
      const load = loadRef.current
      void Promise.resolve().then(load).then(loaded => {
        if (ticket === generation.current && readRevision === revision.current && !writing.current) {
          setState(loaded)
          setStateScope(scope)
        }
      }, () => {}).finally(() => { inflight = false })
    }
    reload()
    const timer = setInterval(reload, 3000)
    return () => { ++generation.current; clearInterval(timer) }
  }, [scope])
  if (!setSpeed || stateScope !== scope || !state?.visible || (selected && !['codex', 'openai-codex'].includes(selected.provider))) return null
  const enabled = state.tier === 'fast'
  const label = 'Fast · ' + translate(enabled ? 'speedFast' : 'speedStandard')
  return <button type="button" aria-label="Fast 模式" aria-pressed={enabled}
    title={saveFailed ? translate('speedSaveFailed') : label} disabled={busy}
    style={{ ...styles.trigger, color: enabled ? 'var(--dsw-alias-brand-primary, #4d6fe9)' : 'var(--dsw-alias-label-secondary)' }}
    onClick={() => {
      if (busy || writing.current) return
      const ticket = generation.current
      const tier = enabled ? 'standard' : 'fast'
      // Invalidate every earlier read, including a poll still waiting when
      // this write succeeds; pause new reads until the write settles.
      ++revision.current
      writing.current = true
      setBusy(true)
      setSaveFailed(false)
      const finish = (ok: boolean): void => {
        if (ticket !== generation.current) return
        writing.current = false
        setBusy(false)
        if (ok) { setState({ visible: true, tier }); setStateScope(scope) }
        else setSaveFailed(true)
      }
      void Promise.resolve().then(() => setSpeed(tier)).then(finish, () => finish(false))
    }}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill={enabled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 10-12h-7l1-8Z" /></svg>
  </button>
}

const styles: Record<string, CSSProperties> = {
  trigger: {
    border: 'none', borderRadius: 6, background: 'transparent',
    padding: 4, width: 28, height: 28, display: 'inline-flex',
    alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
  },
}
