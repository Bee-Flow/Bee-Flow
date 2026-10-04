---
title: Environment variables
---

# Environment variables

Every variable the Bee Flow server reads, grouped by area. Defaults are shown where they exist; **bold** vars are required for that area to work.

The full list also lives in [`.env.example`](https://github.com/Bee-Flow/beeflow/blob/main/.env.example) in the server repo.

## Core / runtime

| Variable | Default | Purpose |
|----------|---------|---------|
| **`PUBLIC_URL`** | `http://localhost:3101` | The public URL users hit. Used for OAuth redirect, email links. |
| **`JWT_SECRET`** | — | 64+ char random string. Signs session JWTs. |
| `PORT` | `3101` | HTTP port the server listens on. |
| `LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error`. |
| `NODE_ENV` | `production` | Standard Node convention. |
| `TIMEZONE` | `UTC` | Default timezone for cron schedules and date display. |
| `BEEFLOW_DATA_DIR` | `/data` | Directory for any small on-disk state (rare; most state is in Postgres). |

### Sessions

| Variable | Default | Purpose |
|----------|---------|---------|
| **`SESSION_SECRET`** | — | 32+ char random string. Signs the session cookie, and derives keys for a few feature-scoped vaults. The server refuses to start without it. |
| `SESSION_MAX_AGE_DAYS` | `30` | Session lifetime in days; fractions allowed (`0.5` = 12 hours), capped at 365. An unparseable or non-positive value falls back to 30 with a warning — it never becomes "no expiry". |
| `SESSION_ROLLING` | `false` | `true` restarts the clock on each request, making the lifetime an **inactivity** timeout rather than a fixed window from sign-in. Only the exact string `true` enables it. |
| `COOKIE_SECURE` | on in production | Send the cookie over HTTPS only. |
| `COOKIE_SAMESITE` | `lax` | `lax` / `strict` / `none`. |
| `COOKIE_NAME` | `connect.sid` | Session cookie name. |
| `COOKIE_DOMAIN` | — | Set when the SPA and API are on different subdomains. |

Note for anyone writing an ISO 27001 access-control policy: the default is a
**fixed 30-day window from sign-in**, not an inactivity timeout. Set
`SESSION_ROLLING=true` if your policy describes inactivity, which most do.

### Log retention

| Variable | Default | Purpose |
|----------|---------|---------|
| `MONITORING_LOG_RETENTION_DAYS` | `400` | Window for `integration_activity_log` and `guardrail_events`. `0` disables it. Values 1–180 are raised to 181 — the AI Act Art. 26(6) check needs a ≥180-day observed span. |
| `ACCESS_AUDIT_RETENTION_DAYS` | *off* | Window for `access_audit_log` — the sign-in and access-control trail. **Off by default**: these rows are ISO A.8.15 evidence and deleting them cannot be undone, so an upgrade never starts purging on its own. Values below 365 are raised to 365; an unreadable value keeps everything. |

Leaving `ACCESS_AUDIT_RETENTION_DAYS` unset keeps IP addresses indefinitely — the
safe direction for evidence, the wrong one for GDPR minimisation. Set it to the
window your retention policy states.

The server's JSON body limit is **20 MB** and is **not** settable from the environment — it
is a literal in `server/index.js`. Studio uploads are capped before that, at 20 files of
20 MB each, and oversized files are named and refused in the browser rather than 413'd.

## Database

| Variable | Default | Purpose |
|----------|---------|---------|
| **`DB_HOST`** | `postgres` | Postgres host. |
| **`DB_PORT`** | `5432` | Postgres port. |
| **`DB_NAME`** | `beeflow_core` | Primary database name. The Compose setup also creates `beeflow_tasks` and `monitoring_db` on the same instance — see [Docker Compose → Three databases](docker-compose.md#three-databases-not-one). |
| `DATABASE_URL` | derived from `DB_*` | Override for the productivity-tasks DB. Default points at `beeflow_tasks`. |
| `MONITORING_DATABASE_URL` | derived from `DB_*` | Override for the monitoring DB. Default points at `monitoring_db`. |
| **`DB_USER`** | `beeflow` | Database user. |
| **`DB_PASSWORD`** | — | Database password. |
| `DB_SSL` | `false` | `true` to require TLS. Use for managed Postgres. |
| `DB_POOL_MAX` | `10` | Max connections from each server replica. |
| `DB_POOL_IDLE_TIMEOUT_MS` | `30000` | Close idle connections after this many ms. |

## Redis

| Variable | Default | Purpose |
|----------|---------|---------|
| `REDIS_URL` | (none) | E.g. `redis://redis:6379`. Required for >1 server replica. |
| `REDIS_TLS` | `false` | Set to `true` for `rediss://` connections. |
| `REDIS_KEY_PREFIX` | `bf:` | Prefix to namespace keys. Useful when sharing a Redis instance. |

## Model providers

Set **at least one**. Agents pick whichever is configured for their model.

| Variable | Provider | Notes |
|----------|----------|-------|
| `ANTHROPIC_API_KEY` | Anthropic Claude | Recommended default. |
| `ANTHROPIC_BASE_URL` | (override) | For self-hosted Claude proxy. |
| `OPENAI_API_KEY` | OpenAI | GPT-4.x, GPT-5. |
| `OPENAI_BASE_URL` | (override) | OpenAI-compatible endpoints (LiteLLM, vLLM, etc.). |
| `MISTRAL_API_KEY` | Mistral | Hosted Mistral. |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI | E.g. `https://my-aoai.openai.azure.com`. |
| `AZURE_OPENAI_KEY` | Azure OpenAI | API key. |
| `AZURE_OPENAI_DEPLOYMENT_GPT4` | (deployment name) | Maps the GPT-4 model alias to your deployment. |
| `AZURE_OPENAI_DEPLOYMENT_EMBED` | (deployment name) | For Azure-hosted embeddings. |
| `VOXTRAL_API_KEY` | Voxtral | Voice (STT + TTS). |
| `ELEVENLABS_API_KEY` | ElevenLabs | TTS, music, sound effects. |
| `DEEPGRAM_API_KEY` | Deepgram | Alternative STT provider. |
| `MISTRAL_TRANSCRIPTION_KEY` | Mistral | Transcription pipeline. |
| `WHISPERX_URL` | WhisperX (self-hosted) | Your own `whisperx-service` endpoint — used by meeting-notes transcription (Nextcloud Talk + Google Meet). No hosted default: leave it unset and Meet/Talk imports fail rather than sending audio elsewhere. Can also be set in Admin → Integrations → Transcription. |
| `PYANNOTE_API_KEY` | pyannoteAI | Premium diarization + speaker-attributed transcription in one call. Normally set in Admin → Integrations → Transcription (encrypted in the DB); the env var wins when both are present. |

### Self-hosted runtimes

Open-weight models running on your own hardware. Any URL set here is registered as a
provider at start-up, so its models are immediately selectable under
**Admin → AI → Chat Models** — see [Local models](../admin/local-models.md) for the
full guide. A provider created from an environment variable is recreated on every
restart; remove the variable to disconnect it permanently.

| Variable | Runtime | Example |
|----------|---------|---------|
| `OLLAMA_URL` | Ollama | `http://ollama:11434` |
| `VLLM_URL` | vLLM | `http://gpu-box:8000/v1` |
| `LLAMACPP_URL` | llama.cpp (`llama-server`) | `http://gpu-box:8080/v1` |
| `LMSTUDIO_URL` | LM Studio | `http://host.docker.internal:1234/v1` |
| `SGLANG_URL` | SGLang | `http://gpu-box:30000/v1` |
| `LOCAL_LLM_URL` | Any other OpenAI-compatible endpoint | `http://localhost:8000/v1` |
| `LOCAL_LLM_TYPE` | Adapter for `LOCAL_LLM_URL` — `lmstudio`, `sglang`, `localai`, `tgi`, `jan`, `koboldcpp`, `openai-compatible` (default) | `localai` |
| `LOCAL_LLM_API_KEY` | Key for `LOCAL_LLM_URL`, if the server was started with one | — |

Tuning for the bundled Ollama container (compose profile `local-llm`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_KEEP_ALIVE` | `15m` | How long a model stays resident between turns. Reloading weights per request dominates latency on local hardware. |
| `OLLAMA_MAX_LOADED_MODELS` | `2` | Models held in memory at once. |
| `OLLAMA_CONTEXT_LENGTH` | `8192` | Default context window. Raise it if long-context answers get cut off. |
| `OLLAMA_PORT` | `11434` | Host port mapping. Bound to `127.0.0.1` — these runtimes have no authentication. |

### pyannoteAI tuning (optional)

Only relevant when `transcription_provider` is `pyannote`. Every one of these has a working default — set them only to change behaviour deliberately.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PYANNOTE_API_URL` | `https://api.pyannote.ai/v1` | Override the API base (proxy / testing). |
| `PYANNOTE_POLL_INTERVAL_MS` | `5000` | How often a running job is polled. |
| `PYANNOTE_POLL_TIMEOUT_MS` | duration-scaled, 15 min – 2 h | Hard ceiling for a transcription job. |
| `PYANNOTE_VOICEPRINT_POLL_TIMEOUT_MS` | `120000` | Ceiling for an enrollment job (a ≤30s clip needs far less than a meeting). |
| `VOICEPRINT_MIN_SECONDS` | `12` | Shortest clip accepted for a voice profile. |
| `VOICEPRINT_TARGET_SECONDS` | `25` | What the enrollment progress bar aims at. |
| `VOICEPRINT_MAX_SECONDS` | `28` | Hard auto-stop, two seconds under pyannoteAI's 30-second limit. |
| `PYANNOTE_IDENTIFY_MIN_CONFIDENCE` | `60` | Confidence needed before a voice match becomes a name. Below it, the person is only offered to the AI as a candidate. |
| `PYANNOTE_IDENTIFY_WEAK_CONFIDENCE` | `35` | Below this a match is discarded entirely. |
| `PYANNOTE_IDENTIFY_MIN_SHARE` | `0.60` | Fraction of a speaker's own speaking time that must fall inside the matched person's turns. This is what refuses a speaker the diarizer merged from two people. |
| `PYANNOTE_IDENTIFY_MIN_SECONDS` | `8` | Never name a short diarization fragment. |
| `PYANNOTE_IDENTIFY_AMBIGUITY_MARGIN` | `0.10` | How far the winner must beat the runner-up. |

Raising the confidence and share thresholds yields fewer names but makes a wrong one less likely; lowering them does the reverse. Prefer erring high — an unnamed speaker shows as "Speaker 2", whereas a wrong name attributes someone's words to a named colleague.

## Web search

The web-search provider is picked in **Admin → Integrations → Zoeken**. API keys live in the admin DB (encrypted), **not** in `.env`. Set the keys in the admin UI:

| Provider | Where to set |
|---|---|
| Self-hosted Agent Search + Serper | Admin → Integrations → Zoeken (Serper key) + `SEARCH_SERVICE_URL` env var below |
| Cloud-only (Serper + provider APIs) | Admin → Integrations → Zoeken (Serper key only) |
| Azure Bing Web Search | Admin → Integrations → Zoeken (Bing key + market) |

See [Web search integration](../integrations/web-search.md) for the full setup.

## Privacy Shield

PII detection runs in the **guard-service** sidecar (`--profile guard`), which
hosts a GLiNER model on CPU. If the guard is not configured, PII detection is
off — the server fails open rather than blocking.

### Server-side (points the server at the guard)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PII_SERVICE_URL` | (none — opt-in) | Guard-service base URL, e.g. `http://guard-service:8100`. Unset ⇒ detection disabled entirely (fail-open). Overridden by the `pii_guard_url` config value if set in the admin UI. |
| `PII_SERVICE_API_KEY` | (none) | Sent as `X-API-Key`. Must match the guard's `SERVICES_API_KEY`. |
| `GUARD_SERVICE_URL` | (none — opt-in) | Sidecar health probe for `/api/guard/health`. Returns `not-configured` when unset. |
| `AZURE_CONTENT_SAFETY_ENDPOINT` | (none) | Azure Content Safety for moderation. The default moderation provider when configured. |
| `AZURE_CONTENT_SAFETY_KEY` | (none) | Azure Content Safety key. |

### guard-service (the detector itself)

All prefixed `GUARD_`. Defaults are sensible; you normally set none of them.

| Variable | Default | Purpose |
|----------|---------|---------|
| `GUARD_PII_ENABLED` | `true` | `false` skips model loading entirely — the service starts but detects nothing. |
| `GUARD_PII_MODEL` | `E3-JSI/gliner-multi-pii-domains-v1` | Model id. Must match the ONNX graph baked into the image. |
| `GUARD_PII_USE_ONNX` | `true` | `false` forces the fp32 PyTorch weights: same recall, roughly 30× slower. |
| `GUARD_PII_ONNX_DIR` / `GUARD_PII_ONNX_FILE` | `/opt/gliner-onnx` / `model.onnx` | Where the baked graph lives. |
| `GUARD_PII_MAX_CONCURRENCY` | `2` | Concurrent inferences per pod. Each uses all allocated cores, so raising this oversubscribes rather than speeding things up. |
| `GUARD_PII_MAX_CHARS` | `1000000` | Above this, only a bounded prefix is scanned and the result is flagged `degraded` with coverage info. |
| `GUARD_PII_HARD_MAX_CHARS` | `4000000` | Above this a request is refused outright. |
| `GUARD_PII_WARM_INFERENCE` | `true` | Run a priming inference at startup so the first real request doesn't pay ONNX arena growth. |
| `GUARD_PII_REGEX_TIER` | `on` | **Detection tier — see below.** |
| `GUARD_PII_DEGRADE_ON_PARTIAL_GROUP_FAILURE` | `true` | Treat a partial model failure as `degraded`. `false` accepts an incomplete result instead — fewer blocked messages, at the cost of silent under-detection. |
| `SERVICES_API_KEY` | (none) | Shared secret; note **no** `GUARD_` prefix. Required on every request except `/health` once set. |

### `GUARD_PII_REGEX_TIER` — detection tier

Detection is moving from a two-tier design (regex + GLiNER) to GLiNER alone.
This variable controls which tier runs, so the change is reversible per
environment without rebuilding an image.

| Value | Behaviour |
|---|---|
| `on` *(default)* | Both tiers. Deterministic patterns handle emails/IBANs/etc., GLiNER handles names and fuzzy categories. |
| `shadow` | Both tiers run and the **union** is returned, so user-visible behaviour is identical to `on`, and a per-tier **category count** is logged (`pii.tier_diff`) — how many spans each tier found, per category. Use it to see whether `off` would detect *less* on your own traffic before switching. Note this is the most expensive mode: it pays for both tiers on every request, so run it for a bounded period rather than leaving it on. |
| `off` | The model is the only detector. |

:::warning Rolling back
If detection behaviour changes in a way you did not expect after an upgrade,
set `GUARD_PII_REGEX_TIER=on` in your `.env` and run
`docker compose up -d guard-service`. This is the supported rollback and takes
effect on restart — no image change required.
:::

One detector is deliberately **not** GLiNER: the Dutch BSN is validated by its
elfproef checksum. An unanchored nine-digit number carries no linguistic signal
for a model to read, whereas the checksum decides it arithmetically. This
applies to Dutch BSNs only — Belgian, German, Spanish, Italian and UK national
identification numbers are detected by the model like any other category.

:::note Cold start
The guard loads a ~1.2 GB model at startup and reports `503` on `/ready` until
it is loaded. Because PII failures **fail closed by default**, chat is blocked
during that window. Allow for it in your health-check `start_period`, and run
more than one replica if you cannot tolerate a restart interrupting service.
:::

### Where your data went (egress map)

The Privacy Shield's **What happened** tab locates every outgoing tool call by
the IP address it connected to, on this server, in a local IP location
database (see [Privacy shield](../features/privacy-shield.md#where-your-data-went-how-the-location-is-determined)).
Nothing is looked up at a third party.

| Variable | Default | Purpose |
|----------|---------|---------|
| `BEEFLOW_SERVER_LOCATION` | (none) | Where this server stands on the map: the start of every line. An ISO country code (`NL`; the capital is the reference point) or `lat,lon[,label]` (`52.37,4.90,Amsterdam DC`). There is deliberately no default, because a server cannot know its own location without asking someone else. Unset: the map shows the destinations without lines, with a hint for the admin. |
| `GEO_DB_DIR` | (none) | A directory with the IP location databases, found by name: `*city*.mmdb` and `*asn*.mmdb`. Put a commercial GeoIP2 or DB-IP City + ASN database here to use it instead of the bundled DB-IP Lite. When set and it holds a file, it wins outright. |
| `GEO_DB_AUTO_UPDATE` | off | `monthly`: once a day, check whether the loaded database is from an earlier month, and if so download the new DB-IP Lite edition into `/app/data/geo` (or `GEO_DB_DIR`) and reload it. This download is the only outbound request the feature makes, and only when you switch it on. |

Without `GEO_DB_DIR`, the server uses the newest of: the data volume
(`/app/data/geo`, where the monthly update writes), the database baked into the
image at build time (`/app/geo`), and in a development checkout
`server/data/geo` (`cd server && npm run geo:fetch`). With no database at all,
destinations are listed as "No known location: the location database is
missing" rather than placed at a guess.

The bundled DB-IP Lite databases are licensed CC BY 4.0; the map credits them
with "IP geolocation by DB-IP".

## Search service (KB)

The KB pipeline can run entirely **in-process** (chunking + pgvector + RRF + cross-encoder rerank) — no GPU service required. Pick **Local** under Admin → AI Configuratie → Limits & Self-host. The remote search-service is opt-in via `SEARCH_SERVICE_URL`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SEARCH_SERVICE_URL` | (none — opt-in) | External GPU-backed search-service endpoint. When set, KB ingestion / search routes to it for users who pick `kb_provider = remote` in admin. Leave empty for fully local KB. |
| `RERANKER_URL` | (none — opt-in) | vLLM cross-encoder sidecar. Used as a tier between Azure Cohere and the in-process CPU reranker. Most self-hosted deployments don't need it. |
| `EMBED_API_URL` | (none — legacy) | Self-hosted GPU embedding service (BGE-M3). Memory store falls back to it only when no provider and no CPU embedder are available. |

## Embeddings

Global embedding model is picked in **Admin → AI Configuratie → Embeddings**. Used for KB ingestion, KB query, memory store, and as the default embed for web-search inference. The Web Search Inference tab can override per-feature.

The CPU fallback (`@huggingface/transformers` + `Xenova/multilingual-e5-small`, MIT, 384-dim) loads automatically when no provider is configured. No env var to set.

## Reranking

| Method | How |
|---|---|
| Azure Cohere reranker | Admin → AI Configuratie → API Sleutels → Azure Cohere Reranker |
| CPU cross-encoder | Admin → AI Configuratie → Limits & Self-host → toggle `cpu_reranker_enabled`. Uses `Xenova/bge-reranker-base` (MIT, ~280 MB), loaded in-process |
| Local GPU vLLM sidecar | Set `RERANKER_URL` env var. Skipped when CPU reranker is enabled. |
| LLM-as-rerank | Admin → AI Configuratie → Web Search Inference → method = "Provider model" + pick a chat model |

## OAuth providers

For each provider you enable, register an OAuth app with redirect URI `https://<your-host>/auth/<provider>/callback`.

| Variable | Provider | Purpose |
|----------|----------|---------|
| `OAUTH_GOOGLE_CLIENT_ID` | Google | Gmail / Calendar / Drive / Docs / Keep / Contacts / Groups |
| `OAUTH_GOOGLE_CLIENT_SECRET` | Google | |
| `OAUTH_MICROSOFT_CLIENT_ID` | Microsoft | Outlook / MS Calendar / Contacts / OneDrive |
| `OAUTH_MICROSOFT_CLIENT_SECRET` | Microsoft | |
| `OAUTH_MICROSOFT_TENANT` | Microsoft | `common` (multi-tenant) or your tenant ID |
| `OAUTH_GITHUB_CLIENT_ID` | GitHub | GitHub tools |
| `OAUTH_GITHUB_CLIENT_SECRET` | GitHub | |
| `OAUTH_NEXTCLOUD_CLIENT_ID` | Nextcloud | Standalone NC OAuth (when not using the connector) |
| `OAUTH_NEXTCLOUD_CLIENT_SECRET` | Nextcloud | |
| `OAUTH_NEXTCLOUD_BASE_URL` | Nextcloud | E.g. `https://nc.example.com` |
| `OAUTH_LINKEDIN_CLIENT_ID` | LinkedIn | LinkedIn read-only |
| `OAUTH_LINKEDIN_CLIENT_SECRET` | LinkedIn | |

## API-key integrations

| Variable | Integration |
|----------|-------------|
| `YOUTRACK_BASE_URL` | YouTrack — instance URL |
| `YOUTRACK_API_TOKEN` | YouTrack |
| `SIGNREQUEST_API_KEY` | SignRequest |
| `FIREFLIES_API_KEY` | Fireflies |
| `GAMMA_API_KEY` | Gamma |

## License

| Variable | Default | Purpose |
|----------|---------|---------|
| `BEEFLOW_LICENSE_KEY` | (empty) | JWT licence. Empty = Community tier. |
| `BEEFLOW_LICENSE_PUBLIC_KEY_PATH` | `license/bundled-public-key.pem` | Override only for testing. |
| `LICENSE_REFRESH_URL` | _(empty — refresh is opt-in)_ | Where Pro+ keys check for revocation. Unset means no pings at all; the JWT `exp`/signature stays authoritative either way. |
| `BEEFLOW_LICENSE_REFRESH_INTERVAL_HOURS` | `24` | How often to re-check. |

## Nextcloud connector pairing

| Variable | Default | Purpose |
|----------|---------|---------|
| `NC_CONNECTOR_HMAC_SECRET` | (auto-generated per tenant) | Shared secret for the `/nc/*` HMAC reverse proxy. Stored in DB; you usually don't set this manually. |
| `NC_CONNECTOR_BOOTSTRAP_TOKEN_TTL` | `300` | Seconds the bootstrap handshake token is valid. |

## Observability

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOG_LEVEL` | `info` | See above. |
| `AUDIT_LOG_RETENTION_DAYS` | `90` | How long guardrail / audit events stay in Postgres. |
| `SENTRY_DSN` | (none) | Sentry error reporting (if a Sentry SDK is wired in your fork). |

A global Prometheus `/metrics` endpoint and OpenTelemetry exporter (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `METRICS_ENABLED`, `METRICS_BASIC_AUTH`) are on the roadmap but **not wired today**. See [Reference → Telemetry](../reference/telemetry.md) for the current state.

## Feature flags

Most feature gating in Bee Flow is **licence-driven**, not env-driven. The server enforces premium features via `requireLicenseFeature(name)` middleware against the active org's tier (see [Licensing → Tiers](../licensing/tiers.md)).

A handful of features can additionally be toggled per-server via env:

| Variable | Default | Purpose |
|----------|---------|---------|
| `ENABLE_TASKS` | `true` | Productivity tasks/projects routes (`/api/projects`, `/api/reminders`). |
| `ENABLE_MONITORING` | `true` | Monitoring DB writes for the analytics dashboards. |
| `ENABLE_MEETING_NOTES` | `true` | Meeting-notes UI surface (still requires the `meeting_notes` licence feature to use). |
| `ENABLE_TEMPLATES` | `true` | Template gallery in Studio. |

Setting any of these to `false` hides the corresponding UI surface even on tiers that would otherwise allow it. Use case: test installs, compliance lockdowns. Other "feature flag"-looking vars (e.g. `FEATURE_NOTEBOOKS_ENABLED`, `FEATURE_SKILLS_ENABLED`) are reserved for future use and ignored today.

## Automation kill switches

Three switches that turn an automation-runner feature off for the whole server without touching any data or any organisation's own settings. They exist for an incident, not for configuration — the per-organisation and per-step settings are where these features are meant to be turned on and off.

All three share one grammar: **`1` / `true` / `on` / `yes` switch the feature OFF.** Anything else — including the literal `0` and `false` — leaves it running, so `…_DISABLED=0` means what it looks like it means.

| Variable | Default | Purpose |
|----------|---------|---------|
| `AUTOMATION_ASK_ONCE_DISABLED` | unset (feature on) | Switches off "ask this app only once per run". Steps stop reusing an answer within a run and ask the app every time — slower, never wrong. The durable tier below rides on top of this one, so it goes too. |
| `INTEGRATION_CACHE_DISABLED` | unset (feature on) | Switches off only the durable tier ("…and keep the answer for later runs"). Nothing new is stored and nothing already stored is served, whatever an organisation's admin has ticked. Per-run reuse keeps working. |
| `DATATABLE_RETENTION_DISABLED` | unset (feature on) | Stops the datatable row retention sweep, so rows past their table's retention window are no longer deleted. That window is a promise the product makes to a data subject and the Studio keeps showing it — switch it off only for as long as the incident lasts. |

## Learning Center videos (optional)

Some lessons can show a short captioned video. The videos are not in the repository or the images: install a media pack, or leave it out and every lesson plays without its video (nothing breaks, nothing is shown empty).

| Variable | Default | Purpose |
|----------|---------|---------|
| `LEARN_MEDIA_DIR` | `data/learn-media` next to the server code (`server/data/learn-media` in a checkout) | Server: directory served at `GET /learn-media/*` (only `.mp4`, `.vtt`, `.jpg`, `.webp`, `.json`; range requests; no listing). Mount a volume here in Docker so the pack survives an image upgrade. |
| `LEARN_MEDIA_PACK_URL` | (none) | Used by `npm run learn-media:fetch`: https URL (or local path) of a pack `.tar.gz`. The script checks every file's sha256 against the pack's `manifest.json` and only then swaps the new pack in. |
| `LEARN_MEDIA_PACK_SHA256` | (none) | Optional sha256 of the tarball itself, checked before it is unpacked. |
| `LEARN_MEDIA_BASE_URL` | (none) | Set on the **agent-hub** (frontend) container: an absolute `https://` URL browsers load the videos from instead of `/learn-media`, e.g. a CDN holding the same pack. Written into `/beeflow-runtime.js` at container start; anything that is not `https://` is ignored. The bundled nginx Content-Security-Policy only allows media from the app's own origin, so a CDN origin also has to be allowed (`media-src` and `connect-src`) in the policy your proxy sends. |

Install or update a pack from a checkout of the repository (point `LEARN_MEDIA_DIR` at the directory or volume the server reads):

```bash
LEARN_MEDIA_PACK_URL=https://example.com/learn-media-2026.10.tar.gz npm run learn-media:fetch
```

## Email (outbound)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SMTP_HOST` | (none) | SMTP server for invitations, password resets, notifications. |
| `SMTP_PORT` | `587` | |
| `SMTP_USER` | (none) | |
| `SMTP_PASS` | (none) | |
| `SMTP_FROM` | `noreply@beeflow.nl` | From address. |
| `SMTP_TLS` | `true` | STARTTLS. |

## Encryption-at-rest

| Variable | Default | Purpose |
|----------|---------|---------|
| `BEEFLOW_ENCRYPTION_KEY` | (none) | 32-byte key for encrypting OAuth tokens / API keys at rest in Postgres. |

## Bee Flow service URL (used by the Nextcloud connector)

| Variable | Default | Purpose |
|----------|---------|---------|
| `BEEFLOW_API_BASE_URL` | `https://server.beeflow.nl` | Set on the **connector** side via `occ app_api:app:setenv`. Override only for staging / on-prem. |
| `BEEFLOW_TENANT_KEY` | `auto` | Connector-side. Literal `auto` means provision automatically. |
