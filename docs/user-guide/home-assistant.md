# Home Assistant Voice Setup

Shrok acts as the conversation brain for your Home Assistant Voice Preview Edition (VPE) via an OpenAI-compatible `/v1/chat/completions` endpoint. When you speak to the VPE, Home Assistant routes the transcribed text to Shrok, which responds synchronously within a brief deadline; any follow-up results arrive asynchronously via `assist_satellite.announce` on the device speaker.

## Overview

Home Assistant's Extended OpenAI Conversation integration calls Shrok's `/v1/chat/completions` endpoint the same way it would call the real OpenAI API — you point it at your Shrok host and supply the `HA_INBOUND_API_KEY` as the API key. Shrok holds the HTTP connection open for up to 3 seconds while processing the turn. If the reply lands within that window, it is returned in-turn and spoken on the device immediately. If the head takes longer, the connection is released and the reply is delivered later via `assist_satellite.announce` — you hear the response on the device a moment after the VPE returns to idle.

## Prerequisites

- Home Assistant Core >= 2026.3
- HACS installed in your HA instance (see [HACS installation guide](https://hacs.xyz/docs/use/download/download/))
- Shrok running and reachable from your HA instance (same host, LAN, or via reverse proxy)
- A `home-assistant` channel entry in your Shrok `config.json` (see Section 3)
- (Remote/proxied topology only) A reverse proxy with the `/v1/` auth bypass configured — see Section 5

## Shrok-Side Configuration

### config.json channel block

Add the following entry to the `channels` array of the relevant head in `~/.shrok/workspace/config.json`:

```json
{
  "id": "home-assistant",
  "vendor": "home-assistant",
  "haBaseUrl": "http://homeassistant.local:8123",
  "haVoiceSatelliteEntityId": "assist_satellite.home_assistant_voice_YOURDEVICE_assist_satellite"
}
```

Replace `homeassistant.local:8123` with the address Shrok uses to reach your HA instance (typically `http://127.0.0.1:8123` if both run on the same host). Replace the `haVoiceSatelliteEntityId` value with your device's actual entity ID — see Section 6 for how to find it. The entity ID must start with `assist_satellite.`.

### .env keys

Add these two keys to `~/.shrok/workspace/.env`:

```
HA_ACCESS_TOKEN=<long-lived token from HA profile>
HA_INBOUND_API_KEY=<a secret you invent — paste this into the HACS component too>
```

`HA_ACCESS_TOKEN` is the outbound token Shrok uses to call HA (for example, to deliver responses via `assist_satellite.announce`). Create it in the HA UI: User Profile → Long-Lived Access Tokens → Create. Use a dedicated minimal-permission HA user for this token, not the owner account.

`HA_INBOUND_API_KEY` is the secret HA presents to Shrok when sending voice turns. Invent any non-empty string; you will paste the same value into the Extended OpenAI Conversation integration in the next section.

These keys are separate secrets and rotate independently. Neither should appear in `config.json`.

Restart Shrok after editing `config.json` or `.env`:

```bash
systemctl --user restart shrok
```

Verify the adapter loaded:

```bash
journalctl --user -u shrok | grep home-assistant
```

## HA-Side Setup (Extended OpenAI Conversation)

1. Install HACS if not already present (see [https://hacs.xyz/docs/use/download/download/](https://hacs.xyz/docs/use/download/download/)).

2. In HACS → Integrations, search for **Extended OpenAI Conversation** (by jekalmin) and click **Download**.

3. Restart Home Assistant when prompted.

4. Go to Settings → Integrations → Add Integration → search **Extended OpenAI Conversation**. When prompted:
   - **API Key**: the value of `HA_INBOUND_API_KEY` from your `.env`
   - **Base URL**: the address HA uses to reach Shrok's `/v1` endpoint
     - Co-located (same host): `http://127.0.0.1:8888/v1` (or whatever address is reachable from HA's perspective — on `network_mode: host` this is the host's LAN IP, e.g. `http://192.168.1.100:8888/v1`)
     - Remote (Shrok behind a reverse proxy): `https://your-domain.com/v1` — configure the Apache bypass first (Section 5)

5. Go to Settings → Voice Assistants → edit your assistant → Conversation Agent → select **Extended OpenAI Conversation**.

6. Go to Settings → Devices & Services → Devices → click your Voice PE → copy the `assist_satellite.*` entity ID (you will need it for `haVoiceSatelliteEntityId` in Section 3).

## Reverse Proxy Setup

This section applies **only** when HA is not co-located with Shrok. If both run on the same host, HA can reach Shrok directly over localhost or the LAN IP — no proxy configuration is needed and you can skip this section.

When Shrok is behind a reverse proxy (Apache, nginx, etc.) that uses basic authentication to protect all paths, HA's Bearer token will be rejected by the proxy before it ever reaches Shrok. The proxy returns a `401 Unauthorized` with a `WWW-Authenticate: Basic` header, which HA cannot respond to. The fix is to exempt `/v1/` from basic auth so HA's Bearer token passes through to Shrok's own authentication layer.

### Apache

Add the following block to your vhost file, **before** the catch-all basic-auth `<Location />` block:

```apache
# Place BEFORE the catch-all basic-auth <Location /> block in your vhost.
# Required so Home Assistant's Bearer token reaches Shrok's /v1 router
# instead of hitting Apache's Basic auth (which HA cannot respond to).
# Shrok's own bearer check on /v1 handles authentication.
<Location "/v1/">
    AuthType None
    Require all granted
</Location>
```

Apply and verify:

```bash
sudo apache2ctl configtest && sudo systemctl reload apache2
```

Confirm the bypass is working:

```bash
curl -v https://your-domain.com/v1/chat/completions
```

Expected: an HTTP 401 response with body `{"error":"Unauthorized"}` and **no** `WWW-Authenticate: Basic` header. This is Shrok's own authentication rejection, which means HA's Bearer token reached Shrok correctly. If you see `WWW-Authenticate: Basic realm=...` instead, the bypass block is not positioned before the catch-all, or the reload did not take effect.

The `AuthType None` block is safe because Shrok's own bearer check on `/v1` is the authentication gate — Apache is simply forwarding the request.

## Satellite Entity ID — Finding It

`haVoiceSatelliteEntityId` must be the `assist_satellite.*` entity for your specific device, not a device ID. To find it:

1. Go to Settings → Devices & Services → Devices in your HA UI.
2. Click on your Voice PE device.
3. Locate the entity whose ID starts with `assist_satellite.`.
4. Copy the full entity ID — it has the format `assist_satellite.home_assistant_voice_<device-slug>_assist_satellite`.

Paste this value as `haVoiceSatelliteEntityId` in your Shrok `config.json` channel block.

## Verify It Works

Speak a question to the VPE device. Shrok acknowledges in-turn within the reply deadline; any follow-up content arrives asynchronously via `assist_satellite.announce` and is spoken on the device.

Check Shrok's journal to see inbound dispatches and outbound announce calls:

```bash
journalctl --user -u shrok | grep home-assistant
```

Look for lines like `[home-assistant] turn dispatched` (inbound received) and `[home-assistant] announce delivered` (async result spoken).

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| Device says nothing, returns to idle | Inbound endpoint not reached or reply exceeded the deadline | Check Shrok logs for `[home-assistant]`; if behind a proxy, verify no Apache Basic auth on `/v1/` (Section 5) |
| HA logs "Error talking to OpenAI" | Bearer token mismatch or proxy blocking | Run the `curl -v` check from Section 5; confirm `HA_INBOUND_API_KEY` in `.env` matches the API Key in the Extended OpenAI Conversation integration |
| Announce never fires | `HA_ACCESS_TOKEN` missing or wrong, or `haBaseUrl` unreachable | Check Shrok logs for announce errors; confirm `haBaseUrl` is the address Shrok uses to reach HA and that HA is running |
| Satellite stuck speaking | Known HA bug — satellite stuck in RESPONDING state | Power-cycle the VPE device |
