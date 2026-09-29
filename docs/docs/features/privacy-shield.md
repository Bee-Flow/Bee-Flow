---
title: Privacy shield
---

# Privacy shield

The Privacy Shield is the in-tenant filter that scans every prompt and tool result before it reaches the language model. It's available in **every tier**, including Community.

## Free and Enterprise

| | Community | Enterprise |
|---|:---:|:---:|
| Detection of all 21 categories, on your own server | ✅ | ✅ |
| **Block** a message that contains personal data | ✅ | ✅ |
| **Tokenize**: placeholders instead of real values, restored in the reply | — | ✅ |
| **Web search guard**: personal data filtered out of web search | — | ✅ |
| **Your own data**: your own words, formats and AI labels | — | ✅ |
| The **Guard** and **Tokenize** steps in automations (Untokenize is not gated) | — | ✅ |
| The **What happened** tab (where your data went) | — | ✅ |

The org-wide shield under every chat and every automation run works the same on both
tiers. What Enterprise adds is the reversible placeholders, the extra guards, and the
privacy steps an author places in an automation (`automation_privacy_steps`).

## Detected categories

Bee Flow detects **21 categories** of sensitive data. Detection runs against
outbound prompts (user → model) and inbound tool results (e.g. file contents
the agent fetched).

| Category | Examples |
|----------|----------|
| Person | "Alice Johnson", "Jan van der Berg" |
| Organization | "Bee Flow B.V.", "Acme Corp" |
| Address | "Keizersgracht 123, 1015 CJ Amsterdam" |
| DateOfBirth | `1985-03-12`, `12 maart 1985` |
| PhoneNumber | `0644137044`, `06-44137044`, `+31 6 44137044`, `(555) 123-4567` |
| Email | `alice@example.com` |
| URL | including credentialed URLs (`https://user:pass@host`) |
| IPAddress | `192.0.2.1`, `2001:db8::1` |
| IBAN | `NL91ABNA0417164300`, `NL91 ABNA 0417 1643 00`, and other EU countries |
| BankAccountNumber | domestic account numbers |
| CreditCardNumber | `4111 1111 1111 1111` |
| NationalIdentificationNumber | Dutch BSN, Belgian rijksregisternummer, German Steuer-ID, Spanish DNI, Italian codice fiscale, UK NINO |
| TaxIdentificationNumber | Dutch BTW / KVK / RSIN |
| USSocialSecurityNumber | US Social Security Numbers |
| PassportNumber | locale-aware |
| DriversLicenseNumber | locale-aware |
| LicensePlateNumber | NL, DE, BE, FR, ES, IT, UK formats |
| HealthInsuranceNumber | policy / insurer numbers |
| MedicalCondition | diagnoses and conditions |
| Medication | drug names |
| ApiKeyOrSecret | `sk-…`, `AKIA…`, `ghp_…`, long hex secrets |

Categories are enabled per organisation; the full list is available on every
tier, including Community.

## How detection works

Detection runs entirely **in your own tenant**, in the `guard-service`
container. Nothing is sent to a third-party detection API.

A **GLiNER** model (Apache-2.0, CPU-only) performs the detection. Because it
reads context rather than matching shapes, it distinguishes cases a pattern
cannot — `factuurnummer 0123456789` is not treated as a phone number, while a
bare `0644137044` is.

One detector is deliberately not the model: the **Dutch BSN** is validated by
its elfproef checksum. A nine-digit number with no surrounding context carries
no signal for a language model to read, whereas the checksum decides it
arithmetically. This applies to Dutch BSNs specifically — other countries'
national identification numbers are detected by the model like anything else.

A configurable **confidence threshold** (default 0.7) tunes how eagerly
detection fires. Each category is individually calibrated and the slider
shifts all the floors together: lower means broader detection and more false
positives, higher means fewer detections. Above roughly 0.85 many genuine
detections are filtered out — including structured ones, since a phone number
in a short message with little surrounding context can score around 0.5.

![Privacy Shield settings panel](../img/screenshots/features/privacy-shield-settings/)

## What happens on a detection

| Action | Behaviour |
|--------|-----------|
| **Block** (default) | The message is not sent; the user is told which categories were found. |
| **Tokenize** *(Enterprise)* | Each value is replaced with a placeholder such as `[email_1]` before the prompt leaves your tenant, and restored in the reply. The model never sees the real value. |

## If detection is unavailable

If the guard cannot be reached, or its model has not finished loading, the
scan result is marked *degraded*. The default policy is **fail closed** — the
message is blocked rather than sent unscanned. This is deliberate: in a
privacy product, silently forwarding unscanned content is worse than a visible
error. Self-hosters should allow for model load time on startup and run more
than one replica if a restart must not interrupt service.

Configure per-org in **Settings → Organisation → Privacy**, or per-agent in **Studio → Agents** (overrides the org default). The org-level config is stored in the `org_privacy_shield_<orgId>` record.

