import React, { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { HeadDTO, ChannelConfigSubmit } from '../../types/api'
import { Field, SecretInput } from './components'
import ChannelRow from './ChannelRow'
import DeleteHeadModal from './DeleteHeadModal'
import { vendorTheme, VENDORS, VENDOR_LABELS, type Vendor } from './vendor-theme'
import { HeadToolOverrideControl } from './ToolOverrideControl'

// Phase 33 Plan 06 (D-01, D-02, D-08, D-13, D-15) — a single head card. Holds
// the head id (with non-default rename), the list of ChannelRow components,
// the [+ Add channel ▾] vendor picker + inline new-channel form, and the
// Delete button. The `default` head's Delete is disabled with the D-08
// tooltip. Phase 33 Plan 07 (D-06): Delete opens the typed-confirmation
// DeleteHeadModal showing three real counts before destroying data.

interface HeadCardProps {
  head: HeadDTO
  allHeads: HeadDTO[]
  onSaved: () => void
}

// D-13 client-side hint — backend re-validates with the same regex.
const HEAD_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/

const inputClass = "w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600"

// D-15 client-side suggestion. Auto-bump -2, -3, ... if the base id collides
// with any channel already on any head.
function suggestChannelId(vendor: Vendor, headId: string, takenIds: Set<string>): string {
  const base = `${vendor}-${headId}`
  if (!takenIds.has(base)) return base
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`
    if (!takenIds.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

function collectChannelIds(heads: HeadDTO[]): Set<string> {
  const ids = new Set<string>()
  for (const h of heads) for (const c of h.channels) ids.add(c.id)
  return ids
}

export default function HeadCard({ head, allHeads, onSaved }: HeadCardProps) {
  const isDefault = head.id === 'default'
  const [renaming, setRenaming] = useState(false)
  const [pendingId, setPendingId] = useState(head.id)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [adding, setAdding] = useState<Vendor | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [promptDraft, setPromptDraft] = useState(head.customPrompt ?? '')

  // Tool override state — default to '__inherit__' when key is absent on the DTO (two-state: subset | inherit)
  const [headToolsOverride, setHeadToolsOverride] = useState<string[] | '__inherit__'>(
    head.headToolsOverride !== undefined ? head.headToolsOverride : '__inherit__'
  )
  const [agentToolsOverride, setAgentToolsOverride] = useState<string[] | '__inherit__'>(
    head.agentToolsOverride !== undefined ? head.agentToolsOverride : '__inherit__'
  )

  // New-channel form pending state. Initial id is suggested when the vendor
  // is picked; secrets all start blank.
  const [newId, setNewId] = useState('')
  const [newChatId, setNewChatId] = useState('')
  const [newChannelId, setNewChannelId] = useState('')
  const [newAllowedJid, setNewAllowedJid] = useState('')
  const [newBotToken, setNewBotToken] = useState<string | null>('')
  const [newAppToken, setNewAppToken] = useState<string | null>('')
  const [newClientId, setNewClientId] = useState<string | null>('')
  const [newClientSecret, setNewClientSecret] = useState<string | null>('')
  const [newRefreshToken, setNewRefreshToken] = useState<string | null>('')

  const renameMutation = useMutation({
    mutationFn: (newId: string) => api.heads.rename(head.id, newId),
    onSuccess: () => { setRenaming(false); onSaved() },
  })

  const customPromptMutation = useMutation({
    mutationFn: (cp: string) => api.heads.setCustomPrompt(head.id, cp),
    onSuccess: () => onSaved(),
  })

  const toolsQuery = useQuery({ queryKey: ['tools'], queryFn: api.tools.list, staleTime: Infinity })
  // Filter tagged registry by layer at assignment time (D-03, D-08)
  const headToolOptions = (toolsQuery.data?.tools ?? []).filter(t => t.layers.includes('head')).map(t => t.name)
  const agentToolOptions = (toolsQuery.data?.tools ?? []).filter(t => t.layers.includes('agent')).map(t => t.name)

  const toolOverrideMutation = useMutation({
    mutationFn: () => api.heads.setToolOverrides(head.id, { headToolsOverride, agentToolsOverride }),
    onSuccess: () => onSaved(),
  })

  const addChannelMutation = useMutation({
    mutationFn: (channel: ChannelConfigSubmit) => api.heads.addChannel(head.id, channel),
    onSuccess: () => { resetNewChannel(); onSaved() },
  })

  function openVendor(vendor: Vendor) {
    setPickerOpen(false)
    setAdding(vendor)
    const taken = collectChannelIds(allHeads)
    setNewId(suggestChannelId(vendor, head.id, taken))
    setNewChatId('')
    setNewChannelId('')
    setNewAllowedJid('')
    setNewBotToken('')
    setNewAppToken('')
    setNewClientId('')
    setNewClientSecret('')
    setNewRefreshToken('')
  }

  function resetNewChannel() {
    setAdding(null)
    setNewId('')
  }

  function handleSaveNewChannel() {
    if (!adding) return
    let channel: ChannelConfigSubmit
    switch (adding) {
      case 'telegram':
        channel = { id: newId, vendor: 'telegram', botToken: newBotToken ?? '', chatId: newChatId }
        break
      case 'discord':
        channel = { id: newId, vendor: 'discord', botToken: newBotToken ?? '', channelId: newChannelId }
        break
      case 'slack':
        channel = { id: newId, vendor: 'slack', botToken: newBotToken ?? '', appToken: newAppToken ?? '', channelId: newChannelId }
        break
      case 'whatsapp':
        channel = { id: newId, vendor: 'whatsapp', allowedJid: newAllowedJid }
        break
      case 'zoho-cliq':
        channel = {
          id: newId, vendor: 'zoho-cliq',
          clientId: newClientId ?? '', clientSecret: newClientSecret ?? '', refreshToken: newRefreshToken ?? '',
          chatId: newChatId,
        }
        break
      default: {
        // Phase 33 (WR-04): exhaustiveness guard mirroring src/index.ts:319-321.
        // If a sixth vendor is added to the Vendor union without updating this
        // switch, the `never` assignment becomes a TS compile error rather
        // than a silent runtime no-op (save button doing nothing).
        const _exhaustive: never = adding
        throw new Error(`unhandled vendor: ${String(_exhaustive)}`)
      }
    }
    addChannelMutation.mutate(channel)
  }

  function handleRename() {
    if (!HEAD_ID_REGEX.test(pendingId)) return
    if (pendingId === head.id) { setRenaming(false); return }
    renameMutation.mutate(pendingId)
  }

  const renameValid = HEAD_ID_REGEX.test(pendingId)

  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
      {/* Header row: id + rename + delete */}
      <div className="flex items-center gap-2">
        {!renaming && (
          <>
            <span className="text-sm font-semibold text-zinc-200 font-mono">{head.id}</span>
            {!isDefault && (
              <button
                onClick={() => { setPendingId(head.id); setRenaming(true) }}
                className="text-xs text-zinc-500 hover:text-zinc-300"
                title="Rename head"
              >
                ✎ rename
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={() => setDeleteOpen(true)}
              disabled={isDefault}
              title={isDefault ? 'the default head cannot be deleted' : 'Delete this head and all its data'}
              className="px-2 py-1 text-xs border border-zinc-700 rounded-md text-zinc-500 hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-zinc-500"
            >
              Delete
            </button>
          </>
        )}
        {renaming && (
          <div className="flex items-center gap-2 flex-1">
            <input
              type="text"
              value={pendingId}
              onChange={e => setPendingId(e.target.value)}
              className={inputClass}
              autoFocus
            />
            <button
              onClick={handleRename}
              disabled={!renameValid || renameMutation.isPending}
              className="px-3 py-1.5 text-xs font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-md border border-[var(--accent)]/50 disabled:opacity-40"
            >
              {renameMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => { setRenaming(false); setPendingId(head.id) }}
              className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-md"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {renaming && !renameValid && (
        <div className="text-xs text-red-400">id must match /^[a-z0-9][a-z0-9-]{`{0,31}`}$/</div>
      )}
      {renameMutation.isError && (
        <div className="text-xs text-red-400">Rename failed: {(renameMutation.error as Error).message}</div>
      )}

      {/* Channel rows */}
      <div className="space-y-2">
        {head.channels.map(ch => (
          <ChannelRow key={ch.id} headId={head.id} channel={ch} onSaved={onSaved} />
        ))}
        {head.channels.length === 0 && (
          <div className="text-xs text-zinc-500 italic px-1">No channels yet — add one below.</div>
        )}
      </div>

      {/* Custom prompt editor — appended to this head's system prompt */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-zinc-400">Custom prompt</label>
        <p className="text-xs text-zinc-500">Appended to this head's system prompt.</p>
        <textarea
          value={promptDraft}
          onChange={e => setPromptDraft(e.target.value)}
          rows={3}
          className={`${inputClass} resize-y`}
          placeholder="Optional per-head instructions…"
        />
        <button
          onClick={() => customPromptMutation.mutate(promptDraft)}
          disabled={customPromptMutation.isPending}
          className="px-3 py-1.5 text-xs font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-md border border-[var(--accent)]/50 disabled:opacity-40"
        >
          {customPromptMutation.isPending ? 'Saving…' : 'Save'}
        </button>
        {customPromptMutation.isError && (
          <div className="text-xs text-red-400">Save failed: {(customPromptMutation.error as Error).message}</div>
        )}
      </div>

      {/* Tool access overrides */}
      <div className="space-y-3">
        <label className="text-xs font-medium text-zinc-400">Tool access</label>
        <p className="text-xs text-zinc-500">
          Override the global tool defaults for this head.
          "Inherit global" uses the defaults from Settings → Behavior.
          Changes require a restart to take effect.
        </p>

        <Field label="Head tools" tooltip="Which tools this head may use. Inherit = use the global default. Choose subset = only those tools.">
          <HeadToolOverrideControl
            value={headToolsOverride}
            onChange={v => { if (v !== null) setHeadToolsOverride(v) }}
            options={headToolOptions}
          />
        </Field>

        <Field label="Agent tools" tooltip="Which tools sub-agents spawned by this head may use. Inherit = use the global default. Choose subset = only those tools.">
          <HeadToolOverrideControl
            value={agentToolsOverride}
            onChange={v => { if (v !== null) setAgentToolsOverride(v) }}
            options={agentToolOptions}
          />
        </Field>

        <button
          onClick={() => toolOverrideMutation.mutate()}
          disabled={toolOverrideMutation.isPending}
          className="px-3 py-1.5 text-xs font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-md border border-[var(--accent)]/50 disabled:opacity-40"
        >
          {toolOverrideMutation.isPending ? 'Saving…' : 'Save'}
        </button>
        {toolOverrideMutation.isError && (
          <div className="text-xs text-red-400">Save failed: {(toolOverrideMutation.error as Error).message}</div>
        )}
      </div>

      {/* Add channel picker + inline form */}
      {adding === null && (
        <div className="relative">
          <button
            onClick={() => setPickerOpen(o => !o)}
            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-md"
          >
            + Add channel ▾
          </button>
          {pickerOpen && (
            <div className="absolute z-10 mt-1 bg-zinc-800 border border-zinc-700 rounded-md shadow-lg overflow-hidden">
              {VENDORS.map(v => (
                <button
                  key={v}
                  onClick={() => openVendor(v)}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-700/60"
                  style={{ color: vendorTheme(v).labelStyle.color }}
                >
                  {VENDOR_LABELS[v]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {deleteOpen && (
        <DeleteHeadModal
          head={head}
          onClose={() => setDeleteOpen(false)}
          onDeleted={onSaved}
        />
      )}

      {adding !== null && (
        <div className="rounded-xl p-4 space-y-3 border" style={vendorTheme(adding).wrapperStyle}>
          <div className="text-sm font-semibold" style={vendorTheme(adding).labelStyle}>
            New {VENDOR_LABELS[adding]} channel
          </div>
          <Field label="Channel ID" tooltip="Unique kebab-case id, e.g. telegram-work. Auto-suggested from the vendor + head name.">
            <input
              type="text"
              value={newId}
              onChange={e => setNewId(e.target.value)}
              className={inputClass}
              placeholder="vendor-headname"
            />
          </Field>
          {adding === 'telegram' && (
            <>
              <Field label="Chat ID">
                <input type="text" value={newChatId} onChange={e => setNewChatId(e.target.value)} className={inputClass} placeholder="-100..." />
              </Field>
              <Field label="Bot Token">
                <SecretInput isSet={false} pending={newBotToken} onPendingChange={setNewBotToken} />
              </Field>
            </>
          )}
          {adding === 'discord' && (
            <>
              <Field label="Channel ID (Discord)">
                <input type="text" value={newChannelId} onChange={e => setNewChannelId(e.target.value)} className={inputClass} />
              </Field>
              <Field label="Bot Token">
                <SecretInput isSet={false} pending={newBotToken} onPendingChange={setNewBotToken} />
              </Field>
            </>
          )}
          {adding === 'slack' && (
            <>
              <Field label="Channel ID (Slack)">
                <input type="text" value={newChannelId} onChange={e => setNewChannelId(e.target.value)} className={inputClass} />
              </Field>
              <Field label="Bot Token">
                <SecretInput isSet={false} pending={newBotToken} onPendingChange={setNewBotToken} />
              </Field>
              <Field label="App Token">
                <SecretInput isSet={false} pending={newAppToken} onPendingChange={setNewAppToken} />
              </Field>
            </>
          )}
          {adding === 'whatsapp' && (
            <Field label="Allowed JID">
              <input type="text" value={newAllowedJid} onChange={e => setNewAllowedJid(e.target.value)} className={inputClass} placeholder="15551234567@s.whatsapp.net" />
            </Field>
          )}
          {adding === 'zoho-cliq' && (
            <>
              <Field label="Chat ID">
                <input type="text" value={newChatId} onChange={e => setNewChatId(e.target.value)} className={inputClass} />
              </Field>
              <Field label="Client ID">
                <SecretInput isSet={false} pending={newClientId} onPendingChange={setNewClientId} />
              </Field>
              <Field label="Client Secret">
                <SecretInput isSet={false} pending={newClientSecret} onPendingChange={setNewClientSecret} />
              </Field>
              <Field label="Refresh Token">
                <SecretInput isSet={false} pending={newRefreshToken} onPendingChange={setNewRefreshToken} />
              </Field>
            </>
          )}

          {addChannelMutation.isError && (
            <div className="text-xs text-red-400">Save failed: {(addChannelMutation.error as Error).message}</div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              onClick={resetNewChannel}
              className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-md"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveNewChannel}
              disabled={!HEAD_ID_REGEX.test(newId) || addChannelMutation.isPending}
              className="px-3 py-1.5 text-xs font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-md border border-[var(--accent)]/50 disabled:opacity-40"
            >
              {addChannelMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
