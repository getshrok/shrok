---
name: configure-search-provider
description: Set up or switch the web search provider (Tavily or Brave Search).
---

Ask which provider: `tavily` (1000 free searches/month, no card required) or `brave` (1000 free queries/month, card required).

**Tavily:** [app.tavily.com](https://app.tavily.com) → create account → set up 2FA (authenticator app required) → API key on dashboard.

**Brave:** [brave.com/search/api](https://brave.com/search/api) → Get Started → create account (card required) → [api-dashboard.search.brave.com](https://api-dashboard.search.brave.com) → API Keys → create key.

Env var mapping: tavily → `TAVILY_API_KEY`, brave → `BRAVE_API_KEY`.

Write config: `cd $SHROK_ROOT && npm run config:set -- SEARCH_PROVIDER=<provider> <API_KEY_VAR>=<key>`

Restart: `touch $HOME/.shrok/.restart-requested`
