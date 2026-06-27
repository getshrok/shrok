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
        {!appsQuery.isLoading && apps.length === 0 && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-6 py-8 text-sm text-zinc-500 text-center">
            No apps yet — ask shrok to build one.
          </div>
        )}
        {apps.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {apps.map(({ slug, meta }) => (
              <a
                key={slug}
                href={`/apps/${slug}/`}
                className="block px-4 py-4 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/60 hover:border-zinc-700 transition-colors text-center"
              >
                <div className="text-3xl mb-2">{meta.icon ?? '📦'}</div>
                <div className="text-sm font-medium text-zinc-200">{meta.title ?? slug}</div>
                {meta.desc && <p className="mt-1 text-xs text-zinc-500">{meta.desc}</p>}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
