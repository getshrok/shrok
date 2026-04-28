---
name: configure-zoho-cliq
description: Set up the Zoho Cliq channel integration — OAuth credentials and chat ID.
---

You need Zoho OAuth credentials and a Cliq chat ID.

**OAuth credentials:** If the user already has `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and `ZOHO_REFRESH_TOKEN` configured (e.g. from zoho-mail or zoho-calendar), the existing refresh token won't work here unless it was generated with the Cliq scopes below. If not set up yet:

1. Go to [Zoho API Console](https://api-console.zoho.com/) → Add Client → Server-based Applications
2. Set redirect URI to `https://accounts.zoho.com` (or any URL you control)
3. Copy the Client ID and Client Secret
4. Generate a refresh token with scopes: `ZohoCliq.Messages.READ,ZohoCliq.Messages.CREATE,ZohoCliq.Chats.READ,ZohoCliq.Chats.CREATE,ZohoCliq.Channels.READ,ZohoCliq.Channels.CREATE,ZohoCliq.Webhooks.CREATE,ZohoCliq.Attachments.READ`

**Chat ID:** The ID of the Cliq chat or channel to monitor. Find it in the Cliq web app URL when viewing the chat, or via the API: `GET https://cliq.zoho.com/api/v2/chats`.

Write credentials: `cd $SHROK_ROOT && npm run config:set -- ZOHO_CLIENT_ID=<id> ZOHO_CLIENT_SECRET=<secret> ZOHO_REFRESH_TOKEN=<token> ZOHO_CLIQ_CHAT_ID=<chatId>`

Hot-reload: `touch $SHROK_WORKSPACE_PATH/.reload-zoho-cliq`
