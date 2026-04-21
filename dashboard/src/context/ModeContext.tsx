import { createContext, useContext, useState } from 'react'

export type Mode = 'standard' | 'developer'

interface ModeContextValue {
  mode: Mode
  isDeveloper: boolean
  setMode: (mode: Mode) => void
}

const ModeContext = createContext<ModeContextValue | null>(null)

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<Mode>(() => {
    const stored = localStorage.getItem('mode')
    return stored === 'developer' ? stored : 'standard'
  })

  function setMode(next: Mode) {
    localStorage.setItem('mode', next)
    setModeState(next)
  }

  return (
    <ModeContext.Provider value={{
      mode,
      isDeveloper: mode === 'developer',
      setMode,
    }}>
      {children}
    </ModeContext.Provider>
  )
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext)
  if (!ctx) throw new Error('useMode must be used inside ModeProvider')
  return ctx
}
