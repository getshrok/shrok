import { useState, useEffect, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Fetch theme from public endpoint (no auth required)
  const [theme, setTheme] = useState({ assistantName: '', logoUrl: '/logo.svg', accentColor: '' })
  useEffect(() => {
    fetch('/api/theme')
      .then(r => r.json())
      .then((data: { assistantName: string; logoUrl: string; accentColor: string }) => {
        setTheme(data)
        if (data.assistantName) document.title = data.assistantName
        // Set favicon to custom logo
        if (data.logoUrl && data.logoUrl !== '/logo.svg') {
          let link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null
          if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link) }
          link.href = data.logoUrl
          link.type = ''
        }
        // Apply accent color to CSS vars so the button picks it up
        if (data.accentColor) {
          document.documentElement.style.setProperty('--accent', data.accentColor)
          document.documentElement.style.setProperty('--accent-hover', `color-mix(in srgb, ${data.accentColor} 85%, black)`)
        }
      })
      .catch(() => {})
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await login(password)
      void navigate('/')
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.includes('503')) setError('No password configured — run npm run setup on the server')
      else if (msg.includes('429')) setError('Too many attempts — try again later')
      else setError('Invalid password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="bg-zinc-900 px-8 py-10 rounded-xl border border-zinc-800">
          <h1 className="text-2xl font-semibold mb-8 flex items-center gap-3">
            <img src={theme.logoUrl} alt="" className="w-7 h-7" />
            <span style={{ color: theme.accentColor || 'var(--accent)' }}>{theme.assistantName}</span>
          </h1>

          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-zinc-400 mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500 focus:border-transparent"
                autoComplete="current-password"
                autoFocus
              />
            </div>

            {error && (
              <p className="text-sm text-red-400">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full py-2 px-4 bg-[var(--accent)] text-white text-sm font-medium rounded-lg hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
