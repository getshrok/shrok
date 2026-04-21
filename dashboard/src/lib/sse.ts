import type { DashboardEvent } from '../types/api'

export function connectSSE(onEvent: (event: DashboardEvent) => void): () => void {
  let es: EventSource
  let closed = false

  function connect() {
    es = new EventSource('/api/stream')

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data as string) as DashboardEvent
        onEvent(data)
      } catch {
        // ignore malformed frames
      }
    }

    es.onerror = () => {
      es.close()
      if (!closed) {
        setTimeout(connect, 3000)
      }
    }
  }

  connect()

  return () => {
    closed = true
    es.close()
  }
}
