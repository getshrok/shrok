---
name: configure-discord
description: Set up the Discord channel integration — bot token, channel ID, and connection.
---

You need a bot token and a channel ID from the user.

**Creating the bot:**
1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Create
2. Bot tab → enable **Message Content Intent** under Privileged Gateway Intents
3. Token section → Reset Token → copy it (shown once)

**Inviting the bot:**
1. OAuth2 → URL Generator → check `bot` scope
2. Bot Permissions: **Send Messages**, **Read Message History** (minimum)
3. Copy URL → open in browser → select server → Authorize (needs Manage Server permission)

**Getting channel ID:** User Settings → Advanced → enable Developer Mode. Then right-click the channel → Copy Channel ID.

Write credentials: `cd $SHROK_ROOT && npm run config:set -- DISCORD_BOT_TOKEN=<token> DISCORD_CHANNEL_ID=<channelId>`

Hot-reload: `touch $SHROK_WORKSPACE_PATH/.reload-discord`
