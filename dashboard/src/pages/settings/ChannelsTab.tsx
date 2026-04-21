import React from 'react'
import type { SettingsTabProps } from './draft'
import { Field, SecretInput } from './components'

export default function ChannelsTab({ d, s, set, inputClass }: SettingsTabProps) {
  return (
    <>
      {/* Discord */}
      <div className="bg-[#5865F2]/5 border border-[#5865F2]/70 rounded-xl p-4 space-y-3">
        <div className="text-sm font-semibold text-[#5865F2]">Discord</div>
        <Field label="Bot Token" tooltip="The token for your Discord bot. Create one at discord.com/developers, add it to your server, and paste the token here.">
          <SecretInput isSet={s.discordBotToken.isSet} pending={d.discordBotToken} onPendingChange={v => set('discordBotToken', v)} />
        </Field>
        <Field label="Channel ID" tooltip="The Discord channel where Shrok listens and responds. Right-click a channel in Discord (with developer mode on) and copy the ID.">
          <input type="text" value={d.discordChannelId} onChange={e => set('discordChannelId', e.target.value)} placeholder="not set" className={inputClass} />
        </Field>
      </div>

      {/* Telegram */}
      <div className="bg-[#0088CC]/5 border border-[#0088CC]/70 rounded-xl p-4 space-y-3">
        <div className="text-sm font-semibold text-[#0088CC]">Telegram</div>
        <Field label="Bot Token" tooltip="The token from BotFather. Message @BotFather on Telegram, create a bot, and paste the token here.">
          <SecretInput isSet={s.telegramBotToken.isSet} pending={d.telegramBotToken} onPendingChange={v => set('telegramBotToken', v)} />
        </Field>
        <Field label="Chat ID" tooltip="The Telegram chat where Shrok listens. Send a message to your bot, then check the Telegram Bot API for updates to find the chat ID.">
          <input type="text" value={d.telegramChatId} onChange={e => set('telegramChatId', e.target.value)} placeholder="not set" className={inputClass} />
        </Field>
      </div>

      {/* Slack */}
      <div className="bg-[#611f69]/5 border border-[#611f69] rounded-xl p-4 space-y-3">
        <div className="text-sm font-semibold text-[#611f69] brightness-150">Slack</div>
        <Field label="Bot Token" tooltip="The bot user OAuth token (starts with xoxb-). Found in your Slack app's OAuth & Permissions page.">
          <SecretInput isSet={s.slackBotToken.isSet} pending={d.slackBotToken} onPendingChange={v => set('slackBotToken', v)} />
        </Field>
        <Field label="App Token" tooltip="The app-level token (starts with xapp-). Required for Socket Mode. Generate one in your Slack app's Basic Information page.">
          <SecretInput isSet={s.slackAppToken.isSet} pending={d.slackAppToken} onPendingChange={v => set('slackAppToken', v)} />
        </Field>
        <Field label="Channel ID" tooltip="The Slack channel where Shrok listens. Right-click a channel name, copy the link, and grab the ID from the end of the URL.">
          <input type="text" value={d.slackChannelId} onChange={e => set('slackChannelId', e.target.value)} placeholder="not set" className={inputClass} />
        </Field>
      </div>

      {/* WhatsApp */}
      <div className="bg-[#25d366]/5 border border-[#25d366]/70 rounded-xl p-4 space-y-3">
        <div className="text-sm font-semibold text-[#25d366]">WhatsApp</div>
        <Field label="Allowed JID" tooltip="The WhatsApp JID (phone number) allowed to talk to Shrok. Format: 15551234567@s.whatsapp.net. Only messages from this JID are processed.">
          <input type="text" value={d.whatsappAllowedJid} onChange={e => set('whatsappAllowedJid', e.target.value)} placeholder="not set" className={inputClass} />
        </Field>
      </div>

      {/* Zoho Cliq */}
      <div className="bg-[#e42527]/5 border border-[#e42527]/70 rounded-xl p-4 space-y-3">
        <div className="text-sm font-semibold text-[#e42527]">Zoho Cliq</div>
        <Field label="Client ID" tooltip="The OAuth client ID from the Zoho API Console. Create a Self Client at api-console.zoho.com to get one.">
          <SecretInput isSet={s.zohoClientId.isSet} pending={d.zohoClientId} onPendingChange={v => set('zohoClientId', v)} />
        </Field>
        <Field label="Client Secret" tooltip="The OAuth client secret paired with the client ID. Shown once when you create the Self Client in the Zoho API Console.">
          <SecretInput isSet={s.zohoClientSecret.isSet} pending={d.zohoClientSecret} onPendingChange={v => set('zohoClientSecret', v)} />
        </Field>
        <Field label="Refresh Token" tooltip="A long-lived refresh token for the Zoho API. Generate one using the Self Client grant flow in the Zoho API Console with the scopes Shrok needs (Cliq messaging).">
          <SecretInput isSet={s.zohoRefreshToken.isSet} pending={d.zohoRefreshToken} onPendingChange={v => set('zohoRefreshToken', v)} />
        </Field>
        <Field label="Chat ID" tooltip="The Zoho Cliq chat where Shrok listens. Find it in the Cliq web app URL when viewing the chat, or via the Cliq API.">
          <input type="text" value={d.zohoCliqChatId} onChange={e => set('zohoCliqChatId', e.target.value)} placeholder="not set" className={inputClass} />
        </Field>
      </div>

      {/* Webhook */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3 opacity-50">
        <div className="text-sm font-semibold text-zinc-300 flex items-center gap-2">Webhook <span className="text-[11px] font-normal text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">Coming soon</span></div>
        <Field label="Secret" tooltip="A shared secret for verifying incoming webhook requests. Shrok will reject requests that don't include a valid HMAC signature using this secret.">
          <div className="pointer-events-none">
            <SecretInput isSet={s.webhookSecret.isSet} pending={d.webhookSecret} onPendingChange={v => set('webhookSecret', v)} />
          </div>
        </Field>
        <Field label="Host" tooltip="Bind address for the webhook listener. 127.0.0.1 (default) = local only, 0.0.0.0 = all interfaces. Use a reverse proxy for external access.">
          <div className="pointer-events-none">
            <input type="text" value={d.webhookHost} onChange={e => set('webhookHost', e.target.value)} placeholder="127.0.0.1" className={inputClass} />
          </div>
        </Field>
        <Field label="Port" tooltip="Port for the webhook listener.">
          <div className="pointer-events-none">
            <input type="text" value={d.webhookPort} onChange={e => set('webhookPort', e.target.value)} placeholder="8766" className={inputClass} />
          </div>
        </Field>
      </div>
    </>
  )
}
