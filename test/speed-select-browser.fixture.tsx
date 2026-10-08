import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SpeedSelect } from '../src/client/SpeedSelect.js'
import type { SpeedSelectState } from '../src/client/SpeedSelect.js'

// Harness functions are installed before this entirely offline fixture loads.
declare global {
  interface Window {
    selection: { next: { provider: string; model: string } }
    selectFastModel: (next: { provider: string; model: string }) => void
    selectFastSession: (id: string) => void
    requestSpeed: (kind: string, payload: unknown) => Promise<unknown>
  }
}
const listeners = new Set<() => void>()
const selectionStore = {
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  getSnapshot: () => window.selection,
}
window.selectFastModel = next => {
  window.selection = { next }
  for (const fn of listeners) fn()
}
function App() {
  const [sessionId, setSessionId] = useState('a')
  window.selectFastSession = setSessionId
  return <SpeedSelect {...({ sessionId, selectionStore,
    loadSpeed: () => window.requestSpeed('read', { sessionId }) as Promise<SpeedSelectState>,
    setSpeed: (tier: string) => window.requestSpeed('write', { sessionId, tier }) as Promise<boolean>,
  } as Parameters<typeof SpeedSelect>[0])} />
}
createRoot(document.getElementById('root')!).render(<App />)
