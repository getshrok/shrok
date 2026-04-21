import { useEffect, useCallback, useRef } from 'react'
import { useBlocker } from 'react-router-dom'

/** Global dirty checks for non-route navigation (e.g. switching entries within a page) */
const dirtyChecks = new Set<() => boolean>()

/** Returns true if OK to proceed. Shows confirm if any editor is dirty. */
export function confirmIfDirty(): boolean {
  for (const check of dirtyChecks) {
    if (check()) {
      return window.confirm('You have unsaved changes. Leave without saving?')
    }
  }
  return true
}

/**
 * Warns the user when they try to leave with unsaved changes.
 * - Browser close / refresh: native beforeunload prompt
 * - In-app navigation: React Router useBlocker
 *
 * IMPORTANT: This hook must be called unconditionally — never below
 * an early return. useBlocker registers internal hooks, so skipping
 * it on some renders causes React error #310 (hook count mismatch).
 */
export function useUnsavedGuard(isDirty: boolean): void {
  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }: { currentLocation: { pathname: string }; nextLocation: { pathname: string } }) =>
        isDirty && currentLocation.pathname !== nextLocation.pathname,
      [isDirty],
    ),
  )

  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (window.confirm('You have unsaved changes. Leave without saving?')) {
        blocker.proceed()
      } else {
        blocker.reset()
      }
    }
  }, [blocker])

  useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  // Register with global dirty checks for non-route navigation
  const dirtyRef = useRef(isDirty)
  dirtyRef.current = isDirty
  useEffect(() => {
    const check = () => dirtyRef.current
    dirtyChecks.add(check)
    return () => { dirtyChecks.delete(check) }
  }, [])
}
