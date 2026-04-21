import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { TraceFile } from '../types/api'
import { formatInTz, useConfigTimezone } from '../lib/formatTime'

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function TraceViewer({ filename }: { filename: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['trace', filename],
    queryFn: () => api.traces.get(filename),
    staleTime: 30_000,
  })

  if (isLoading) return <div className="text-sm text-zinc-500 p-4">Loading…</div>
  if (isError) return <div className="text-sm text-red-500 p-4">Failed to load trace</div>

  return (
    <pre className="text-xs text-zinc-300 font-mono whitespace-pre-wrap break-words leading-5 p-4">
      {data?.content}
    </pre>
  )
}

export default function LogsPage() {
  const [selected, setSelected] = useState<string | null>(null)
  const tz = useConfigTimezone()

  const { data, isLoading } = useQuery({
    queryKey: ['traces'],
    queryFn: api.traces.list,
  })

  const SOURCE_COLORS: Record<string, string> = {
    head:     'text-blue-400',
    agent:    'text-yellow-400',
    steward:    'text-purple-400',
    process:  'text-green-400',
    standard: 'text-zinc-400',
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-6 pb-4 border-b border-zinc-800 shrink-0">
        <h1 className="text-lg font-semibold text-zinc-100">Logs</h1>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* File list */}
        <div className="w-64 shrink-0 border-r border-zinc-800 overflow-y-auto">
          {isLoading && <div className="text-sm text-zinc-500 py-8 text-center">Loading…</div>}
          {!isLoading && (data?.files ?? []).length === 0 && (
            <div className="text-sm text-zinc-500 py-8 text-center">
              No trace files found
              {data?.traceDir && <div className="text-xs mt-1">{data.traceDir}</div>}
            </div>
          )}
          {(data?.files ?? []).map((f: TraceFile) => (
            <button
              key={f.filename}
              onClick={() => setSelected(f.filename)}
              className={`w-full text-left px-3 py-2.5 border-b border-zinc-800/50 hover:bg-zinc-800/50 transition-colors ${
                selected === f.filename ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'
              }`}
            >
              <div className={`text-xs font-mono font-medium truncate ${SOURCE_COLORS[f.sourceType] ?? 'text-zinc-400'}`}>
                {f.isLatest ? `${f.sourceType}-latest` : f.filename.replace(/\.log$/, '')}
              </div>
              <div className="text-[11px] text-zinc-500 mt-0.5 flex gap-2">
                <span>{formatBytes(f.sizeBytes)}</span>
                <span>{formatInTz(f.modifiedAt, tz, { includeSeconds: true })}</span>
              </div>
            </button>
          ))}
        </div>

        {/* Viewer */}
        <div className="flex-1 overflow-auto bg-zinc-950">
          {selected
            ? <TraceViewer filename={selected} />
            : <div className="text-sm text-zinc-500 py-8 text-center">Select a file</div>
          }
        </div>
      </div>
    </div>
  )
}
