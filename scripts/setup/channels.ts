import { confirm, note, password, select, spinner, text } from '@clack/prompts'
import type { WizardContext } from './types.js'
import { assertNotCancelled } from './utils.js'

export async function setupChannels(ctx: WizardContext): Promise<void> {
  const { deps, existingEnv, secrets } = ctx

  note('Pick the app you want to chat with Shrok through. You can add more later by asking Shrok.', '2/5  Channels')

  const channelOptions = [
    { value: 'discord',  label: 'Discord' },
    { value: 'telegram', label: 'Telegram' },
    { value: 'slack',    label: 'Slack' },
    { value: 'whatsapp', label: 'WhatsApp', hint: 'Unofficial and unreliable — use at your own risk' },
  ]

  const chosenChannel = assertNotCancelled(await select({
    message: 'Which app do you want to chat with Shrok through?',
    options: [
      ...channelOptions,
      { value: 'none', label: 'Local browser interface' },
    ],
    initialValue: existingEnv['DISCORD_BOT_TOKEN'] ? 'discord'
      : existingEnv['TELEGRAM_BOT_TOKEN'] ? 'telegram'
      : existingEnv['SLACK_BOT_TOKEN'] ? 'slack'
      : 'discord',
  })) as string

  const selectedChannels: string[] = chosenChannel !== 'none' ? [chosenChannel] : []

  if (selectedChannels.includes('discord')) {
    note(
      [
        'You\'ll need a Discord server to add your bot to. You can use an existing server you manage, or create a new one by clicking the + icon in the Discord sidebar.',
        '',
        '1. Go to https://discord.com/developers/applications and log in.',
        '2. Click New Application, give it a name, and click Create. This name becomes your bot\'s name, so choose what you want it called.',
        '3. Click Bot in the left sidebar.',
        '4. (Optional) Click on the bot\'s icon to set an avatar.',
        '5. Under Privileged Gateway Intents, enable Message Content Intent, then click Save Changes at the bottom.',
        '6. Scroll up to the Token section, click Reset Token, confirm, then copy it immediately — paste it below.',
      ].join('\n'),
      'How to create a Discord bot'
    )

    const discordToken = assertNotCancelled(await password({
      message: 'Discord bot token:',
      mask: '*',
    }))
    if (discordToken) secrets['DISCORD_BOT_TOKEN'] = discordToken

    note(
      [
        'Now invite the bot to your server:',
        '1. In the left sidebar, click OAuth2, then URL Generator. Under Scopes, check bot.',
        '2. Under Bot Permissions, select Send Messages and Read Message History.',
        '3. A generated URL will appear at the bottom of the page — copy it, open it in your browser, select your server, and click Authorize.',
        '(You need Manage Server permissions on that server.)',
      ].join('\n'),
      'Invite the bot to your server'
    )

    note(
      [
        '1. In Discord, open User Settings (gear icon bottom-left).',
        '2. Go to Advanced and toggle on Developer Mode.',
        '3. Close settings, then right-click the channel you want → Copy Channel ID.',
        '(On mobile: long-press the channel name instead.)',
      ].join('\n'),
      'How to get a Discord channel ID'
    )

    const discordChannelId = assertNotCancelled(await text({
      message: 'Discord channel ID:',
      initialValue: existingEnv['DISCORD_CHANNEL_ID'] ?? '',
      validate: (v) => /^\d{17,21}$/.test((v ?? '').trim())
        ? undefined
        : 'Should be 17–21 digits, right-click the channel and choose "Copy Channel ID"',
    }))
    if (discordChannelId) secrets['DISCORD_CHANNEL_ID'] = discordChannelId

    // Verify Discord credentials
    const s2 = spinner()
    let discordOk = false
    while (!discordOk) {
      s2.start('Checking Discord credentials…')
      try {
        const BASE = 'https://discord.com/api/v10'
        const headers = { Authorization: `Bot ${secrets['DISCORD_BOT_TOKEN']}` }

        const meRes = await deps.fetch(`${BASE}/users/@me`, { headers })
        if (!meRes.ok) throw new Error(`Bot token invalid (${meRes.status})`)
        const me = await meRes.json() as { username: string; discriminator: string }
        const tag = me.discriminator === '0' ? me.username : `${me.username}#${me.discriminator}`

        const chRes = await deps.fetch(`${BASE}/channels/${secrets['DISCORD_CHANNEL_ID']}`, { headers })
        if (!chRes.ok) throw new Error(
          chRes.status === 404
            ? 'Channel not found, check the ID and that the bot has access'
            : `Channel lookup failed (${chRes.status})`
        )
        const ch = await chRes.json() as { name?: string }
        s2.stop(`Bot: ${tag}  ·  Channel: ${ch.name ? `#${ch.name}` : secrets['DISCORD_CHANNEL_ID']}`)
        discordOk = true
      } catch (e: unknown) {
        s2.stop((e as Error).message)
        const decision = assertNotCancelled(await select({
          message: 'What would you like to do?',
          options: [
            { value: 'retry', label: 'Try different credentials' },
            { value: 'skip',  label: 'Skip verification and continue' },
          ],
          initialValue: 'retry',
        }))
        if (decision === 'skip') break
        const newToken = assertNotCancelled(await password({ message: 'Discord bot token:', mask: '*' }))
        if (newToken) secrets['DISCORD_BOT_TOKEN'] = newToken
        const newChannelId = assertNotCancelled(await text({
          message: 'Discord channel ID:',
          initialValue: secrets['DISCORD_CHANNEL_ID'] ?? '',
          validate: (v) => /^\d{17,21}$/.test((v ?? '').trim())
            ? undefined
            : 'Should be 17–21 digits',
        }))
        if (newChannelId) secrets['DISCORD_CHANNEL_ID'] = newChannelId
      }
    }
  }

  if (selectedChannels.includes('telegram')) {
    note(
      [
        '1. Open Telegram and search for @BotFather (look for the blue checkmark), or go to https://t.me/BotFather.',
        '2. Tap Start, then send /newbot.',
        '3. Enter a display name for your bot (this can be anything).',
        '4. Enter a username, must end in "bot" (e.g. MyCoolBot or my_cool_bot).',
        '5. BotFather will reply with your bot token. Copy it immediately.',
        '',
        'Keep your token secret. If it\'s ever exposed, send /revoke to BotFather to generate a new one.',
      ].join('\n'),
      'How to create a Telegram bot'
    )

    const tgToken = assertNotCancelled(await password({
      message: 'Telegram bot token:',
      mask: '*',
      validate: (v) => /^[0-9]{6,10}:[a-zA-Z0-9_-]{20,40}$/.test((v ?? '').trim())
        ? undefined
        : 'Format should look like  123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ',
    }))
    if (tgToken) secrets['TELEGRAM_BOT_TOKEN'] = tgToken

    note(
      [
        '1. Open Telegram and search for @userinfobot.',
        '2. Tap Start, it will reply with your account info including your Chat ID.',
        '3. It\'s a number like 123456789. Copy that.',
      ].join('\n'),
      'How to get your Telegram chat ID'
    )

    const tgChatId = assertNotCancelled(await text({
      message: 'Your Telegram chat ID:',
      initialValue: existingEnv['TELEGRAM_CHAT_ID'] ?? '',
      validate: (v) => /^-?\d{1,15}$/.test((v ?? '').trim())
        ? undefined
        : 'Should be a number, negative for groups/channels (e.g. -1001234567890)',
    }))
    if (tgChatId) secrets['TELEGRAM_CHAT_ID'] = tgChatId
  }

  if (selectedChannels.includes('slack')) {
    note(
      [
        '1. Go to api.slack.com/apps → Create New App → From scratch.',
        '2. Enter an App Name and select your Workspace, then click Create App.',
        '3. Go to OAuth & Permissions in the left sidebar.',
        '4. Under Bot Token Scopes, add: chat:write, chat:write.public, app_mentions:read, channels:history, im:history, im:write, reactions:read, reactions:write',
        '5. Click Install to Workspace at the top of OAuth & Permissions → Allow.',
        '6. Copy the Bot User OAuth Token (starts with xoxb-).',
        '7. Go to Socket Mode in the sidebar → toggle ON.',
        '8. Create an App-Level Token with the connections:write scope.',
        '9. Copy the token (starts with xapp-).',
        '10. Go to Event Subscriptions → toggle ON → Subscribe to bot events.',
        '11. Add: app_mention, message.channels, message.im, reaction_added, reaction_removed',
        '12. Save Changes, then go to Install App → Reinstall to Workspace.',
        '13. Invite the bot to the channel you want to use: /invite @YourBotName'
      ].join('\n'),
      'How to create a Slack app'
    )

    const slackBotToken = assertNotCancelled(await password({
      message: 'Slack Bot Token (xoxb-...):',
      mask: '*',
      validate: (v) => /^xoxb-[0-9]+-[0-9A-Za-z-]+$/.test((v ?? '').trim())
        ? undefined
        : 'Should start with xoxb-',
    }))
    if (slackBotToken) secrets['SLACK_BOT_TOKEN'] = slackBotToken

    const slackAppToken = assertNotCancelled(await password({
      message: 'Slack App-Level Token (xapp-...):',
      mask: '*',
      validate: (v) => /^xapp-/.test((v ?? '').trim())
        ? undefined
        : 'Should start with xapp-',
    }))
    if (slackAppToken) secrets['SLACK_APP_TOKEN'] = slackAppToken

    note(
      [
        'Right-click the channel name in Slack → View channel details → scroll to the bottom.',
        'The Channel ID is at the very bottom, e.g. C012AB3CD.',
        'On mobile: tap the channel name → tap the channel name again at the top → scroll to the bottom.',
      ].join('\n'),
      'How to get a Slack channel ID'
    )

    const slackChannelId = assertNotCancelled(await text({
      message: 'Slack channel ID:',
      initialValue: existingEnv['SLACK_CHANNEL_ID'] ?? '',
      validate: (v) => /^[A-Z][A-Z0-9]{6,12}$/.test((v ?? '').trim())
        ? undefined
        : 'Should be a Slack channel ID like C012AB3CD',
    }))
    if (slackChannelId) secrets['SLACK_CHANNEL_ID'] = slackChannelId

    // Verify Slack credentials
    const sSlack = spinner()
    let slackOk = false
    while (!slackOk) {
      sSlack.start('Checking Slack credentials…')
      try {
        const res = await deps.fetch('https://slack.com/api/auth.test', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secrets['SLACK_BOT_TOKEN']}`,
            'Content-Type': 'application/json',
          },
        })
        const body = await res.json() as { ok: boolean; team?: string; bot_id?: string; error?: string }
        if (!body.ok) throw new Error(body.error ?? 'auth.test returned ok=false')
        sSlack.stop(`Bot verified  ·  Workspace: ${body.team ?? 'unknown'}`)
        slackOk = true
      } catch (e: unknown) {
        sSlack.stop(`Could not verify Slack credentials - ${(e as Error).message}`)
        const decision = assertNotCancelled(await select({
          message: 'What would you like to do?',
          options: [
            { value: 'retry', label: 'Try different credentials' },
            { value: 'skip',  label: 'Skip verification and continue' },
          ],
          initialValue: 'retry',
        }))
        if (decision === 'skip') break
        const newToken = assertNotCancelled(await password({ message: 'Slack Bot Token (xoxb-...):', mask: '*' }))
        if (newToken) secrets['SLACK_BOT_TOKEN'] = newToken
      }
    }
  }

  if (selectedChannels.includes('whatsapp')) {
    note(
      [
        'IMPORTANT — read this before continuing.',
        '',
        'WhatsApp integration links your personal WhatsApp account to Shrok using',
        'the Baileys library, which connects via the same mechanism as WhatsApp Web.',
        '',
        'Risks you need to know about:',
        '',
        'Account ban: WhatsApp\'s terms of service prohibit unofficial clients.',
        'Accounts using Baileys have been permanently banned, including accounts',
        'that ran for years without issue. Bans can happen at any time.',
        '',
        'Unofficial API: Baileys works by impersonating WhatsApp Web. It can break',
        'without warning if WhatsApp changes their protocol.',
        '',
        'Device limit: WhatsApp supports up to 4 linked devices. Your primary phone',
        'must come online at least every 14 days to keep linked devices active.',
        '',
        'Only install @whiskeysockets/baileys (the official package). A malicious fork',
        'was found on npm in 2025 that silently exfiltrated tokens and messages.',
        '',
        'Consider using a secondary/burner WhatsApp account if ban risk is a concern.',
      ].join('\n'),
      'WhatsApp — risks'
    )

    const whatsappConfirmed = assertNotCancelled(await confirm({
      message: 'I understand the risks and want to continue with WhatsApp',
      initialValue: false,
    }))

    if (whatsappConfirmed) {
      note(
        [
          'Shrok will link to your WhatsApp account via a QR code scan.',
          '',
          'You\'ll also need to tell Shrok which phone number (contact) it should',
          'listen to and respond to — typically your own number if you\'re sending',
          'messages to yourself, or a trusted contact\'s number.',
          '',
          'Format: country code + number, no spaces or symbols.',
          'Example: 19175551234 for a US number, 447911123456 for UK.',
        ].join('\n'),
        'WhatsApp setup'
      )

      const whatsappPhone = assertNotCancelled(await text({
        message: 'Phone number that Shrok should respond to (with country code, no + or spaces):',
        initialValue: (() => {
          const existing = existingEnv['WHATSAPP_ALLOWED_JID'] ?? ''
          return existing.replace('@s.whatsapp.net', '')
        })(),
        validate: (v) => /^\d{7,15}$/.test((v ?? '').trim())
          ? undefined
          : 'Digits only with country code, e.g. 19175551234',
      }))
      if (whatsappPhone) {
        secrets['WHATSAPP_ALLOWED_JID'] = `${whatsappPhone.trim()}@s.whatsapp.net`
      }

      note(
        [
          'After setup completes and Shrok starts, you\'ll need to scan a QR code.',
          '',
          '1. Open your Shrok logs (npm start) or check:',
          '   $WORKSPACE_PATH/whatsapp-qr.txt',
          '2. A QR code will appear when the WhatsApp session starts.',
          '3. On your phone: WhatsApp → Settings → Linked Devices → Link a Device.',
          '4. Scan the QR code. Once scanned, Shrok is connected.',
          '',
          'You won\'t need to scan again unless you log out or the session expires.',
          'Your primary phone must stay online at least once every 14 days.',
        ].join('\n'),
        'QR code scan — next step after setup'
      )
    }
  }
}
