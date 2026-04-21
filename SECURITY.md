# Security

Shrok is a personal agent that runs on your machine with your user privileges. It can read files, run commands, send messages, and use any account you connect to it. That's a lot of trust to place in any piece of software, so this page is about what to expect, what to watch for, and how to tell me if you find something wrong.

## Reporting a vulnerability

If you think you've found a security issue, please don't open a public GitHub issue for it. Email **ashley@shrok.ai** with a description of the problem and how to reproduce it. I'll get back to you as quickly as I can and work with you on a fix before anything becomes public.

## What Shrok can do

By default, Shrok runs as your user and can:

- Read and write files in your home directory
- Run shell commands
- Send and receive messages on any channel you've connected (Discord, WhatsApp, Slack, Telegram, Zoho Cliq)
- Make network requests, including to your local network
- Use any API key you've added to its config

Every agent Shrok spawns gets shell access and network by default. You can restrict the tool surface per-skill via frontmatter, or globally via `workerDefaults.allowedTools` in config.json. The `bash_no_net` tool uses Linux network namespaces to block outbound access — on macOS and Windows it falls back to regular bash since there's no OS-level equivalent.

## Known risks

**Prompt injection.** Any content Shrok processes — messages sent to it, emails it reads, web pages it fetches, files it opens — can contain hidden instructions that try to get it to do something you didn't ask for. This is an unsolved problem across the whole AI agent space, not something specific to Shrok. Use strong models, be thoughtful about which skills you install, and don't connect Shrok to accounts or data you aren't prepared to have influenced by untrusted input.

**Skills run with your privileges.** Skills are code. A malicious skill can do anything you can do on your machine. The [getshrok/skills](https://github.com/getshrok/skills) repo is curated, but skills from anywhere else — including ones Shrok writes for itself on your request — should be reviewed before you install them.

**Credentials live on disk.** API keys and channel tokens are stored in `~/.shrok/workspace/.env` and `~/.shrok/workspace/config.json`. Anyone with read access to your home directory can read them. If you share a machine, think about what that means.

**The dashboard is on localhost.** The web dashboard binds to `127.0.0.1:8888` by default — only reachable from the same machine. If you need remote access, use a reverse proxy (nginx, Caddy, Tailscale) rather than setting `dashboardHost` to `0.0.0.0`.

**Channel accounts are a blast radius.** If someone gets into the Discord or Slack account Shrok is listening on, they can send it instructions. Use channel allowlists where the integration supports them, and treat the account Shrok listens on with the same care you'd give an account that has access to your files — because that's effectively what it has.

## Known dependency vulnerabilities

The following high-severity CVEs exist in transitive dependencies with no upstream fix available. They are documented here for transparency:

- **tar** (<=7.5.10) — hardlink/symlink path traversal allowing arbitrary file read/write during archive extraction. Shrok does not extract untrusted tar archives, so this is not exploitable in normal use. Reached via `kuzu` → `cmake-js` → `tar`.
- **kuzu** / **cmake-js** — native graph database used for the memory subsystem. The `tar` vulnerability is inherited through its build toolchain, not through runtime behavior.

These will be resolved when upstream publishes fixed versions. Run `npm audit` to check current status.

## What to do if something goes wrong

If you think Shrok has been compromised or has done something it shouldn't have:

1. Stop it: `shrok stop` to shut down the daemon, or just kill the process directly.
2. Rotate any API keys and channel tokens in `~/.shrok/workspace/.env`. Assume they're leaked.
3. Check `~/.shrok/workspace/skills` for anything you don't recognize.
4. Look through recent activity in the dashboard's Usage area for anything surprising.

If you think it's a bug rather than an account compromise, please report it using the process at the top of this page.
