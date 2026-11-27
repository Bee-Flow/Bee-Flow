---
title: Environment variables
---

# Environment variables

The Bee Flow server is configured through environment variables. This page
covers the operationally important ones, grouped by area; defaults are quoted
from the example files and the server code, not invented.

The annotated example files in the repository list the variables an operator
normally sets, each with its rationale:

- [`.env.selfhost.example`](https://github.com/Bee-Flow/Bee-Flow/blob/main/.env.selfhost.example) — what `./selfhost.sh` copies to `.env` for a self-hosted server.
- [`.env.example`](https://github.com/Bee-Flow/Bee-Flow/blob/main/.env.example) — repository root; what the Compose stack and a dev checkout read.
- [`server/.env.example`](https://github.com/Bee-Flow/Bee-Flow/blob/main/server/.env.example) — the server's own template.

Neither this page nor those files are complete. The server reads several
hundred variables, and most of the ones documented nowhere are tuning knobs
with a safe default (time-outs, intervals, batch sizes). For a variable you do
not find here, the code is the reference: search `server/` for its name. The
switches that relax a safety default are listed under
[Switches that relax a safety default](#switches-that-relax-a-safety-default)
below, whether or not an example file names them.

:::warning No silent fallbacks for secrets
The server **refuses to boot** when a required secret is missing or too weak.
That is intentional: a silent fallback to a predictable default is how secrets
get effectively published.
:::

## Required secrets (fail-closed boot)

| Variable | Default | Purpose |
|----------|---------|---------|
| **`SESSION_SECRET`** | — (boot fails) | Signs the session cookie and derives keys for feature-scoped vaults. Must be a random value of at least 32 characters; anything shorter throws at start-up. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Rotating invalidates existing sessions. |
| **`MASTER_ENCRYPTION_KEY`** | — (boot fails) | Keys everything encrypted at rest (OAuth tokens, stored API keys). Must be random, at least 32 characters. Generate: `openssl rand -hex 32`. Rotating breaks decryption of already-stored tokens — re-link integrations after rotation. |
| `BEEFLOW_DEFAULT_ENCRYPTION_TIER` | `managed` | The content-encryption tier a **new** organisation starts on: `managed`, `off` (also `none`) or `zk`. `managed` is on every plan and needs `MASTER_ENCRYPTION_KEY`; `zk` needs a plan or licence that includes encryption. When the tier is not available, the organisation starts on off. Organisations that already exist keep their tier; an admin changes it under Admin dashboard → Organisation → Encryption. |
| **`BROWSER_WS_PATH`** | — (compose refuses to start) | Private path of the headless-browser sidecar (`ws://browser:9222/<path>`). The sidecar has no other authentication, so treat it as a secret: `openssl rand -hex 24`. `selfhost.sh` generates it, also for an existing `.env`. |
| **`WEBPAGE_PREVIEW_TOKEN_SECRET`** | auto-generated in dev only | HMAC key for the short-lived (4h) preview-iframe bearer tokens. In production you **must** set it explicitly. |

## Database

| Variable | Default | Purpose |
|----------|---------|---------|
| **`CORE_DATABASE_URL`** | `postgresql://beeflow:beeflow@localhost:5432/beeflow_core` | Connection string for the primary (`beeflow_core`) database — the server's runtime pool. |
| **`DATABASE_URL`** | `postgresql://beeflow:beeflow@localhost:5432/beeflow_tasks` | Connection string for the productivity-tasks database. |
| `DB_POOL_MAX` | `40` | Maximum Postgres connections of the core pool, per server process. A query holds a connection only while it runs, so this limits parallel queries, not users. With several replicas keep replicas × `DB_POOL_MAX` below Postgres' `max_connections` (100 in the Compose stack), or put PgBouncer in front. |
| `CONFIG_CACHE_MAX` | `5000` | Most settings a server process keeps in memory (each for 60 seconds) in front of the `config` table. Above it the expired and then the oldest entries are dropped; a dropped entry costs one extra read. At least `100`. |
| `MONITORING_DATABASE_URL` | derived by Compose | Monitoring database. The Compose files build all three from `DB_USER` / `DB_PASSWORD` / `DB_NAME` — see [Docker Compose → Three databases](docker-compose.md#three-databases-not-one). |

The Compose stack also creates `beeflow_tasks` and `monitoring_db` on the same
Postgres instance.

## HTTP listener and public URLs

| Variable | Default | Purpose |
|----------|---------|---------|
| `SERVER_PORT` | `3001` | HTTP port the server listens on (`PORT` is honoured as a fallback). |
| `SERVER_BIND_HOST` | `127.0.0.1` | Interface that publishes `SERVER_PORT`. Loopback on purpose: the API is meant to be reached through the agent-hub nginx, where the rate limits and security headers live. Set to `0.0.0.0` only when something off-machine must talk to the API port itself. |
| `CLIENT_BIND_HOST` | `0.0.0.0` | Interface that publishes `CLIENT_PORT` (the web UI) in the compose stacks. All interfaces by default so a first install is reachable from the LAN. Docker publishes a port ahead of ufw/firewalld — a rule there does not close it — so behind a reverse proxy, and for any stack that must not be reachable from outside the machine, set `127.0.0.1`. A named stack (`STACK_NAME=…`, see [several stacks on one machine](multi-stack.md)) gets that default from `selfhost.sh`. |
| `TRUST_PROXY_HOPS` | `1` | How many proxies sit in front of the server (a whole number; `0` means none). Rate limiting and login throttling key on the client IP; behind two proxies (e.g. CDN + nginx) set this to `2` or every visitor shares one bucket. A value that is not a number refuses to boot. |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | `65000` (65 s) | How long the server keeps an idle connection open. It must be longer than the idle time-out of the proxy or load balancer in front (60 s for nginx and most cloud load balancers), or the proxy now and then reuses a connection the server has just closed and answers 502. Raise it when your proxy keeps idle connections longer than a minute. |
| `HTTP_HEADERS_TIMEOUT_MS` | `66000` (66 s) | How long a client may take to send its request headers. Always kept at least one second above `HTTP_KEEP_ALIVE_TIMEOUT_MS`. |
| `BOOT_READY_TIMEOUT_MS` | `300000` (5 min) | How long the readiness probe (`GET /api/ready`) answers `503 starting` while the schema and the boot migrations are still running. After that the server reports ready anyway and logs which step is still running, so a migration that hangs cannot keep a rollout waiting for good. The liveness answer (`/api/health`) never waits for any of this. |
| `PUBLIC_BASE_URL` | (none) | Public base URL of the API (`https://api.example.com`). Used for outgoing webhooks and callback URLs — and it is the switch that decides whether MS-Graph subscriptions get provisioned at all. |
| `SERVER_PUBLIC_HOST` / `SERVER_PROTOCOL` | `localhost:3001` / `http` | How the API is addressed externally. |
| `CLIENT_PUBLIC_HOST` / `CLIENT_PROTOCOL` | `localhost:5176` / `http` | Where the SPA lives; drives CORS and OAuth redirect URLs. |
| `CORS_ORIGIN` | `http://localhost:5176` | Comma-separated list of allowed browser origins. |
| `PUBLIC_SITE_URL` | falls back to `PUBLIC_BASE_URL` | Public origin of the marketing site: canonical/og URLs, sitemap, and the robots.txt gate. Unset on a public site means `Disallow: /` — it will not be indexed. Leave unset on staging. |

## Sessions and cookies

| Variable | Default | Purpose |
|----------|---------|---------|
| `SESSION_MAX_AGE_DAYS` | `30` | Session lifetime in days; fractions allowed (`0.5` = 12 hours), capped at 365. An unparseable or non-positive value falls back to 30 — never to "no expiry". |
| `SESSION_ROLLING` | `false` | The default is a **fixed 30-day window from sign-in**, not an inactivity timeout. Set to `true` if your access-control policy describes inactivity (most do). Only the exact string `true` enables it. |
| `COOKIE_SECURE` | on when `NODE_ENV=production` | Send the session cookie over HTTPS only. Set explicitly to `false` only in dev over plain HTTP. |
| `COOKIE_SAMESITE` | `lax` | `lax` / `strict` / `none`. |
| `COOKIE_NAME` | `connect.sid` | Session cookie name. |
| `COOKIE_DOMAIN` | — | Set when the SPA and API are on different subdomains (e.g. `.example.com`). |

## Deployment mode

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEPLOYMENT_MODE` | `cloud` | `cloud` (Bee Flow SaaS — Stripe subscriptions, consumer accounts) or `self-hosted` (customer-run — licence keys, no billing, Community tier by default, organisation domain allow-lists). These are the only two valid values; the retired `private-cloud` is treated as `self-hosted`. |
| `STUDIO_APP_ENGINE` | `sqlite` | Where App Studio keeps the records of an app. `sqlite`: one SQLite file per app in object storage, written by **one** server process, so it fits a single server container (the compose install). `pg`: a Postgres schema per app in `beeflow_core`, required as soon as more than one server replica runs. Apps made under `sqlite` have to be moved before the switch (`node scripts/migrateStudioAppsToPg.js --all`, with `--dry-run` first); an app is only served by the engine it is marked for. See [Kubernetes](kubernetes.md#server-replicas). |
| `BEEFLOW_MODULE_ROOTS` | `modules/` beside `server/`, when it exists | Development layout only; a production image does not need it. Directories that hold `<id>/server` for first-party modules, separated like `PATH` (`:`, `;` on Windows). Empty means core only. |
| `BEEFLOW_HIDE_MODULES` | — | Development and CI only. `all`, or a comma-separated list of module ids whose files count as absent, to run the server as core without them. |
| `BEEFLOW_EDITION` | `full` | `core` runs the core only (chat, knowledge base, memory, agents and the platform under them) and loads no first-party module. Any other value, or unset, loads every module unless `BEEFLOW_MODULES` is set. See [Choosing the modules](#choosing-the-modules). |
| `BEEFLOW_MODULES` | — | A comma-separated list of first-party module ids: the core plus exactly these. Wins over `BEEFLOW_EDITION`. An unknown id is ignored with a warning in the log. See [Choosing the modules](#choosing-the-modules). |

### Choosing the modules

Leave both `BEEFLOW_EDITION` and `BEEFLOW_MODULES` unset for the full product: every module loads, as before. Otherwise the server loads the core plus the modules you list, and a module that is left out has no routes, no jobs and no tables of its own.

The first-party module ids: `apps`, `automation`, `billing_stripe`, `cms`, `compliance`, `cowork`, `custom_integrations`, `datatables`, `int_erp_nl`, `int_google`, `int_microsoft`, `int_nextcloud`, `int_saas`, `learning`, `mcp_server`, `meetingNotes`, `notebooks`, `playbooks`, `projects`, `sanctions`, `support`, `templates`, `webpages`. The list also accepts `approvals`, the switch of the approval steps inside `automation`.

A module that has no switch of its own on the admin Modules page comes along when a module you list needs it: `BEEFLOW_MODULES=automation,approvals` also loads `datatables`. A module with its own switch never comes along, so `BEEFLOW_MODULES=cowork` alone loads nothing, because cowork needs `automation`. The server logs one line at start that says what it loaded and what it left out.

An installation that already sets `BEEFLOW_EDITION=core`: the integrations (`int_google`, `int_microsoft`, `int_nextcloud`, `int_erp_nl`, `int_saas`, `custom_integrations`), `datatables`, the CMS (`cms`) and Stripe billing (`billing_stripe`) used to be part of core and are modules now, and so are `templates`, `sanctions` and `mcp_server`. To keep them, list them in `BEEFLOW_MODULES`, for example `BEEFLOW_MODULES=int_google,int_microsoft,datatables`. Leaving a module out does not drop the tables it already has, and listing it again later is a restart.

## Download size limits

Each limit is in bytes, has a generous default, and `0` means no limit. They keep one huge file or page from filling the server's memory; raise or remove them on a large server.

| Variable | Default | Purpose |
|----------|---------|---------|
| `TOOL_FILE_MAX_BYTES` | `104857600` (100 MB) | Largest file the Nextcloud, Nextcloud Mail and Gmail tools read into memory. A bigger file gets a clear error naming this variable. |
| `KB_WEB_PAGE_MAX_BYTES` | `10485760` (10 MB) | Largest web page a knowledge-base source reads. A bigger page is refused, never indexed in part. |
| `KB_SITEMAP_MAX_BYTES` | `52428800` (50 MB) | Largest sitemap a crawl reads (the sitemap specification's own maximum). A bigger one is skipped; the entry page is still indexed. |
| `KB_CLOUD_MAX_FILES` | `2000` | Files one cloud-folder knowledge source reads. A folder with more is read up to this number and nothing is removed. `0` = unlimited. |
| `KB_CLOUD_MAX_FILE_MB` | `50` | Largest file (MB) a cloud-folder knowledge source reads. A bigger file is skipped and logged. `0` = unlimited. |
| `KB_QUERY_LOG_READS_PER_HOUR` | `600` | Pages of a knowledge base's query log (question and answer text) one person reads per hour. Each page is recorded in the access audit. `0` = unlimited. |
| `KB_CLOUD_CHANGE_POLL_SECONDS` | `300` | How often a cloud-folder source set to "on change" checks its folder (a cheap change check; the folder is read only when it moved). |
| `NEXTCLOUD_MAIL_ATTACHMENT_MAX_MB` | `25` | All attachments of one message sent with the Nextcloud Mail tool (`nextcloud_mail_send`) together, in MB: files from Nextcloud Files and files a document step made. A bigger set is refused before anything is sent. `0` = unlimited. |
| `NEXTCLOUD_MAIL_ATTACHMENT_MAX_COUNT` | `20` | Attachments one message sent with the Nextcloud Mail tool may carry. `0` = unlimited. |
| `AUTOMATION_NC_MAIL_MAX_ACCOUNTS` | `10` | Mail accounts the Nextcloud Mail trigger (`mail.new`) reads per automation on each poll, when Nextcloud does not push the event (no connector, an older connector or Mail, or no push for 15 minutes). `0` = every account. |
| `AUTOMATION_NC_MAIL_POLL_LIMIT` | `25` | Newest messages that poll reads per mailbox (at most 100). More new mail than this between two polls starts the automation for the newest ones only. |
| `ATTACHMENT_MAX_BYTES` | `26214400` (25 MB) | Largest single attachment the Email Sender component adds, a file or a downloaded http(s) URL. Files come only from `ATTACHMENTS_DIR` (created when missing; default `beeflow-attachments` in the temp directory). |

## Inbound and integration limits

Optional; empty means the default.

| Variable | Default | Purpose |
|----------|---------|---------|
| `AUTOMATION_WEBHOOK_RPM_PER_SLUG` | `120` | Requests one automation webhook address takes per minute. `0` = unlimited. |
| `AUTOMATION_WEBHOOK_RPM_PER_IP` | `300` | Requests one sender address may send to automation webhooks per minute. `0` = unlimited. |
| `AUTOMATION_EVENTS_RPM_PER_IP` | `600` | Provider event pushes (Nextcloud, Microsoft Graph, GitHub, Gmail) one address may send per minute. `0` = unlimited. |
| `AUTOMATION_WEBHOOK_ROTATION_OVERLAP_SECONDS` | `3600` | How long the previous secret of an automation webhook still signs after its secret is rotated. `0` = it stops at once. |
| `AUTOMATION_WEBHOOK_DELIVERY_LOG_MAX` | `100` | Deliveries kept in the log of one automation webhook (status, size, hash and time; never a body). `0` = unlimited. |
| `AUTOMATION_WEBHOOK_DELIVERY_RETENTION_DAYS` | `30` | Days a delivery stays in that log. `0` = keep. |
| `AUTOMATION_WEBHOOK_REJECT_LOG_PER_MINUTE` | `20` | Deliveries that started no run written to that log per webhook per minute; the rest are not written. `0` = unlimited. |
| `AUTOMATION_IMPORT_WINDMILL_MAX_BYTES` | `26214400` | Bytes of one Windmill export upload (25 MB), and of one answer read from a standalone Windmill. `0` = unlimited. |
| `AUTOMATION_IMPORT_WINDMILL_MAX_UNZIPPED_BYTES` | `209715200` | Bytes a Windmill export may unpack to (200 MB), counted per file before it is read; also the total of all answers read from a standalone Windmill in one import. `0` = unlimited. |
| `AUTOMATION_IMPORT_WINDMILL_MAX_FILE_BYTES` | `8388608` | Bytes one file of a Windmill export may unpack to (8 MB). `0` = unlimited. |
| `AUTOMATION_IMPORT_WINDMILL_MAX_ENTRIES` | `5000` | Files in one Windmill export. `0` = unlimited. |
| `AUTOMATION_IMPORT_WINDMILL_MAX_FLOWS` | `200` | Flows imported in one batch, and flows read one by one from a standalone Windmill. `0` = unlimited. |
| `AUTOMATION_IMPORT_WINDMILL_RPM` | `20` | Windmill import requests (preview or import) one user may send per minute. `0` = unlimited. |
| `AUTOMATION_IMPORT_WINDMILL_BRIEF_CHARS_PER_ITEM` | `6000` | Characters of source per open item in the "Complete with AI" briefing; the rest stays in the note step on the canvas. `0` = unlimited. |
| `AUTOMATION_IMPORT_WINDMILL_BRIEF_CHARS_TOTAL` | `40000` | Characters of the whole "Complete with AI" briefing. `0` = unlimited. |
| `AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS` | `5` | Windmill runs per flow that an import from a standalone Windmill replays as dry runs of the new draft ("Compare with the last N Windmill runs"; at most 100). Their reads count in the import's total read budget. `0` = the comparison is off. |
| `AUTOMATION_IMPORT_WINDMILL_COMPARE_FLOWS` | `20` | Imported flows compared in one import; the rest say they were not compared. `0` = unlimited. |
| `WEBHOOK_UNTIMED_NONCE_RETENTION_DAYS` | `0` (keep) | Days the nonce of a signed webhook delivery without a timestamp is kept for replay protection. `0` keeps it for good, so that table only grows; ordinary nonces are swept after 24 hours either way. |
| `FIREBIRD_ALLOW_PRIVATE_HOSTS` | off | `1` allows a private or loopback Firebird host on `DEPLOYMENT_MODE=cloud`. Self-hosted allows them already. Link-local and cloud-metadata addresses are always refused. |
| `FIREBIRD_ALLOWED_HOSTS` | empty (any) | Comma-separated host names a Firebird connection may use. |
| `OFFICE_PACKAGE_MAX_ENTRIES` | `10000` | Files inside one office package (.docx) before a parser opens it. `0` = unlimited. |
| `OFFICE_PACKAGE_MAX_INFLATED_BYTES` | `268435456` (256 MB) | All parts of one office package together, unpacked. `0` = unlimited. |
| `OFFICE_PACKAGE_MAX_PART_BYTES` | `67108864` (64 MB) | One part of an office package, unpacked. `0` = unlimited. |
| `OUTBOUND_HTTP_TIMEOUT_MS` | `30000` (30 s) | How long an outbound HTTP call of the server (an integration, an OAuth token exchange, a sidecar such as the guard or search service) may take when the code sets no time-out of its own. Streams and downloads count only the wait for the answer, not the body. `0` = no time-out. |
| `LEGACY_MCP_TOKEN_MAX_AGE_DAYS` | `365` | MCP access tokens that carry no expiry of their own stop working this many days after they were created. `0` = no limit. |
| `CMS_REACT_SOURCE_MAX_BYTES` | `200000` | Largest source (bytes, UTF-8) of a website React component block the server compiles on save. A bigger source is stored with a compile error and the block renders nothing. `0` = unlimited. |

## Workflow components and internal addresses

A workflow component (the n8n webhook, YouTrack, AFAS, the e-mail sender and the others) runs
as a process in the server's network and connects where its inputs tell it to. By default a
component may not reach a private, loopback, link-local or cloud-metadata address. That is
checked twice:

- before the run, an input that is an `http(s)` URL on such a host is refused:
  `Input "<name>" points at a private or internal address, which a component may not call.`
- inside the component's process, every connection it opens is checked again, so an SMTP
  host, a host name that resolves to an internal address and a name that changes its answer
  after the first check are refused as well:
  `Refusing to connect to a private or internal address (<host>)`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `COMPONENT_ALLOW_PRIVATE_HOSTS` | empty (refuse) | Hosts a component may reach although they are private: a comma-separated list, each host written exactly as the component is given it (`n8n.lan,smtp.lan`; an address when the component is given an address). `1`, `true` or `*` allows every private address. |

Set it when your n8n, YouTrack or mail relay is on a private network. Two hosts need no
entry: the caller's own Nextcloud (which follows `NEXTCLOUD_ALLOW_PRIVATE_HOSTS`) and the
host of an outbound proxy set with `HTTP_PROXY` / `HTTPS_PROXY`.

:::warning Whole deployment, every user
The setting is not per organisation. With `1`, any signed-in user can make a component call
an internal address of your network. Prefer the list.
:::

The Compose files pass the variable through to the server; restart the server after a change.

## Switches that relax a safety default

Each of these turns a protection off for the whole deployment, not for one organisation or
one user. Leave them unset unless the row describes your situation.

A variable must reach the server process to count, and the Compose files pass through only
what is in the server's `environment:` list. That list has `NEXTCLOUD_ALLOW_PRIVATE_HOSTS`,
`COMPONENT_ALLOW_PRIVATE_HOSTS` and `FIREBIRD_ALLOW_PRIVATE_HOSTS`. It does not have
`KB_ALLOW_PRIVATE_HOSTS`, `N8N_ALLOW_INSECURE_TLS` or `LICENSE_ALLOW_BUNDLED_KEY`: for those,
add a line such as `- KB_ALLOW_PRIVATE_HOSTS=${KB_ALLOW_PRIVATE_HOSTS:-}` to the server service
in a Compose override file, next to the value in `.env`.

| Variable | Default | What it relaxes |
|----------|---------|-----------------|
| `NEXTCLOUD_ALLOW_PRIVATE_HOSTS` | empty (refuse) | Lets the server call a Nextcloud on a private or loopback address. A comma-separated list of hosts allows exactly those; `1` allows every private address, for every Nextcloud address anyone on the server enters. Cloud-metadata addresses stay refused. |
| `COMPONENT_ALLOW_PRIVATE_HOSTS` | empty (refuse) | Lets workflow components reach private addresses; see [above](#workflow-components-and-internal-addresses). |
| `KB_ALLOW_PRIVATE_HOSTS` | off | `1` lets knowledge-base web sources fetch private addresses, for an intranet wiki. Only the exact value `1` counts. Cloud-metadata addresses and non-http(s) schemes stay refused. |
| `FIREBIRD_ALLOW_PRIVATE_HOSTS` | off | `1` allows a private or loopback Firebird host on `DEPLOYMENT_MODE=cloud`; see [Inbound and integration limits](#inbound-and-integration-limits). |
| `N8N_ALLOW_INSECURE_TLS` | off | `1` stops certificate verification for `https` calls to n8n, for a self-signed or internal n8n. Only the exact value `1` counts, and it is read once at start-up. The n8n API key travels over that connection. |
| `LICENSE_ALLOW_BUNDLED_KEY` | off | `true` lets a production server verify licence keys against a development public key file; see [Connecting to the license server](../licensing/server-deploy.md). |

## Datatable storage limits

The storage envelope of datatables, per organisation (or per account, for personal tables). Each is an integer, has a generous default, and `0` means no limit. They keep one organisation from growing the shared database without bound; raise or remove them on a large server. A person who reaches one sees which limit it is and what to do: delete what they no longer need, or ask you to raise it.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATATABLE_MAX_TABLES_PER_SCOPE` | `200` | Tables people make: in Studio → Datatables, through an automation, an app, a form's answers or a linked Nextcloud table or spreadsheet. `0` = unlimited. |
| `DATATABLE_MAX_SHEET_TABLES_PER_SCOPE` | `2000` | Spreadsheet tabs in Documents. Each tab of a spreadsheet (one started in Documents, or a workbook opened in chat) keeps its cells in a table of its own; those count here, not on the table cap above. `0` = unlimited. |
| `DATATABLE_MAX_ROWS_PER_TABLE` | `100000` | Rows in one table. `0` = unlimited. |
| `DATATABLE_MAX_ROWS_PER_SCOPE` | `500000` | Rows across all tables, spreadsheet tabs included. `0` = unlimited. |
| `DATATABLE_MAX_MB_PER_SCOPE` | `256` | On-disk storage of all tables, spreadsheet tabs included, in MB. Once reached, no new rows, tables or spreadsheet tabs are added until something is deleted. `0` = unlimited. |
| `PROJECT_DOCUMENT_FOLDERS_MAX` | `500` | Folders in the Documents tab of one project. `0` = unlimited. |

The hourly datatable sweep (switched off with `DATATABLE_RETENTION_DISABLED`) also removes a spreadsheet tab's table that no document points at any more, a day after it was made: what is left when creating a spreadsheet or tab failed half-way. Tables people make, and the tabs of a deleted (archived) spreadsheet, are never removed by it.

## AI steps and automation concurrency

Limits for automations that call a model. Each is an integer, has a generous default, and `0` means no limit (the exception is `LLM_RATE_LIMIT_RETRIES`, where `0` means no retry). They protect the model provider's account and the server's memory, not the user: raise or remove them on a large installation. See [Reliable AI steps](../studio/ai-steps.md) for what they do from the builder's side.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_PROVIDER_RPM` | `600` | Requests per minute Bee Flow sends to one model connection (one provider URL with one key). A request over the limit waits until room frees up (the allowance refills steadily) instead of failing. `0` = unlimited. |
| `LLM_PROVIDER_TPM` | `2000000` | Estimated tokens per minute for one model connection, counted from the request size plus the room for the answer and corrected afterwards from the real usage. `0` = unlimited. |
| `LLM_RATE_LIMIT_RETRIES` | `4` | How many times a request is repeated after the provider answers "too many requests" or "overloaded", waiting as long as the provider asks. `0` = no retry: the first such answer fails the step. |
| `LLM_RATE_LIMIT_MAX_WAIT_MS` | `60000` | The longest single wait, in milliseconds, for a slot or a retry. A larger wait asked by the provider is cut to this. `0` = no cap. |
| `AUTOMATION_FOREACH_MAX_CONCURRENCY` | `4` | The most items an AI step without tools, or a data extraction step, runs at once when its "Run per item" list sets a concurrency. A step asking for more is held to this number. `0` = no cap beyond the number of items. |
| `AUTOMATION_AI_ENUM_MAX_VALUES` | `500` | The longest list of allowed values that one "Allowed values from a list" setting shows to the model. A longer list is not shown to the model at all (the server log says so); the answer is still checked against the whole list. `0` = unlimited. |
| `AUTOMATION_AI_CHECK_MAX_ERRORS` | `100` | The most problems collected while checking one AI answer. `0` = unlimited. |
| `AUTOMATION_AI_REPAIR_MAX_ERRORS` | `25` | The most failing places quoted back to the model in the single repair round. `0` = unlimited. |
| `AUTOMATION_AI_IMAGES_MAX` | `10` | The most images one AI step or data extraction step shows the model in one run (see [Images to AI](../features/automations.md#images-to-ai)). The images over the limit go as the text read from them. `0` = unlimited. |
| `AUTOMATION_AI_IMAGES_MAX_MB` | `20` | The most megabytes of images one AI step or data extraction step shows the model in one run, all images together. An image that does not fit goes as the text read from it. `0` = unlimited. |
| `COWORK_REVIEW_MAX_FOLLOWUPS` | `5` | How many times one piece of Cowork work may be continued after its owner answered a review the agent asked for ("To review" in Cowork). Each answer starts a follow-up run in the same conversation with the same tools; past this number the owner can still close the review, but not answer it with another follow-up. `0` = unlimited. |
| `COWORK_RUN_MAX_MINUTES` | `20` | How long one Cowork run may take, in minutes (1 to 240). When the limit passes, the model call in flight is cancelled, no further step starts, and the run closes as failed with that reason; a repeating item still moves on to its next moment. The clean-up that closes runs a stopped server left behind waits ten minutes longer than this limit, and never less than thirty minutes. |
| `COWORK_EVENT_MAX_PER_HOUR` | `30` | How many runs one Cowork item may start on events (after another cowork, a webhook call, a change in a table, a new file) in an hour. Past it, an event starts nothing and the skip is logged; 0 means no limit. |
| `COWORK_SANDBOX_MAX_CHILDREN` | `4` | How many scripts of Cowork plans may run at once on one server process. Each script runs in a child process of its own (with its own memory of up to 128 MB); the next one waits for a free place, and one that waits longer than 20 seconds fails its step with a message that the server is busy. At least 1. |
| `AGENT_WIZARD_SKILL_DRAFTS` | `5` | When an agent is made or refined with AI, the most new skills of one plan that get a structured draft (steps, rules, when to use it), each one extra model call. The new skills over the limit are created as plain skills with only their instructions (the server log says so). `0` = unlimited. |

## Per-user spend budgets

Requests per minute one signed-in user may make on the routes that spend money or minutes on every call. Each is an integer with a generous default, counted fleet-wide when Redis is there, and `0` means no limit. A user over the budget gets a `429` with `Retry-After`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DIRECT_CHAT_RPM` | `60` | Chat turns (each a model call). |
| `IMAGE_GEN_RPM` | `30` | Images generated from the chat. |
| `TRANSCRIPTION_UPLOAD_RPM` | `20` | Audio uploads for transcription. Checked before the file is read. |
| `NOTEBOOK_AI_RPM` | `30` | Notebook generations (summary, quiz, ai-fill). |
| `TEMPLATE_AI_RPM` | `20` | Template uploads, each of which starts the AI pipeline (context, knowledge base, parameters). |

These are a guard against bursts, per minute. How many images one person may make per hour, 24 hours, 7 days or 30 days is not an environment variable: an admin sets it per organisation, group and member, see [Image limits](../admin/users-and-groups.md#image-limits).

## Teams meeting notes

Optional; empty means the default. For the limits, `0` means unlimited (for the probe timeout: no
timeout). See [Teams meeting notes setup](../integrations/teams-meeting-notes.md) for what the
tests and organisation-wide import do.

| Variable | Default | Purpose |
|----------|---------|---------|
| `TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS` | `10` | Seconds between two runs of the same Teams test by one person (the app registration test, the member test and the organisation-wide import test each have their own interval). A run within the interval gets a `429`. `0` = unlimited. |
| `TEAMS_DIAGNOSTICS_PROBE_TIMEOUT_MS` | `15000` | How long one Microsoft request of a Teams test may take before the check says it could not be tested. `0` = no timeout. |
| `TEAMS_DIAGNOSTICS_MAX_MEMBERS` | `2000` | Members listed in an organisation's Teams member overview; the overview says when there are more. `0` = unlimited. |
| `TEAMS_APP_IMPORT_MAX_SELECTED_USERS` | `5000` | Members an organisation admin may select for organisation-wide Teams import. `0` = unlimited. |
| `TEAMS_APP_IMPORT` | `1` | `0` switches organisation-wide Teams import (application permissions) off for the whole server. Not a limit: any other value leaves it available. |
| `TEAMS_MAX_RECORDING_BYTES` | `6442450944` (6 GiB) | Largest Teams recording video Bee Flow downloads. A bigger one fails as `recording_too_large`. An unset, `0` or non-numeric value means the default; there is no unlimited setting. The extracted audio has its own fixed 500 MB cap. |
| `NEXTCLOUD_MAX_RECORDING_BYTES` | `2147483648` (2 GiB) | Largest Nextcloud (Talk) recording Bee Flow downloads for meeting notes. A video recording is kept whole so the meeting player shows the picture; only its extracted audio goes to the transcription engine, with its own fixed 500 MB cap. A bigger download fails as `recording_too_large`. `0` = unlimited. |
| `MEETING_IMPORT_MAX_CONCURRENT_PER_USER` | `3` | Manual meeting imports (Teams, Google Meet) one user runs at once on one server process; more gets a `429`. `0` = unlimited. |
| `MEETING_IMPORT_MAX_CONCURRENT_PER_ORG` | `10` | The same per organisation. `0` = unlimited. |
| `MEETING_IMPORT_AUTO_MAX_CONCURRENT` | `3` | Automatic meeting imports one queue (Teams, Google Meet) runs at once on one server process. A long meeting holds one of them while it is transcribed; the others keep importing. `0` = unlimited. |
| `WHISPER_AZURE_POLL_TIMEOUT_MS` | unset | How long Bee Flow waits for an Azure Whisper batch transcription, in milliseconds. Unset or `0`: 30 minutes for Azure's queue plus the length of the audio, six hours at most (a two-hour meeting waits up to 2.5 hours). A transcription that is not ready by then ends the import as `timeout`. The temporary copy of the recording that Azure downloads is deleted when the transcription ends, and by an hourly sweep once it is older than the longest wait plus an hour. |

## Redis

| Variable | Default | Purpose |
|----------|---------|---------|
| `REDIS_URL` | (none) | Read-through cache over the PG session store, e.g. `redis://redis:6379`. Optional — with it unset the server falls back to PG-only sessions, and a failed Redis connect degrades to the same rather than taking logins down. |

## Service-to-service (sidecars)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SERVICES_API_KEY` | (none) | Shared secret for calls to the bundled sidecars (guard-service, classify-service). The guard-service and classify-service require it: they enforce it on every request except `/health` and refuse to start without one (`./selfhost.sh` generates it). Set `SERVICES_ALLOW_OPEN=1` on them only to run open on a trusted network. Note it has **no** `GUARD_` prefix on that side. |
| `PII_SERVICE_URL` | (none — opt-in) | Guard-service base URL, e.g. `http://guard-service:8100`. Unset means PII detection is disabled entirely. |
| `PII_SERVICE_API_KEY` | falls back to `SERVICES_API_KEY` | Sent as `X-API-Key` to the guard; must match the guard's own `SERVICES_API_KEY`. |
| `GUARD_SERVICE_URL` | (none — opt-in) | Sidecar health probe for `/api/guard/health`; returns `not-configured` when unset. |
| `GUARD_MAX_BODY_BYTES` | `33554432` (32 MiB) | On the guard-service: the largest request body it reads, checked before the JSON is parsed (a `413` above it). Sized above `GUARD_PII_HARD_MAX_CHARS` with room for JSON escaping. `0` = no bound. |

## Observability

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. An unrecognised value falls back to `info`. Applies to the JSON logs (`LOG_FORMAT=json`, the default in production). |
| `OTEL_ENABLED` | off | Set to `true` (or set an endpoint) to start the OpenTelemetry SDK. Fully off by default — zero overhead. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` | (none) | Where traces and metrics go: directly to OpenObserve, or — recommended for production — to an in-cluster OTel collector so the app never holds the OpenObserve secret. |
| `OTEL_SERVICE_NAME` | `beeflow-server` | Service name in the exported telemetry. |
| `USAGE_PUSH_ENABLED` / `OPS_PUSH_ENABLED` | off | Optional pushes of per-org usage rollups and ops-metric snapshots to OpenObserve. `USAGE_HASH_SALT` is **required** when usage push is on — it pseudonymises user ids. |

Telemetry is exported off the request path (background batch export, bounded
queues, swallowed errors), so a down or slow OpenObserve never affects Bee
Flow's latency or availability. The full knob list — including export timeouts
and backfill behaviour — is in `server/.env.example`; see
[Reference → Telemetry](../reference/telemetry.md) for the current state.

## Webpage full-tier runtime (optional)

The full-tier preview for webpage projects runs each project in a throwaway Docker container. It is **off by default** and starts only when `WEBPAGE_FULL_RUNTIME_ENABLED=1` and the server can reach a Docker daemon.

The container image, `ghcr.io/bee-flow/webpage-runner`, is **built outside this repository**: this repo contains no Dockerfile for it. The server picks the image in this order:

| Variable | Default | Purpose |
|----------|---------|---------|
| `WEBPAGE_RUNNER_IMAGE` | unset | Image to run. Wins over everything else; set it to use your own build or a private mirror. |
| `WEBPAGE_RUNNER_REGISTRY_IMAGE` | `ghcr.io/bee-flow/webpage-runner:latest` | Image the server pulls when `WEBPAGE_RUNNER_IMAGE` is unset and no local `beeflow-webpage-runner:local` image exists. |

If the image can neither be found nor pulled (for example on an air-gapped host), the preview does not start: the API answers `503 full_tier_unavailable` and the server log says `webpage-runner image unavailable. Set WEBPAGE_RUNNER_IMAGE.` Pull or load the image on the host first, then set `WEBPAGE_RUNNER_IMAGE`.

## In-process CPU models

Three models run inside the server process when nothing else is configured for
their task: the `bge-reranker-base` cross-encoder (KB search and web search
reranking), the `multilingual-e5-small` embedder and `whisper-base`
(transcription). Loading one builds an ONNX session on the main thread, which
blocks the server for seconds on a small host, so the server warms them
`CPU_PIPELINES_PREWARM_DELAY_MS` (default 30000) after boot, one at a time,
and only a model that the current configuration routes to **and** that served
a request in the last `CPU_PIPELINES_PREWARM_DAYS` days (default 30). A model
that is not warmed loads on its first request, at the cost of one slow call.

| Variable | Values | Effect |
|---|---|---|
| `CPU_PIPELINES_PREWARM` | `auto` (default), `all`, `false` | `all` warms every model the configuration routes to, used or not; `false` warms none |
| `CPU_PIPELINES_PREWARM_DELAY_MS` | ms | wait after boot before the first warmup |
| `CPU_PIPELINES_PREWARM_DAYS` | days | how recent a model's last request must be |
| `LOCAL_WHISPER_PREWARM` | `false` | never warm Whisper, whatever the setting above |

An install with Azure (or any provider) embeddings, a Cohere reranker or
`cpu_reranker_enabled = false` in the admin never loads the matching CPU model
at boot; an install that never transcribes never loads Whisper.

## Sanctions lists

Optional; empty means the default. The server downloads the official public lists (EU, UN, Dutch
national terrorism list, OFAC SDN, UK Sanctions List) only while an organisation has the
[Sanctions lists](../integrations/sanctions-lists.md) integration switched on. A server without
internet access keeps its last copy and shows the error on the status page.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SANCTIONS_REFRESH_INTERVAL_HOURS` | `24` | Hours between two refreshes of a list (a list that is still empty is retried every hour). `0` = no automatic refresh (the platform admin's **Refresh now** still works). |
| `SANCTIONS_DOWNLOAD_TIMEOUT_MS` | `120000` | How long one list download may wait for the server's answer to start. |
| `SANCTIONS_MAX_DOWNLOAD_MB` | `200` | Largest list file accepted. A larger download is refused and the stored list is kept. `0` = no limit. |
| `SANCTIONS_PARSE_MEMORY_MB` | `1024` | Memory limit of the worker thread that parses one list. A parse that needs more stops, and the stored list is kept. `0` = no limit. |

## Everything else

OAuth client credentials, SMTP, licensing, retention windows, rate limits,
edition/module switches and the automation kill switches are documented where
they are set, in the example files linked above, as far as those files go (see
the note at the top of this page). Model-provider keys and integration API
keys entered in the admin UI are stored encrypted in the database, not in
`.env`.

The server also reads tunables that neither this page nor the example files
list yet (time-outs, batch sizes, limits of a single route), each with a
default in the code. From a checkout, `node scripts/env-inventory.mjs --list`
prints every variable the server reads, the default where the code states one,
the files that read it, and whether one of these documents mentions it.
