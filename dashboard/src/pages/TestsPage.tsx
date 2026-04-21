import { useRef, useState, useEffect } from 'react'

type SuiteId = 'unit' | 'integration'
type RunState = 'idle' | 'running' | 'passed' | 'failed'

interface Suite {
  id: SuiteId
  label: string
  description: string
}

const SUITES: Suite[] = [
  { id: 'unit',        label: 'Unit',        description: 'Fast in-process tests, no external dependencies' },
  { id: 'integration', label: 'Integration', description: 'Real LLM calls — requires ANTHROPIC_API_KEY, ~90s timeout' },
]

function statusBadge(state: RunState) {
  if (state === 'running') return <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-zinc-700 text-zinc-400 animate-pulse">running</span>
  if (state === 'passed')  return <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-green-900/50 text-green-400">passed</span>
  if (state === 'failed')  return <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-red-900/50 text-red-400">failed</span>
  return null
}

export default function TestsPage() {
  const [activeSuite, setActiveSuite] = useState<SuiteId | null>(null)
  const [runState, setRunState] = useState<RunState>('idle')
  const [lines, setLines] = useState<string[]>([])
  const esRef = useRef<EventSource | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom as output arrives
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [lines])

  function runSuite(id: SuiteId) {
    if (runState === 'running') return
    esRef.current?.close()
    setActiveSuite(id)
    setRunState('running')
    setLines([])

    const es = new EventSource(`/api/tests/run?suite=${id}`)
    esRef.current = es

    es.addEventListener('line', (e) => {
      const { text } = JSON.parse(e.data) as { text: string }
      setLines(prev => [...prev, text])
    })

    es.addEventListener('done', (e) => {
      const { passed } = JSON.parse(e.data) as { passed: boolean }
      setRunState(passed ? 'passed' : 'failed')
      es.close()
    })

    es.onerror = () => {
      setRunState('failed')
      es.close()
    }
  }

  function stop() {
    esRef.current?.close()
    esRef.current = null
    setRunState('idle')
  }

  // Cleanup on unmount
  useEffect(() => () => { esRef.current?.close() }, [])

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-6 pb-4 border-b border-zinc-800 shrink-0">
        <h1 className="text-lg font-semibold text-zinc-100">Tests</h1>
      </div>

      <div className="flex-1 flex flex-col min-h-0 px-6 py-6 gap-5">
        {/* Suite cards */}
        <div className="grid grid-cols-2 gap-3 shrink-0">
          {SUITES.map(suite => {
            const isActive = activeSuite === suite.id
            const cardState = isActive ? runState : 'idle'
            return (
              <div
                key={suite.id}
                className={`px-4 py-3 rounded-lg border transition-colors ${
                  isActive && runState !== 'idle'
                    ? runState === 'passed'
                      ? 'bg-green-950/30 border-green-900/50'
                      : runState === 'failed'
                        ? 'bg-red-950/30 border-red-900/50'
                        : 'bg-zinc-800/60 border-zinc-700'
                    : 'bg-zinc-900/50 border-zinc-800'
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-sm font-medium text-zinc-200">{suite.label}</span>
                  {statusBadge(cardState)}
                </div>
                <p className="text-xs text-zinc-500 mb-3">{suite.description}</p>
                <button
                  onClick={() => runSuite(suite.id)}
                  disabled={runState === 'running'}
                  className="px-3 py-1 rounded text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Run
                </button>
              </div>
            )
          })}
        </div>

        {/* Output pane */}
        <div className="flex-1 flex flex-col min-h-0 rounded-lg border border-zinc-800 bg-zinc-950/60 overflow-hidden">
          <div className="px-4 py-2 border-b border-zinc-800 flex items-center gap-2 shrink-0">
            <span className="text-xs text-zinc-500">
              {activeSuite ? `${SUITES.find(s => s.id === activeSuite)!.label} output` : 'Output'}
            </span>
            <div className="flex-1" />
            {runState === 'running' && (
              <button
                onClick={stop}
                className="text-xs text-red-700 hover:text-red-500 transition-colors"
              >
                Stop
              </button>
            )}
          </div>
          <div
            ref={outputRef}
            className="flex-1 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed text-zinc-300 whitespace-pre-wrap"
          >
            {lines.length === 0 ? (
              <span className="text-zinc-500">Run a suite to see output here.</span>
            ) : (
              lines.map((line, i) => (
                <div
                  key={i}
                  className={
                    /✓|PASS|passed/.test(line) ? 'text-green-400' :
                    /✗|FAIL|failed|Error/.test(line) ? 'text-red-400' :
                    /^\s*\d+ (passed|failed)/.test(line) ? 'text-zinc-200 font-semibold' :
                    'text-zinc-400'
                  }
                >
                  {line || '\u00a0'}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
