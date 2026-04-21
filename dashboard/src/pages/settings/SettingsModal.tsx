import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { SettingsData } from '../../types/api'
import { useMode, type Mode } from '../../context/ModeContext'
import type { DraftState } from './draft'
import { initDraft, isDirty, buildBody } from './draft'
import { developerWarning } from './GeneralTab'
import { useAssistantName } from '../../lib/assistant-name'
import GeneralTab from './GeneralTab'
import ModelsTab from './ModelsTab'
import ChannelsTab from './ChannelsTab'
import StewardsTab from './StewardsTab'
import BehaviorTab from './BehaviorTab'
import ExperimentalTab from './ExperimentalTab'

export default function SettingsModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { mode: contextMode, setMode } = useMode()
  const assistantName = useAssistantName()
  const queryClient = useQueryClient()

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings.get,
    staleTime: 30_000,
  })

  const [vpWidth, setVpWidth] = useState(() => document.documentElement.clientWidth)
  const [vpHeight, setVpHeight] = useState(() => document.documentElement.clientHeight)
  useEffect(() => {
    function onResize() {
      setVpWidth(document.documentElement.clientWidth)
      setVpHeight(document.documentElement.clientHeight)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const [draft, setDraft] = useState<DraftState | null>(null)
  // draftMode is local to the modal — takes effect visually immediately but only
  // committed to context on Save, or discarded if the user hits Discard/Close
  const [draftMode, setDraftMode] = useState<Mode>(contextMode)
  type Tab = 'general' | 'models' | 'channels' | 'stewards' | 'behavior' | 'experimental'
  const [activeTab, setActiveTab] = useState<Tab>('general')

  // On open: reinit from latest data so saved changes are always reflected.
  // On close: clear draft so stale data isn't shown on next open.
  useEffect(() => {
    const main = document.querySelector('main') as HTMLElement | null
    if (!open) {
      setDraft(null)
      if (main) main.style.overflow = ''
      return
    }
    setDraftMode(contextMode)
    if (settingsQuery.data) setDraft(initDraft(settingsQuery.data))
    if (main) main.style.overflow = 'hidden'
    return () => { if (main) main.style.overflow = '' }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // If data arrives while modal is already open and draft is still null (first open before fetch)
  useEffect(() => {
    if (open && settingsQuery.data && draft === null) {
      setDraft(initDraft(settingsQuery.data))
    }
  }, [settingsQuery.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.settings.update(body),
    onSuccess: (_data, body) => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
      setMode(draftMode)
      onClose()
      // Only prompt restart if server-affecting settings changed (not just cosmetic ones)
      const cosmeticOnly = Object.keys(body).every(k => ['accentColor', 'logoDataUrl', 'logoPath'].includes(k))
      if (!cosmeticOnly) onSaved()
    },
  })

  function handleDiscard() {
    saveMutation.reset()
    onClose()  // triggers the open effect to clear draft
    // draftMode is discarded — contextMode is unchanged
  }

  function handleSetMode(next: Mode) {
    if (next === 'developer' && draftMode !== 'developer') {
      if (!window.confirm(developerWarning(assistantName))) return
      // Offer to turn on all visibility categories so dev mode has something to look at
      if (draft && window.confirm('Also show all internals in the conversation view? (Agent work, head tools, system events, steward runs, agent pills)')) {
        setDraft(d => d ? {
          ...d,
          conversationVisibility: {
            agentWork: true,
            headTools: true,
            systemEvents: true,
            stewardRuns: true,
            agentPills: true,
            memoryRetrievals: true,
          },
        } : d)
      }
    }
    setDraftMode(next)
  }

  function set<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft(d => d ? { ...d, [key]: value } : d)
  }

  const s = settingsQuery.data
  const d = draft

  const dirty = (s && d ? isDirty(d, s) : false) || draftMode !== contextMode

  const inputClass = "w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
  const selectClass = "w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-zinc-600"

  const tabs: { id: Tab; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'models', label: 'Models' },
    { id: 'channels', label: 'Channels' },
    { id: 'stewards', label: 'Stewards' },
    { id: 'behavior' as Tab, label: 'Behavior' },
    { id: 'experimental', label: 'Experimental' },
  ]

  const isDeveloper = draftMode === 'developer'

  if (!open) return null

  return createPortal(
    <>
      {/* Backdrop — no click-to-close, force explicit Save or Discard */}
      <div className="fixed inset-0 z-50 bg-black/70" />

      <div
        className="fixed z-50 bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ top: 16, left: 16, width: vpWidth - 32, height: vpHeight - 32 }}
      >
        <div className="px-6 pt-6 pb-0 border-b border-zinc-800 shrink-0">
          <h1 className="text-lg font-semibold text-zinc-100 mb-4">Settings</h1>
          <div className="flex gap-1">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 text-sm rounded-t-md border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'text-zinc-100 border-zinc-400 bg-zinc-800/40'
                    : 'text-zinc-500 border-transparent hover:text-zinc-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">

        {activeTab === 'general' && <GeneralTab draftMode={draftMode} onSetMode={handleSetMode} d={draft ?? undefined} set={draft ? set : undefined} />}

        {activeTab === 'models' && s && d && (
          <ModelsTab
            d={d} s={s} set={set}
            isDeveloper={isDeveloper}
            inputClass={inputClass} selectClass={selectClass}
          />
        )}

        {activeTab === 'channels' && s && d && (
          <ChannelsTab
            d={d} s={s} set={set}
            isDeveloper={isDeveloper}
            inputClass={inputClass} selectClass={selectClass}
          />
        )}

        {activeTab === 'stewards' && s && d && (
          <StewardsTab
            d={d} s={s} set={set}
            isDeveloper={isDeveloper}
            inputClass={inputClass} selectClass={selectClass}
          />
        )}

        {activeTab === 'behavior' && s && d && (
          <BehaviorTab
            d={d} s={s} set={set}
            isDeveloper={isDeveloper}
            inputClass={inputClass} selectClass={selectClass}
          />
        )}

        {activeTab === 'experimental' && s && d && (
          <ExperimentalTab
            d={d} s={s} set={set}
            isDeveloper={isDeveloper}
            inputClass={inputClass} selectClass={selectClass}
          />
        )}

        {/* Loading state */}
        {settingsQuery.isLoading && (
          <div className="text-sm text-zinc-500 text-center py-8">Loading…</div>
        )}
        {settingsQuery.isError && (
          <div className="text-sm text-red-400 text-center py-8">
            Failed to load settings: {(settingsQuery.error as Error).message}
          </div>
        )}

      </div>

      {/* Sticky footer */}
      <div className="shrink-0 border-t border-zinc-800 px-6 py-4 flex items-center gap-4">
        {/* Left: save error */}
        <div className="flex-1">
          {saveMutation.isError && (
            <span className="text-sm text-red-400">
              Save failed: {(saveMutation.error as Error).message}
            </span>
          )}
        </div>
        {/* Right: Discard + Save */}
        <div className="flex gap-2">
          <button
            onClick={handleDiscard}
            className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg border border-zinc-700 transition-colors"
          >
            {dirty ? 'Discard changes' : 'Close'}
          </button>
          <button
            onClick={() => {
              if (!s || !d) return
              const body = buildBody(d, s)
              if (Object.keys(body).length === 0) {
                // Only mode changed — no server-side settings to save, no restart needed
                setMode(draftMode)
                onClose()
                return
              }
              saveMutation.mutate(body)
            }}
            disabled={!dirty || saveMutation.isPending}
            className="px-4 py-2 text-sm font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg border border-[var(--accent)]/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saveMutation.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      </div>
    </>,
    document.body
  )
}
