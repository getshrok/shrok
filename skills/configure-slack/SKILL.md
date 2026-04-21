---
name: configure-slack
description: Set up the Slack channel integration — bot token, app-level token, and channel ID.
---

You need three things: a bot token (`xoxb-`), an app-level token (`xapp-`), and a channel ID.

**Creating the app:**
1. [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
2. OAuth & Permissions → add bot scopes: `chat:write`, `chat:write.public`, `app_mentions:read`, `channels:history`, `im:history`, `im:write`, `files:read`, `files:write`
3. Install to Workspace → copy **Bot User OAuth Token** (`xoxb-`)

**Socket Mode (for receiving messages without a public URL):**
1. Socket Mode in sidebar → toggle ON
2. App-Level Tokens → Generate → name it anything → add `connections:write` scope → copy token (`xapp-`)

**Event subscriptions:**
1. Event Subscriptions → toggle ON
2. Subscribe to bot events: `app_mention`, `message.channels`, `message.im`
3. Save → Reinstall to Workspace to apply new permissions

**Channel ID:** Right-click channel → View channel details → scroll to bottom (looks like `C012AB3CD`). Bot must be invited with `/invite @BotName`.

Write credentials: `cd $SHROK_ROOT && npm run config:set -- SLACK_BOT_TOKEN=<token> SLACK_APP_TOKEN=<appToken> SLACK_CHANNEL_ID=<channelId>`

Hot-reload: `touch $WORKSPACE_PATH/.reload-slack`
