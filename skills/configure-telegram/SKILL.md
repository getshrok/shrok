---
name: configure-telegram
description: Set up the Telegram channel integration — bot token and chat ID.
---

You need a bot token and a chat ID.

**Bot token:** Message [@BotFather](https://t.me/BotFather) → `/newbot` → choose display name → choose username (must end in `bot`) → copy token. Keep it secret — `/revoke` to BotFather if exposed.

**Chat ID:** Message [@userinfobot](https://t.me/userinfobot) → it replies with your Chat ID (a number like `123456789`).

Write credentials: `cd $SHROK_ROOT && npm run config:set -- TELEGRAM_BOT_TOKEN=<token> TELEGRAM_CHAT_ID=<chatId>`

Hot-reload: `touch $WORKSPACE_PATH/.reload-telegram`
