// Pure timer-reset helper — unit-testable in node env (no DOM, no React).
export type VoiceErrorMessage =
  | 'Microphone access denied'
  | 'Voice disconnected'
  | 'Voice error — please try again'
  | 'Voice requires iOS 17.1+ or Chrome on Android'

export interface ErrorTimerHandle {
  /** Set or replace the active error. Clears any pending dismiss timer and
   *  schedules a fresh 4000ms timer that calls onClear() when it fires. */
  setError(message: VoiceErrorMessage): void
  /** Cancel any pending dismiss timer and call onClear() synchronously.
   *  Used on unmount and on explicit toggle-off. */
  clear(): void
}

export function createErrorTimer(
  onSet: (m: VoiceErrorMessage) => void,
  onClear: () => void,
  setTimeoutFn: typeof setTimeout = setTimeout,
  clearTimeoutFn: typeof clearTimeout = clearTimeout,
  ttlMs: number = 4000,
): ErrorTimerHandle {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    setError(message) {
      if (timer !== null) clearTimeoutFn(timer)
      onSet(message)
      timer = setTimeoutFn(() => { timer = null; onClear() }, ttlMs)
    },
    clear() {
      if (timer !== null) { clearTimeoutFn(timer); timer = null }
      onClear()
    },
  }
}