## Org-level config fields

| Field | Default | What it controls |
|-------|:-------:|-------------------|
| `enabled` | `true` | Master toggle. |
| `piiDetectionEnabled` | `true` | Run PII detection on prompts and tool results. |
| `piiDetectionCategories` | all 21 | Which categories are active. Empty means all. |
| `piiDetectionConfidenceThreshold` | `0.7` | Min confidence (0–1). |
| `piiDetectionAction` | `block` | `block` or `tokenize` (tokenize is Enterprise). |
| `piiFailureMode` | `fail_closed` | What to do when detection is unavailable. Server-side only — deliberately not exposed in the UI, because the safe value is the one you want. |
| `showRawPayload` | `false` | Emit tokenised prompt + token map as SSE events for transparency (debug). |
| `euModeEnabled` | `false` | GDPR-aware data handling (logs minimised). |
| `webSearchGuardEnabled` | `true` | Apply PII filter to web-search results before injection. Enterprise; a Community save forces it off. |
| `customDataTypes` | `[]` | Your own kinds of data (see [Your own data](#your-own-data)). Each one is switched on by its id in `piiDetectionCategories` and the two tool lists. |
| `customSensitiveTerms` | `[]` | The old list of your own words and patterns. Kept for one release as a copy of your own words and fixed formats; edit them under Your own data instead. |

## How redaction works

1. Detect — matches in the outbound payload.
2. Replace each match with a stable placeholder: `[email_1]`, `[iban_1]`, `[person_2]`, …
3. Store the placeholder ↔ original mapping in tenant memory only (`conversationTokenMaps` map, conversation-scoped).
4. Send the redacted payload to the model.
5. On the response, restore placeholders to original values **only on your screen**.

The model never sees the originals. The model provider's logs never contain the originals.

## Token map storage

| | Value |
|---|---|
| Scope | Per-conversation (in-memory `Map`) |
| Per-message | Tokens merged into the conversation's map |
| Token format | `[<category>_<index>]` — e.g. `[email_1]`, `[phone_2]` |
| Cap | 500 tokens per conversation (LRU eviction) |
| TTL | 5 minutes since last access (eviction is purely an LRU + TTL cache; the durable record is the redacted message in Postgres) |

The map lives in memory on the active server replica. With Redis configured, tokens migrate via Redis so that follow-up turns can hit a different replica and still resolve placeholders.

## Showing the user what was redacted

The chat UI shows a small **shield** indicator next to each message that contained redactions. Hover to see counts per category ("3 emails, 1 phone"). Click to expand a side pane showing the per-token mapping (admin-only by default; users can opt in via Settings → Privacy → Show my own redactions).

## Your own data

*Enterprise.* The built-in kinds cover names, addresses, bank details and so on.
Your organisation also has data of its own that is just as private: project
code names, customer or contract numbers, internal product names. You add
these under **Settings → Organisation → Privacy → Your own data**, and the
shield hides them the same way it hides an email address.

### Three ways to recognise something

| Way | Use it for | Example |
|-----|------------|---------|
| **A list of words** | A fixed set of names you can write down. By default only whole words match, and upper and lower case do not matter. | Falcon, Heron, Kestrel |
| **A fixed format** | Numbers and codes that always look the same. Give three to five real examples and Bee Flow works out the format; you can also write the pattern yourself. | `KL-12345` |
| **Recognised by AI** | Things that vary and cannot be listed, like new project code names. The detection service recognises them from a short description. Needs the detection service to be running. At most six per organisation. | "internal project code name" |

Lists of words and fixed formats run on the Bee Flow server itself, so they keep
working when the detection service is down.

### Placeholders and the three switches

Each type gets its own placeholder, taken from its name: "Project code names"
becomes `[project_code_1]`, `[project_code_2]` and so on. You can change it in
the first step.

A type has the same three switches as the built-in kinds:

- **Hide from AI**: the value is replaced by its placeholder before a message
  reaches the AI. On by default.
- **Outside tools**: the value is never sent to tools outside your organisation,
  such as web search or email. On by default.
- **Own server**: the value is never sent to tools on your own server. Off by
  default.

Your own types work everywhere the shield works: chats, attachments, the
knowledge base, memory, tool results and routines.

### Testing and tuning

The second step is a small test bench.

1. **Test sentences.** An assistant can write example sentences for you. It only
   sees the name, your one-sentence description, and made-up look-alikes of your
   examples (`KL-83920` instead of `KL-12345`). Your real examples never leave
   your server: Bee Flow puts them into the sentences after the assistant is done.
   Do not put real names or numbers in the description, because the assistant
   reads it. You can also write sentences yourself.
2. **Mark what should be hidden.** Select the text with the mouse, or use
   "Mark what should be hidden…" on a sentence and type the text. "Nothing
   should be hidden here" marks a sentence that must stay as it is.
3. **Test.** Each sentence then shows what was found, what was missed and what
   was hidden by mistake (a false alarm), and the summary reads, for example,
   "Finds 19 of 20 · 1 false alarm". Click a result to say whether it was right.
4. **Tune automatically.** With at least five marked sentences, Bee Flow tries
   other settings on the same sentences and keeps the best one. You see what
   changed in one line, and you can undo it.

"Try your own text" shows what one sentence would look like to the AI. Test
sentences are stored encrypted and only administrators can read them.

"Add to the list" puts the type on the list; press **Save** to switch it on.

### On a Community licence

Words and patterns added under the old "Always hide these" list were moved into
Your own data as types marked "From your old list". They keep being hidden. On a
Community licence you can see them and remove them, but adding or changing a
type needs Enterprise.

## Where your data went: how the location is determined

*Enterprise.* The **What happened** tab (Settings → Organisation → Privacy)
has a world map of every outgoing call that tools and routines made in the
period: connected apps, MCP servers, HTTP steps, web pages and so on. Calls to
AI models are not on it. Each destination is a pin, with a line from your own
server to it.

### The actual connection, not a guess

The location of a call is taken **at the moment of the call, from the
connection itself**: the IP address the data was sent to. Not a DNS lookup
afterwards, not a guess from the host name, and a reused connection counts
too. When one call reaches several hosts (a sign-in server and then the API),
each is recorded, and the call is judged by the one that was worst for your
data.

That IP address is then located **on your own server**, in a local IP
location database. By default that is DB-IP Lite (City and ASN editions,
CC BY 4.0), which comes with the server image. No address is ever sent to a
third party to be looked up. The map's footnote credits the database: "IP
geolocation by DB-IP".

A country on the map is where the receiving server stands, not who runs it. A
US company's Frankfurt region shows as Germany.

### Global networks

Many services sit behind a global network such as Cloudflare, Fastly, Akamai,
Amazon CloudFront, Google or Microsoft Front Door. Your data then goes to the
network's nearest **edge**, and the network carries it on to the service,
which you cannot see. The map shows these honestly:

- the pin is at the edge city, for example "via Cloudflare, Amsterdam", and the
  line is dashed;
- the tooltip says "Cloudflare reported its edge (AMS); the service behind it
  is not visible". The edge comes from the network's own response header, and
  is only accepted when the IP address really belongs to that network;
- these calls count neither as "stayed in Europe" nor as "left Europe". They
  get their own number under the score.

### Your own server, and places that are not known

Private addresses (your own network, the cluster's internal network) count as
**your own server**: they are drawn at the origin, not as a pin of their own.

A call whose location is not known is never placed at a guess. It is listed
under **No known location**, with the reason:

| Reason | What it means |
|--------|---------------|
| No connection was seen | The call made no connection the server could observe. |
| The tool runs as a separate program | For example an MCP server started as its own process. Its connections are not visible. |
| Sent through a proxy | The server only sees the proxy, not what is behind it. |
| The location database is missing | The IP location database is not installed on this server. |
| Old record | Recorded before this version, when locations were not measured exactly. |

### The score

**Stayed in Europe** (inside the EEA, plus Switzerland and the UK) is scored
over the calls whose location is known: your own server, inside Europe, or
outside it. A call that sent personal data outside Europe counts double.
Calls through a global network and calls with no known location are left out
of the score and shown as their own numbers.

### Using the map

- The first view zooms to your traffic: all of it, including the whole curve
  of every line. Traffic that stays in Europe starts on Europe.
- Drag to move the map. Hold **Ctrl** (or **⌘**) and scroll to zoom, or
  double-click. The buttons zoom in and out, fit the traffic again, or show
  the whole world.
- Point at a pin, a line or a row in the list for where the data went, who
  runs the service, how many calls (and how many with personal data), the last
  contact, and **how we know**.
- Click a pin, a line or a row to filter the whole tab on that destination.
  Escape clears the filter.
- The tab refreshes every 30 seconds while it is open.

The origin of the lines is set by the administrator with
`BEEFLOW_SERVER_LOCATION` (see
[Environment variables](../self-hosting/env.md#where-your-data-went-egress-map)).
Without it, the map shows the pins but draws no lines.

## Limits and caveats

- Detection is ML-based, not perfect. Context can slip through (e.g. `our customer Jane lives at...` may not always tag the address depending on confidence). Because detection is context-driven, a value written with no surrounding clue — a bare nine-digit number, an identifier in a table cell — is harder to catch than the same value in a sentence.
- Detection adds model-inference latency per turn, growing with message length. Large document scans are correspondingly slower.
- Detection runs on the **server**, not the connector — so for Nextcloud users, redaction happens after the connector forwards the prompt.

## Where to next

- [Audit & compliance](../admin/audit-and-compliance.md) — guardrail event log + GDPR export tools.
- [Privacy & data flow](../connector/privacy.md) — what's sent at the connector hop.
