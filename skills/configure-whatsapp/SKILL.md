---
name: configure-whatsapp
description: Set up the WhatsApp channel integration — QR pairing and connection.
---

Before starting, warn the user:
- **Ban risk**: WhatsApp prohibits unofficial clients. Accounts using Baileys have been permanently banned. Consider a secondary/burner account.
- **Unofficial API**: Baileys impersonates WhatsApp Web and can break without warning.
- **Device limit**: Max 4 linked devices. Primary phone must come online every 14 days.
- **Supply chain**: Only `@whiskeysockets/baileys` is legitimate. A malicious fork was found on npm in 2025.

Install the Baileys library (not bundled by default): `cd $SHROK_ROOT && npm install @whiskeysockets/baileys`

Get the allowed phone number (digits only, with country code, no plus sign — e.g. `19175551234`). Convert to JID: `<number>@s.whatsapp.net`.

Write config: `cd $SHROK_ROOT && npm run config:set -- WHATSAPP_ALLOWED_JID=<number>@s.whatsapp.net`

Start adapter: `touch $SHROK_WORKSPACE_PATH/.reload-whatsapp`

**QR scanning:** After `touch $SHROK_WORKSPACE_PATH/.reload-whatsapp`, wait ~5 seconds for the adapter to start. The QR code is saved as a PNG image at `$SHROK_WORKSPACE_PATH/media/whatsapp-qr.png`.

Tell the user the exact file path (`$SHROK_WORKSPACE_PATH/media/whatsapp-qr.png`). Do NOT paste the raw QR data as text. Do NOT use `view_image` — that only lets you see it, it doesn't deliver it to the user.

Along with the file path, tell the user: open WhatsApp → Settings → Linked Devices → Link a Device → scan the image. The QR expires after ~60 seconds and auto-regenerates — if they miss it, tell them to re-view the same file path.

If session is invalidated ("Logged out" in logs), delete `$SHROK_WORKSPACE_PATH/whatsapp/auth/` and reload to re-pair.
