import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'

interface Theme {
  accentColor: string
  logoUrl: string
}

const ThemeContext = createContext<Theme>({ accentColor: '#8C51CD', logoUrl: '/logo.svg' })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings.get })
  const [theme, setTheme] = useState<Theme>({ accentColor: '#8C51CD', logoUrl: '/logo.svg' })

  useEffect(() => {
    if (!settings) return
    setTheme({
      accentColor: settings.accentColor || '#8C51CD',
      logoUrl: settings.logoPath ? `/api/branding/${settings.logoPath}` : '/logo.svg',
    })
  }, [settings?.accentColor, settings?.logoPath])

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', theme.accentColor)
    document.documentElement.style.setProperty('--accent-hover', `color-mix(in srgb, ${theme.accentColor} 85%, black)`)

    let link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link) }
    link.href = theme.logoUrl
    link.type = ''
  }, [theme.accentColor, theme.logoUrl])

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
}

export const useTheme = () => useContext(ThemeContext)
