---
name: configure-llm-provider
description: Set up or switch the AI provider (Anthropic, Google Gemini, or OpenAI). Only used for conversation.
---

Ask which provider: `anthropic`, `gemini`, or `openai`. Then get the API key.

**Anthropic:** [console.anthropic.com](https://console.anthropic.com) → Settings → Billing (add card, buy credits — key won't work without credits) → API Keys → Create Key. Copy immediately, shown once.

**Gemini:** [aistudio.google.com](https://aistudio.google.com) → Get API key in sidebar. Key starts with `AIza`.

**OpenAI:** [platform.openai.com](https://platform.openai.com) (separate from ChatGPT) → Billing (add payment, load credit) → Settings → API Keys → Create new secret key. Copy immediately, shown once.

Env var mapping: anthropic → `ANTHROPIC_API_KEY`, gemini → `GEMINI_API_KEY`, openai → `OPENAI_API_KEY`.

Write config: `cd $SHROK_ROOT && npm run config:set -- LLM_PROVIDER=<provider> <API_KEY_VAR>=<key>`

Restart: `touch $HOME/.shrok/.restart-requested`

**Beyond the basics:**
- **Per-tier model IDs** live in `config.json` (the workspace `config.json`, NOT `.env`) — e.g. `anthropicModelDumb`/`anthropicModelSmart`/`anthropicModelGenius` and the `gemini*`/`openai*` equivalents. Edit them there (or via the Settings dashboard) to override the defaults; the API keys stay in `.env`.
- **Fallback chain:** set `LLM_PROVIDER_PRIORITY` (e.g. `anthropic,gemini,openai`) in `.env` to auto-fall-back to the next provider on auth/rate-limit/server errors. Each provider in the chain needs its API key set.
