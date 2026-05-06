import { useState, useRef, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import {
  MessageSquare, BrainCircuit, UserCircle, Zap, BarChart3,
  ScrollText, FlaskConical, ClipboardCheck, Settings, LogOut,
  Clock, PanelLeftClose, PanelLeftOpen, CheckSquare, BookOpen,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../auth/AuthContext'
import { api } from '../../lib/api'
import { useMode } from '../../context/ModeContext'
import { useAssistantName } from '../../lib/assistant-name'
import { useTheme } from '../../lib/theme'
import { RestartModal } from './AppShell'

const stopWarning = (name: string) => `${name} will not restart on its own.

To bring it back online:
  \u2022 Native install: run \`npm start\` in the ${name} directory
  \u2022 Docker / systemd / PM2: restart the container or service`

const EMERGENCY_STOP_WARNING = `This will cancel ALL running and suspended agents, then halt the process. Nothing will resume on next start.

Use this when something has gone wrong and you need everything to stop immediately.`

function PowerMenu() {
  const { logout } = useAuth()
  const assistantName = useAssistantName()
  const [open, setOpen] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  async function handleStop() {
    if (stopping) return
    if (!window.confirm(stopWarning(assistantName))) return
    setOpen(false)
    setStopping(true)
    await api.controls.stop().catch(() => {})
  }

  async function handleEmergencyStop() {
    if (stopping) return
    if (!window.confirm(EMERGENCY_STOP_WARNING)) return
    setOpen(false)
    setStopping(true)
    await api.controls.emergencyStop().catch(() => {})
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => !stopping && setOpen(o => !o)}
        disabled={stopping}
        title={stopping ? 'Stopping…' : 'Power'}
        className="w-6 h-6 flex items-center justify-center rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {stopping ? (
          <span className="text-[11px] text-zinc-500">■</span>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path d="M5.5 3.5A5 5 0 1 0 10.5 3.5" strokeLinecap="round"/>
            <line x1="8" y1="2" x2="8" y2="7" strokeLinecap="round"/>
          </svg>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-28 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl z-50 overflow-hidden">
          <button
            onClick={() => { setOpen(false); setRestarting(true) }}
            className="w-full text-left px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
          >
            Restart
          </button>
          <button
            onClick={() => void handleStop()}
            title="Stop the process. Agents will resume on next start."
            className="w-full text-left px-3 py-2 text-xs text-red-800 hover:bg-zinc-800 hover:text-red-500 transition-colors"
          >
            Stop
          </button>
          <button
            onClick={() => void handleEmergencyStop()}
            title="Cancel all agents and halt. Nothing resumes on next start."
            className="w-full text-left px-3 py-2 text-xs text-red-600 hover:bg-red-950 hover:text-red-400 transition-colors font-medium"
          >
            Emergency Stop
          </button>
          <div className="border-t border-zinc-800 my-0.5" />
          <button
            onClick={() => void logout()}
            className="w-full text-left px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors flex items-center gap-1.5"
          >
            <LogOut size={12} />
            Sign out
          </button>
        </div>
      )}

      {restarting && <RestartModal onClose={() => setRestarting(false)} immediate />}
    </div>
  )
}

const NAV_ICONS = {
  Conversation: MessageSquare,
  Memory: BrainCircuit,
  Identity: UserCircle,
  Skills: Zap,
  Tasks: CheckSquare,
  Schedules: Clock,
  Docs: BookOpen,
  Usage: BarChart3,
  Logs: ScrollText,
  Tests: FlaskConical,
  Evals: ClipboardCheck,
  Settings: Settings,
} as const

