import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

export default function AppsPage() {
  const appsQuery = useQuery({
    queryKey: ['apps'],
    queryFn: api.apps.list,
  })

  const apps = appsQuery.data ?? []

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-6 pb-4 border-b border-zinc-800 shrink-0">
        <h1 className="text-lg font-semibold text-zinc-100">Apps</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {appsQuery.isLoading && (
          <p className="px-2 py-1 text-xs text-zinc-500">Loading…</p>
        )}
        {appsQuery.isError && (
          <p className="px-2 py-1 text-xs text-red-400">Failed to load apps</p>
        )}
        {!appsQuery.isLoading && !appsQuery.isError && apps.length === 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-6 py-8 text-sm text-zinc-500 text-center">
            No apps yet — ask shrok to build one.
          </div>
        )}
        {apps.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {apps.map(({ slug, meta }) => {
              // The wire does not guarantee meta is an object of strings (it comes
              // from an unguarded JSON.parse on the server). Normalize defensively so
              // a malformed meta.json (e.g. top-level null/array/scalar, or a non-string
              // field) lists as a plain tile instead of crashing the whole page (T-57-04).
              const m = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {}
              const icon = typeof m.icon === 'string' && m.icon ? m.icon : '📦'
              const title = typeof m.title === 'string' && m.title ? m.title : slug
              const desc = typeof m.desc === 'string' && m.desc ? m.desc : null
              return (
                <a
                  key={slug}
                  href={`/apps/${slug}/`}
                  className="block px-4 py-4 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/60 hover:border-zinc-700 transition-colors text-center"
                >
                  <div className="text-3xl mb-2">{icon}</div>
                  <div className="text-sm font-medium text-zinc-200">{title}</div>
                  {desc && <p className="mt-1 text-xs text-zinc-500">{desc}</p>}
                </a>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
