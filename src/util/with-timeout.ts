/**
 * Error thrown when {@link withTimeout} fires before its wrapped promise settles.
 * Distinguishable from a real failure so callers can log "timed out" specifically.
 */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

/**
 * Race `promise` against a timeout.
 *
 * If the timeout fires first, the returned promise rejects with a
 * {@link TimeoutError}. JS promises are not cancellable, so the original
 * `promise` keeps running — but any **late** settlement (resolve OR reject)
 * after the timeout has already won is swallowed, so a hung operation that
 * eventually rejects can never surface as an unhandledRejection.
 *
 * Used at startup to wrap each channel `adapter.start()` so one channel whose
 * connect never settles can't wedge the whole boot (dashboard, scheduler,
 * activation loop are all gated behind channel bring-up).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new TimeoutError(label, ms))
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