export default function Sidebar({ onSettingsOpen, mobileOpen, onMobileClose }: {
  onSettingsOpen: () => void
  mobileOpen?: boolean
  onMobileClose?: () => void
}) {
  const { isDeveloper } = useMode()
  const assistantName = useAssistantName()
  const { logoUrl } = useTheme()
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings.get })
  const version = settings?.version
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === '1')

  function toggleCollapsed() {
    setCollapsed(prev => {
      const next = !prev
      localStorage.setItem('sidebar-collapsed', next ? '1' : '0')
      return next
    })
  }

  // On mobile the sidebar is a fixed overlay — always full-width, never collapsed-style
  const desktopCollapsed = collapsed

  return (
    <aside className={[
      // Mobile: fixed overlay drawer
      'fixed inset-y-0 left-0 z-40',
      // Desktop: back to static flow
      'md:relative md:inset-auto md:z-auto',
      // Width: mobile always w-56; desktop depends on collapsed
      desktopCollapsed ? 'md:w-14' : 'md:w-56', 'w-56',
      // Mobile slide in/out; desktop always visible
      mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      // Transitions
      'transition-transform duration-200 md:transition-[width,transform] md:duration-150',
      'bg-zinc-900 border-r border-zinc-800 flex flex-col',
    ].join(' ')}>

      {/* Header: mobile always full-width; desktop respects collapsed */}
      <div className={`${desktopCollapsed ? 'md:px-2 md:justify-center' : ''} px-4 justify-between py-5 border-b border-zinc-800 flex items-center`}>
        <span className={`text-lg font-semibold text-[var(--accent)] flex items-center gap-2 ${desktopCollapsed ? 'md:hidden' : ''}`}>
          <img src={logoUrl} alt="" className="w-5 h-5" />{assistantName}
        </span>
        {desktopCollapsed && <img src={logoUrl} alt="" className="w-5 h-5 hidden md:block" />}
        <span className={desktopCollapsed ? 'md:hidden' : ''}>
          <PowerMenu />
        </span>
      </div>

      <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
        {[
          { to: '/', label: 'Conversation', end: true },
          { to: '/identity', label: 'Identity', end: false },
          { to: '/skills', label: 'Skills', end: false },
          { to: '/tasks', label: 'Tasks', end: false },
          { to: '/schedules', label: 'Schedules', end: false },
          { to: '/memory', label: 'Memory', end: false },
          { to: '/docs', label: 'Docs', end: false },
          ...(isDeveloper ? [{ to: '/logs', label: 'Logs', end: false }] : []),
          ...(isDeveloper ? [{ to: '/tests', label: 'Tests', end: false }] : []),
          ...(isDeveloper ? [{ to: '/evals', label: 'Evals', end: false }] : []),
        ].map(({ to, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            title={desktopCollapsed ? label : undefined}
            onClick={onMobileClose}
            className={({ isActive }) =>
              `flex items-center ${desktopCollapsed ? 'md:justify-center' : ''} gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-[var(--accent)]/10 text-zinc-100 border-l-2 border-[var(--accent)]'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 border-l-2 border-transparent'
              }`
            }
          >
            {(() => { const I = NAV_ICONS[label as keyof typeof NAV_ICONS]; return I ? <I size={16} className="shrink-0" /> : null })()}
            <span className={desktopCollapsed ? 'md:hidden' : ''}>{label}</span>
          </NavLink>
        ))}
      </nav>

      {version && !desktopCollapsed && (
        <div className="px-5 pb-1 text-[10px] text-zinc-600">v{version}</div>
      )}

      <div className="px-2 py-4 border-t border-zinc-800 space-y-1">
        <NavLink
          to="/usage"
          title={desktopCollapsed ? 'Usage' : undefined}
          onClick={onMobileClose}
          className={({ isActive }) =>
            `flex items-center ${desktopCollapsed ? 'md:justify-center' : ''} gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              isActive
                ? 'bg-[var(--accent)]/10 text-zinc-100 border-l-2 border-[var(--accent)]'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 border-l-2 border-transparent'
            }`
          }
        >
          <BarChart3 size={16} className="shrink-0" />
          <span className={desktopCollapsed ? 'md:hidden' : ''}>Usage</span>
        </NavLink>
        <button
          onClick={() => { onSettingsOpen(); onMobileClose?.() }}
          title={desktopCollapsed ? 'Settings' : undefined}
          className={`w-full flex items-center ${desktopCollapsed ? 'md:justify-center' : ''} gap-2.5 px-3 py-2 my-[2px] rounded-md text-sm font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors`}
        >
          <Settings size={16} className="shrink-0" />
          <span className={desktopCollapsed ? 'md:hidden' : ''}>Settings</span>
        </button>
        <button
          onClick={() => { toggleCollapsed(); onMobileClose?.() }}
          title={desktopCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`w-full flex items-center ${desktopCollapsed ? 'md:justify-center' : ''} gap-2.5 px-3 py-2 my-[2px] rounded-md text-sm font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors`}
        >
          <PanelLeftClose size={16} className={`shrink-0 ${desktopCollapsed ? 'md:hidden' : ''}`} />
          <span className={desktopCollapsed ? 'md:hidden' : ''}>Collapse</span>
        </button>
      </div>
    </aside>
  )
}
