import { useState, useRef, useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { createPortal } from 'react-dom'
import Sidebar from './Sidebar'
import SettingsModal from '../../pages/settings'
import { useAssistantName } from '../../lib/assistant-name'
import { api } from '../../lib/api'

export function RestartModal({ onClose, immediate }: { onClose: () => void; immediate?: boolean }) {
  const assistantName = useAssistantName()
  const [restarting, setRestarting] = useState(immediate ?? false)
  const firedRef = useRef(false)

  function pollUntilReady() {
    const poll = () => {
      fetch('/api/auth/me', { credentials: 'include' })
        .then(res => {
          // Server is back — reload whether authenticated or session expired (401 triggers login)
          if (res.ok || res.status === 401) window.location.reload()
          else setTimeout(poll, 2000)
        })
        .catch(() => setTimeout(poll, 2000))
    }
    setTimeout(poll, 3000)
  }

  async function handleRestart() {
    if (restarting) return
    setRestarting(true)
    await api.controls.restart().catch(() => {})
    pollUntilReady()
  }

  // If immediate, fire the restart on mount (once)
  useEffect(() => {
    if (immediate && !firedRef.current) {
      firedRef.current = true
      api.controls.restart().catch(() => {})
      pollUntilReady()
    }
  }, [immediate])

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-black/70" />
      <div className="fixed z-50 flex items-center justify-center" style={{ inset: 0 }}>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-6 w-full max-w-sm mx-4">
          <h2 className="text-base font-semibold text-zinc-100 mb-2">
            {restarting ? 'Restarting..' : 'Restart required'}
          </h2>
          <p className="text-sm text-zinc-400 mb-6">
            {restarting
              ? `This page will reload automatically when ${assistantName} is back up.`
              : `Settings saved. ${assistantName} needs to restart to apply the changes.`}
          </p>
          {restarting && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
              Reconnecting
            </div>
          )}
          {!restarting && (
            <div className="flex gap-2 justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg border border-zinc-700 transition-colors"
              >
                Later
              </button>
              <button
                onClick={handleRestart}
                className="px-4 py-2 text-sm font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg border border-[var(--accent)]/50 transition-colors"
              >
                Restart Now
              </button>
            </div>
          )}
        </div>
      </div>
    </>,
    document.body
  )
}

function ConnectionLostModal() {
  const assistantName = useAssistantName()
  useEffect(() => {
    const poll = () => {
      fetch('/api/auth/me', { credentials: 'include' })
        .then(res => {
          if (res.ok) window.location.reload()
          // Server is up but session expired — reload to trigger login
          else if (res.status === 401) window.location.reload()
          else setTimeout(poll, 2000)
        })
        .catch(() => setTimeout(poll, 2000))
    }
    setTimeout(poll, 3000)
  }, [])

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-black/70" />
      <div className="fixed z-50 flex items-center justify-center" style={{ inset: 0 }}>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-6 w-full max-w-sm mx-4">
          <h2 className="text-base font-semibold text-zinc-100 mb-2">Connection lost</h2>
          <p className="text-sm text-zinc-400 mb-4">
            {assistantName} stopped responding. This page will reload automatically when it's back up.
          </p>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
            Reconnecting
          </div>
        </div>
      </div>
    </>,
    document.body
  )
}

export default function AppShell() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [restartOpen, setRestartOpen] = useState(false)
  const [connectionLost, setConnectionLost] = useState(false)
  const failCountRef = useRef(0)

  // Heartbeat: poll the backend every 10s to detect unexpected downtime
  useEffect(() => {
    const interval = setInterval(() => {
      fetch('/api/auth/me', { credentials: 'include' })
        .then(res => {
          if (res.ok) failCountRef.current = 0
          // 401 means the server is up but session expired — reload to trigger login
          else if (res.status === 401) window.location.reload()
          else failCountRef.current++
        })
        .catch(() => { failCountRef.current++ })
        .finally(() => {
          // Show modal after 2 consecutive failures (~20s of downtime)
          if (failCountRef.current >= 2 && !restartOpen) setConnectionLost(true)
          if (failCountRef.current === 0) setConnectionLost(false)
        })
    }, 10_000)
    return () => clearInterval(interval)
  }, [restartOpen])

  return (
    <div className="flex h-screen bg-zinc-950">
      <Sidebar onSettingsOpen={() => setSettingsOpen(true)} />
      <main className="flex-1 overflow-auto overflow-x-hidden">
        <Outlet />
      </main>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => setRestartOpen(true)}
      />
      {restartOpen && <RestartModal onClose={() => setRestartOpen(false)} />}
      {connectionLost && !restartOpen && <ConnectionLostModal />}
    </div>
  )
}
