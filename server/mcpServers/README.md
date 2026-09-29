# Bundled MCP servers

First-party MCP servers that ship **inside the API image** instead of being pulled
from npm at install time.

Most marketplace entries (`agent-hub/src/config/mcpCatalog.js`) spawn `npx -y
<package>`. That is fine for a vendor-published server, but not for integrations
where the user hands over a password to something we do not control. Those live
here: the process runs from our own image, with the user's credentials injected
as env vars by `core/mcpManager.js`, and talks to nothing but the upstream
service.

## How a bundled server is wired up

1. Code goes in `server/mcpServers/<id>/`. The entrypoint is `index.mjs` — ESM,
   because `@modelcontextprotocol/sdk` is ESM-only. Keep pure logic in a sibling
   CommonJS module so `node --test` can require it.
2. The catalog entry uses `command: 'node'` and a **repo-relative** path:
   ```js
   { id: 'soverin', command: 'node', args: ['mcpServers/soverin/index.mjs'], bundled: true, … }
   ```
   `mcpManager.resolveBundledArgs()` turns the `mcpServers/…` prefix into an
   absolute path before spawning, so the spawn does not depend on the API
   process's cwd (`/app` in Docker, repo root under some dev launchers).
3. Tool discovery must work **without credentials** — the marketplace probes a
   server the moment an admin installs it, long before any user has filled in
   their details. Connect lazily inside the tool handlers, not at startup.
4. `stdout` is the JSON-RPC channel. Anything that prints there corrupts the
   protocol: mute library loggers (ImapFlow's pino logger in particular) and send
   diagnostics to `stderr`.

## Soverin (`soverin/`)

[Soverin](https://soverin.nl) is a Dutch privacy-first mail provider with no HTTP
API — it speaks IMAP + SMTP, so that is what this server drives.

Tools: `list_mailboxes`, `search_messages`, `read_message`, `send_message`,
`mark_message`, `move_message`. Attachment metadata is returned; attachment bytes
never are.

Per-user credentials (Settings → Integrations):

| Key | Meaning |
|-----|---------|
| `SOVERIN_EMAIL` | Full mailbox address — Soverin uses it as the username |
| `SOVERIN_PASSWORD` | Mailbox password |

Operator env (set on the API container, applies to every user):

| Key | Default | Meaning |
|-----|---------|---------|
| `SOVERIN_IMAP_HOST` | `imap.soverin.net` | |
| `SOVERIN_IMAP_PORT` | `993` | `143` switches to STARTTLS |
| `SOVERIN_SMTP_HOST` | `smtp.soverin.net` | |
| `SOVERIN_SMTP_PORT` | `465` | `587` switches to STARTTLS |
| `SOVERIN_READ_ONLY` | unset | `1` drops `send_message`, `mark_message` and `move_message` from the tool list — agents can read the mailbox but never send or mutate |
| `SOVERIN_MAX_BODY_CHARS` | `8000` | Body truncation cap in `read_message` |

Because the host/port defaults are only defaults, the same server works for any
IMAP/SMTP mailbox — point the four host/port vars elsewhere and the Soverin entry
becomes a generic mail connector.

Smoke test without touching the marketplace:

```bash
cd server
SOVERIN_EMAIL=you@example.nl SOVERIN_PASSWORD=… node mcpServers/soverin/index.mjs
# then speak JSON-RPC on stdin, or install it from Admin → Integrations → MCP
```

## Tuya (`tuya/`)

[Tuya](https://developer.tuya.com) is the cloud behind Smart Life and most
white-label smart plugs, lamps and sensors. It publishes no MCP server a client
can connect to — `tuya/tuya-mcp-sdk` points the other way (it exposes *your*
capabilities to Tuya's agent, in Python/Go/C#), and MCP Management on the
developer platform is about registering servers *into* Tuya. The third-party
device servers are Python and would be handed the user's Access Secret, so this
one is bundled. The Cloud OpenAPI is plain HTTPS with an HMAC-SHA256 signature,
so it needs no dependency beyond `node:crypto` and `fetch`.

Tools: `list_devices`, `get_device_status`, `get_device_functions`,
`send_command`, `switch_device`, `set_light`, `list_scenes`, `trigger_scene`.
Device summaries deliberately drop `local_key` (the per-device LAN secret) and
`ip` (the household's address).

Per-user credentials (Settings → Integrations):

| Key | Meaning |
|-----|---------|
| `TUYA_ACCESS_ID` | Cloud project Access ID |
| `TUYA_ACCESS_SECRET` | Cloud project Access Secret |
| `TUYA_UID` | Linked Smart Life app account UID — optional; without it the server lists every device in the cloud project instead, and scenes are unavailable |
| `TUYA_REGION` | `eu` (default, Central Europe) / `weu` / `us` / `cn` / `in` |

Operator env (set on the API container; also acts as the default for any of the
credentials above):

| Key | Default | Meaning |
|-----|---------|---------|
| `TUYA_BASE_URL` | — | Explicit data-center URL, wins over `TUYA_REGION` |
| `TUYA_READ_ONLY` | unset | `1` drops `send_command`, `switch_device`, `set_light` and `trigger_scene` from the tool list — agents can read the house but never change it |
| `TUYA_ALLOW_LOCKS` | unset | `1` allows commands to locks, safes, access controllers and gate openers. **Off by default on purpose**: an agent acts on text it did not write, and a prompt-injected e-mail must not be one tool call away from opening a front door. Reading their status is always allowed |

Setup on the Tuya side — the part users get stuck on:

1. Create a cloud project at [iot.tuya.com](https://iot.tuya.com) and pick the
   data center that matches the account (EU for Dutch households).
2. Under **Service API**, subscribe the project to *IoT Core* and
   *Authorization*, then authorize them for the project.
3. **Devices → Link App Account → Add App Account** and scan the QR code with
   the Smart Life / Tuya Smart app. The `uid` that appears in the list is
   `TUYA_UID`.
4. Copy the Access ID and Access Secret from the project overview.

Note that one app account can be linked to **two** cloud projects at most, so do
not burn both slots experimenting.

Smoke test without touching the marketplace:

```bash
cd server
node --test mcpServers/tuya/tuya.test.js       # signature vector + helpers, no account needed
TUYA_ACCESS_ID=… TUYA_ACCESS_SECRET=… TUYA_UID=… node mcpServers/tuya/index.mjs
# then speak JSON-RPC on stdin, or install it from Admin → Integrations → MCP
```
