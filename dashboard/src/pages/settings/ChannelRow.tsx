import React, { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { ChannelConfigMasked, ChannelConfigSubmit } from '../../types/api'
import { Field, SecretInput } from './components'
import { vendorTheme, VENDOR_LABELS, type Vendor } from './vendor-theme'

// Phase 33 Plan 06 (D-01, D-02, D-13, D-15, D-17) — a single channel row
// rendered inside a head card. Vendor-colored band, inline edit form that
// reuses Field + SecretInput verbatim, Delete with window.confirm baseline
// (Plan 07 replaces the head-level delete with the typed-confirmation modal;
// channel delete keeps window.confirm).
//
// The pending-state contract for secrets matches SecretInput: `null` means
// "no change" (omit from PATCH body), `''` means "user cleared" (Zod will
// reject — explicit clear path is "delete and re-add" per the Plan 05 D-17
// trade-off), `'newval'` means "set to this".

interface ChannelRowProps {
  headId: string
  channel: ChannelConfigMasked
  onSaved: () => void
}

const inputClass = "w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600"

export default function ChannelRow({ headId, channel, onSaved }: ChannelRowProps) {
  const [editing, setEditing] = useState(false)
  const theme = vendorTheme(channel.vendor as Vendor)

  // Per-field pending state. Plain text fields are seeded from the masked
  // channel; secret fields start as `null` (no change).
  const [pendingId, setPendingId] = useState<string>(channel.id)
  const [pendingChatId, setPendingChatId] = useState<string>('chatId' in channel ? channel.chatId : '')
  const [pendingChannelId, setPendingChannelId] = useState<string>('channelId' in channel ? channel.channelId : '')
  const [pendingAllowedJid, setPendingAllowedJid] = useState<string>('allowedJid' in channel ? channel.allowedJid : '')
  const [pendingBotToken, setPendingBotToken] = useState<string | null>(null)
  const [pendingAppToken, setPendingAppToken] = useState<string | null>(null)
  const [pendingClientId, setPendingClientId] = useState<string | null>(null)
  const [pendingClientSecret, setPendingClientSecret] = useState<string | null>(null)
  const [pendingRefreshToken, setPendingRefreshToken] = useState<string | null>(null)

  function resetPending() {
    setPendingId(channel.id)
    setPendingChatId('chatId' in channel ? channel.chatId : '')
    setPendingChannelId('channelId' in channel ? channel.channelId : '')
    setPendingAllowedJid('allowedJid' in channel ? channel.allowedJid : '')
    setPendingBotToken(null)
    setPendingAppToken(null)
    setPendingClientId(null)
    setPendingClientSecret(null)
    setPendingRefreshToken(null)
  }

  const editMutation = useMutation({
    mutationFn: (patch: Partial<ChannelConfigSubmit>) =>
      api.heads.editChannel(headId, channel.id, patch),
    onSuccess: () => {
      setEditing(false)
      onSaved()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.heads.removeChannel(headId, channel.id),
    onSuccess: () => onSaved(),
  })

  function handleSave() {
    // Build a partial PATCH body containing ONLY fields the user changed.
    // For plain strings: include only if it differs from the on-disk value.
    // For secrets: include only if `pending !== null`.
    const patch: Record<string, unknown> = {}
    if (pendingId !== channel.id) patch['id'] = pendingId

    switch (channel.vendor) {
      case 'telegram':
        if (pendingChatId !== channel.chatId) patch['chatId'] = pendingChatId
        if (pendingBotToken !== null) patch['botToken'] = pendingBotToken
        break
      case 'discord':
        if (pendingChannelId !== channel.channelId) patch['channelId'] = pendingChannelId
        if (pendingBotToken !== null) patch['botToken'] = pendingBotToken
        break
      case 'slack':
        if (pendingChannelId !== channel.channelId) patch['channelId'] = pendingChannelId
        if (pendingBotToken !== null) patch['botToken'] = pendingBotToken
        if (pendingAppToken !== null) patch['appToken'] = pendingAppToken
        break
      case 'whatsapp':
        if (pendingAllowedJid !== channel.allowedJid) patch['allowedJid'] = pendingAllowedJid
        break
      case 'zoho-cliq':
        if (pendingChatId !== channel.chatId) patch['chatId'] = pendingChatId
        if (pendingClientId !== null) patch['clientId'] = pendingClientId
        if (pendingClientSecret !== null) patch['clientSecret'] = pendingClientSecret
        if (pendingRefreshToken !== null) patch['refreshToken'] = pendingRefreshToken
        break
    }
    editMutation.mutate(patch as Partial<ChannelConfigSubmit>)
  }

  function handleDelete() {
    if (!window.confirm(`Remove channel "${channel.id}" from head "${headId}"? Existing message history is not deleted.`)) return
    deleteMutation.mutate()
  }

  // ----- collapsed view -----
  if (!editing) {
    return (
      <div className="rounded-xl p-3 flex items-center gap-3 border" style={theme.wrapperStyle}>
        <span className="text-xs font-semibold shrink-0" style={theme.labelStyle}>
          {VENDOR_LABELS[channel.vendor as Vendor]}
        </span>
        <span className="text-sm text-zinc-300 font-mono truncate flex-1" title={channel.id}>{channel.id}</span>
        <button
          onClick={() => setEditing(true)}
          className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-md"
        >
          Edit
        </button>
        <button
          onClick={handleDelete}
          disabled={deleteMutation.isPending}
          className="px-2 py-1 text-xs text-zinc-500 hover:text-red-400 border border-zinc-700 rounded-md disabled:opacity-40"
        >
          {deleteMutation.isPending ? 'Removing…' : 'Delete'}
        </button>
      </div>
    )
  }

  // ----- expanded edit form -----
  return (
    <div className="rounded-xl p-4 space-y-3 border" style={theme.wrapperStyle}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold" style={theme.labelStyle}>
          {VENDOR_LABELS[channel.vendor as Vendor]}
        </span>
      </div>
      <Field label="Channel ID" tooltip="Unique kebab-case id used by the router and message events. Must be unique across all heads.">
        <input
          type="text"
          value={pendingId}
          onChange={e => setPendingId(e.target.value)}
          className={inputClass}
          placeholder="vendor-headname"
        />
      </Field>
      {channel.vendor === 'telegram' && (
        <>
          <Field label="Chat ID">
            <input type="text" value={pendingChatId} onChange={e => setPendingChatId(e.target.value)} className={inputClass} placeholder="not set" />
          </Field>
          <Field label="Bot Token">
            <SecretInput isSet={channel.botToken.isSet} pending={pendingBotToken} onPendingChange={setPendingBotToken} />
          </Field>
        </>
      )}
      {channel.vendor === 'discord' && (
        <>
          <Field label="Channel ID (Discord)">
            <input type="text" value={pendingChannelId} onChange={e => setPendingChannelId(e.target.value)} className={inputClass} placeholder="not set" />
          </Field>
          <Field label="Bot Token">
            <SecretInput isSet={channel.botToken.isSet} pending={pendingBotToken} onPendingChange={setPendingBotToken} />
          </Field>
        </>
      )}
      {channel.vendor === 'slack' && (
        <>
          <Field label="Channel ID (Slack)">
            <input type="text" value={pendingChannelId} onChange={e => setPendingChannelId(e.target.value)} className={inputClass} placeholder="not set" />
          </Field>
          <Field label="Bot Token">
            <SecretInput isSet={channel.botToken.isSet} pending={pendingBotToken} onPendingChange={setPendingBotToken} />
          </Field>
          <Field label="App Token">
            <SecretInput isSet={channel.appToken.isSet} pending={pendingAppToken} onPendingChange={setPendingAppToken} />
          </Field>
        </>
      )}
      {channel.vendor === 'whatsapp' && (
        <Field label="Allowed JID">
          <input type="text" value={pendingAllowedJid} onChange={e => setPendingAllowedJid(e.target.value)} className={inputClass} placeholder="15551234567@s.whatsapp.net" />
        </Field>
      )}
      {channel.vendor === 'zoho-cliq' && (
        <>
          <Field label="Chat ID">
            <input type="text" value={pendingChatId} onChange={e => setPendingChatId(e.target.value)} className={inputClass} placeholder="not set" />
          </Field>
          <Field label="Client ID">
            <SecretInput isSet={channel.clientId.isSet} pending={pendingClientId} onPendingChange={setPendingClientId} />
          </Field>
          <Field label="Client Secret">
            <SecretInput isSet={channel.clientSecret.isSet} pending={pendingClientSecret} onPendingChange={setPendingClientSecret} />
          </Field>
          <Field label="Refresh Token">
            <SecretInput isSet={channel.refreshToken.isSet} pending={pendingRefreshToken} onPendingChange={setPendingRefreshToken} />
          </Field>
        </>
      )}

      {editMutation.isError && (
        <div className="text-xs text-red-400">Save failed: {(editMutation.error as Error).message}</div>
      )}

      <div className="flex gap-2 justify-end">
        <button
          onClick={() => { resetPending(); setEditing(false) }}
          className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-md"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={editMutation.isPending}
          className="px-3 py-1.5 text-xs font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-md border border-[var(--accent)]/50 disabled:opacity-40"
        >
          {editMutation.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
