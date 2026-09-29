# Fact sheet — Organisation Privacy Shield (admin)

Area: `org-privacy-shield` · Audience: organisation admins · Status: **exists, fully built and shipping**

Source of truth read for this sheet (absolute paths):

- Frontend editor: `agent-hub/src/components/admin/security/guardrails/orgShield/` (`OrgShieldEditor.jsx`, `useOrgShield.js`, `orgShieldTabs.js`, `orgShieldPosture.js`, `tabs/*.jsx`, `parts/*.jsx`, `activity/*.jsx`)
- Mount in org settings: `agent-hub/src/components/admin/org/OrgInfoPanel.jsx` (line ~605) and `agent-hub/src/components/admin/org/orgInfo/orgInfoShared.jsx` (nav `SECTIONS`)
- Mount in the server-operator console: `agent-hub/src/components/admin/security/guardrails/GuardrailsHub.jsx` + `guardrailsRoutes.js`
- Catalogue of categories: `agent-hub/src/config/piiCategories.ts`
- Sensitivity presets: `agent-hub/src/components/privacy/PiiSensitivityPicker.jsx`
- API: `server/routes/orgPrivacyShield.js`, `privacyShieldStatus.js`, `dlpDecision.js`, `guardInstall.js`, `usage.js`, `usageMonitoringAuth.js`
- Runtime: `server/core/privacy/orgShield.js`, `server/core/dlp/*` (`dlpRunner.js`, `dlpPreflight.js`, `decisionQueue.js`, `allowTerms.js`, `customTerms.js`, `attachmentScanner.js`, `publicOrgs.js`), `server/core/privacy/piiDetection/*`
- Licence tiers: `server/license/tiers.js`
- Roles: `server/config/orgRoles.json`, `server/auth/permissions.js`

---

## 1. What the feature is for

The Privacy Shield is the organisation-wide policy that decides **what counts as personal data, what Bee Flow does with it before a message reaches an AI model, and what may cross the boundary out of the organisation** — and then shows the evidence that it happened.

It is one stored document per organisation (config key `org_privacy_shield_<orgId>`), edited on one page with five tabs. Four tabs are *policy*; the fifth (“What happened”) is *evidence*.

The detection itself runs on the customer's own infrastructure: a sidecar called the **PII Guard** (`guard-service`, FastAPI + a GLiNER model, CPU-only). Nothing is sent to a third party to be scanned. The one non-model detector is the Dutch **BSN**, validated by its elfproef checksum, because an unanchored nine-digit number carries no signal a model can read.

The shield sits **above** any per-agent guardrail: the org rules run first, and an agent may be stricter but never looser (`admin.shield_how_it_works_desc`: “These rules run first, before any rules set on an individual agent. An agent can be stricter, never looser — if the two disagree, the stricter one wins.”).

There is a separate **personal** shield for consumer accounts (`GET/PUT /api/org-privacy-shield/user/me`, panel in personal settings). It is *not* this area; an org member's personal shield is deliberately ignored while an org shield applies.

---

## 2. Screens, with the real labels

### 2.1 How to get there

**Primary route (the one to teach):**
`Settings` → `Organisation` (`settings.organisation` = “Organisation”) → **`Privacy Shield`** (`settings.privacy_shield`, red shield icon)
URL: `/app/settings/organisation/privacy`
Active tab rides in a **query param**, not a path segment: `/app/settings/organisation/privacy?tab=activity`.

Sibling items in the same Organisation menu (for orientation): `License & Usage`, `Sign-in Method`, **`Privacy Shield`**, `Encryption`, `Conversation Memory`, `Answer Reuse`, `Organisation Info`.

**Secondary route (server operators, Enterprise only):**
`Admin` → `Security` → `Guardrails` → tab `Organisations`
URL: `/app/admin/security/guardrails/organisations`
Page title `Guardrail configs` / subtitle “Reusable security configuration for organisations on this server.” Tabs there: `Presets`, `Patterns`, `Sensitive terms`, `PII profiles`, `DLP policies`, `Direct chat`, `Organisations` — but only `Patterns`, `Direct chat` and `Organisations` always exist; the others appear only when the server reports the matching capability endpoint (`/api/admin/guardrail-presets`, `-term-libraries`, `-pii-profiles`, `-dlp-policies`).

**Public demo (no login):** the same editor with fixtures for the fictional “Van Dael Assurantiën B.V.” at `/__demo__/privacy-shield` (registry id `privacy-shield`, `agent-hub/src/demo/registry.js`).

### 2.2 The editor shell

- Heading: **“Organization Privacy Shield”** (`admin.guard_org_title`)
- Subtitle: “Decide what personal data is hidden from the AI, and what happens when we find some. These rules apply to everyone in this organisation.”
- Tab strip (aria-label “Privacy Shield sections”): **`Overview` · `What we look for` · `What happens` · `Leaving your org` · `What happened`**
  - The last tab only renders on the **org-settings** mount (`showActivityTab`). The admin console mount deliberately omits it, because the monitoring endpoints scope by *session* org, not by the org picked in the console.
  - The middle three tabs are **disabled while the master switch is off**. `Overview` and `What happened` stay usable.
- Save bar (bottom right, on the four policy tabs only): **`Save All Changes`** / while saving **`Saving...`**; left of it “Unsaved changes” when dirty; on success toast “Saved successfully!”.
- Org picker `Organization` (a `<select>`) — **only** in the admin console mount and only when more than one org exists. Never on the settings page.
- Empty state (no orgs): “No organizations found. Create one in User Management first.”
- Load failure: red box **“Could not load these settings”** + “The current configuration could not be read, so nothing can be changed here safely. Saving is disabled — reload the page to try again.” (403 variant: “You do not have access to this organisation's privacy settings.”) — **no form is rendered and Save is hidden**.

### 2.3 Tab “Overview”

- Master toggle: **“Protect personal data”** / “Applies to every chat and every agent in this organisation.”
- When OFF: “Protection is off for this organisation. Messages go to the AI unchanged, and the other tabs stay inactive until you turn it on.”
- When ON: a read-only posture table, every row with a `Change` link that jumps to the owning tab. Row labels and their value wording:

| Row label | Value strings |
|---|---|
| `Kinds of data we look for` | “{n} of {total}” (total = 21). Amber hint when 0: “Protection is on, but nothing is ticked — so nothing will ever be found.” |
| `How strict` | `Low sensitivity` / `Balanced` / `High sensitivity` / “Custom ({pct}%)” |
| `When we find something` | “Replace with placeholders” or “Do not send the message”. Warn hint: “Your plan does not include placeholders, so these messages are stopped instead.” |
| `Show what was sent` | On / Off |
| `Also covers routines` | On / Off |
| `One last check before an outside AI` | Off / “On — ask the person” / “On — hide automatically” / “On — do not send” |
| `Held back from tools` | “outside tools {external}/{total}, own server {internal}/{total}” |
| `Web search protection` | On / Off — row only exists when a search provider is configured |
| `EU-hosted AI only` | On / Off — row only exists when EU chat models are configured |
| `Always hidden` | `None` or “{n} of your own” |
| `Never hidden` | `None` / “Well-known companies only” / “{n} of your own”; note hint “These are deliberately left visible to the AI.” |

- Footer note: **“How it works:”** + “These rules run first, before any rules set on an individual agent. An agent can be stricter, never looser — if the two disagree, the stricter one wins.”

### 2.4 Tab “What we look for” (detection)

- Intro card **“What we look for”**: “Before a message goes to the AI, Bee Flow reads it and looks for personal details — names, email addresses, phone numbers, home addresses, bank details, ID numbers, health information and more. Anything found is hidden from the AI. This happens on your own server; nothing is sent elsewhere to check it.”
- **“How strict should we be?”** — three cards:
  - `Low sensitivity` (threshold **0.85**) “Only hides what we are very sure about. Fewer interruptions, but some personal data can slip through.”
  - `Balanced` (**0.70**, badge **`Recommended`**) “The tested setting. Every kind of data is tuned and measured at this level. Start here.”
  - `High sensitivity` (**0.45**) “Hides as much as possible. Now and then it also hides ordinary text — a word that looks like a name, a number that looks like an ID.”
  - Link **“Advanced: set an exact percentage”** reveals a slider, range **0.10 – 1.00, step 0.05**, end labels “Find more (10%)” / “Find less (100%)”, helper “Every kind of data has its own tuned level; this moves them all together. Lower = find more.” A non-preset value shows a `Custom · NN%` chip.
  - Warnings fire only on **custom** values: ≥0.85 → “At this setting almost nothing is hidden. Short messages usually score between 60% and 85% …”; <0.45 → “This is below the High sensitivity level, so expect more ordinary words to be hidden as well.”
- **“Kinds of personal data”** — a 21-tile checkbox grid with `All` / `None` buttons, grouped: Personal, Contact, Financial, Identity, Digital, Organization, EU / Netherlands. The 21 labels: Person Names, Date of Birth, Phone Numbers, Email Addresses, Home and street addresses, Credit Card Numbers, Bank Account Numbers, IBAN Numbers, Social Security Numbers, Passport Numbers, Driver's License Numbers, IP Addresses, Web addresses, Passwords and access keys, Company names, National ID numbers (BSN and equivalents), Tax numbers (VAT / BTW / RSIN), Health Insurance Numbers, Medical Conditions, Medications, License Plates.
- Collapsed disclosure **“Your own words and exceptions”** (“Words to always hide, and words to never hide”), containing two panels:
  - **“Always hide these”** — “Anything of your own that the list above will not catch — project code names, contract number formats, internal system names. These are hidden on top of everything else.” Empty: “Nothing added yet.” Each row: `Name`, `What to look for` (placeholder `AURORA` or `KC-\d{4}`), segmented `Exact text` / `Pattern (advanced)`, toggle `Case sensitive`, trash button `Remove {label}`. Add box placeholder `Give it a name`, button `Add`. Duplicate name → “A term with that name already exists.” Server rejection → “Not saved — {error}” (the regex engine's own message).
  - **“Never hide these”** (amber card, the leak-by-design control) — “These are always left visible to the AI, in every category. They have to match exactly - allowing "Shell" does not allow "Shell Advies BV". Upper and lower case, spaces and punctuation do not matter.” Toggle **“Always allow well-known companies”** (“A built-in list of large companies, household brands and government bodies — Microsoft, PostNL, the Belastingdienst and the like…”), then chips. Add placeholder `Company, product or brand name`. Errors: “Enter a name or word.”, “Keep it under 120 characters.”, “That one is already on the list (upper and lower case, spaces and punctuation do not matter).”

### 2.5 Tab “What happens” (processing)

- **“What happens when we find personal data”** — two choice cards, both always visible:
  - **`Replace with placeholders`** — “Sensitive details are swapped for labels like [email_1] before the message goes to the AI. The AI never sees the real values, and Bee Flow puts them back in the answer.” Badge **`Enterprise`** + lock notice “Replacing with placeholders is an Enterprise feature. Upgrade at beeflow.nl” when unlicensed.
  - **`Do not send the message`** — “The message is stopped before it reaches the AI, and the person is asked to rewrite it without the personal data.”
  - Footnote: “Want people to decide for themselves each time? Turn on the extra check under “Leaving your org” and set it to Ask.”
  - Unlicensed-but-stored tokenize note: “Placeholders are saved for this organisation, but your plan does not include them — messages are stopped instead, until you upgrade or choose “Do not send the message”.”
- **“Let people see what was sent to the AI”** (only when the action is `Replace with placeholders`) — “Adds a section to the "How I got this answer" panel: the original message, the version that went to the AI, the AI's reply, and which placeholder stood for which value. Real values only appear on click, and anyone who can open the conversation can see them.”
- **“Also check knowledge bases when documents are added”** — “…Checking at the moment a document is added means personal data is replaced BEFORE it is stored… It cannot be undone afterwards: the stored text is the checked text.” (stored as `privacy_scan_knowledge_bases`, **default ON**)
- **“Also protect routines”** — “Routines run on their own, with nobody watching. Check their data and their AI steps the same way as chat. (Activity logging keeps running either way.)” (`applyToAutomations`, **default ON**)

### 2.6 Tab “Leaving your org” (outbound)

- **“One last check before an outside AI”** (`dlpEnabled`) — “Some AI models run outside your organisation. Just before a message goes to one of those, check it once more for personal data and handle it as chosen below.” When on, three mode cards: **`Ask`** (“Show what was found and let the person choose: hide it, send anyway, or cancel.”), **`Hide it`** (“Hide what was found and send the message. Nobody is interrupted.”), **`Do not send`** (“Stop the message and ask the person to take the personal data out first.”). Plus checkbox **“Always show this check, even when nothing is found”** — “Detection is never perfect. With this on, the person also gets a chance to mark something themselves on messages the check found nothing in.”
- **“Hold personal data back from tools”** — “Tools are things the AI can use for you — search the web, open a file, send an email. If one of these kinds of data is involved, refuse the tool and strip that data out of whatever comes back.” Two category grids, each with `All` / `None` and a green “{n} of {total} selected” count:
  - **“Tools that send data outside your organisation”** — Enterprise; otherwise a lock card “Holding data back from outside tools is an Enterprise feature.”
  - **“Tools that stay on your own server”** — available on every tier.
- **“Protect web searches”** (only rendered when a search provider is configured) — “Stop search terms that contain personal data from being sent to an outside search engine.” Enterprise; otherwise “Protecting web searches is an Enterprise feature.”
- **“No web search while a file is attached”** — “When someone attaches a document, do not let the AI search the web — so nothing from that document can end up in a search box.”
- **“Check connected-app traffic for personal data”** — “Every connected-app call is always recorded: which server, which country, when, and whether it worked. Turn this on to also check the content for personal data, so the reports can show what kind of data left your organisation.”
- **“Use only AI hosted in the EU”** (only when EU chat models are configured) — “Send chats only to the AI models hosted in the EU. Set those up under AI Config → Chat Models.”

### 2.7 Tab “What happened” (monitoring)

Header line: “What the shield caught, and where your data went.” plus a range control with presets **`7d` / `30d` / `90d`**, default **30d**.

- Unlicensed: lock card **“See what actually happened”** / “Activity reporting is part of the Enterprise plan.”
- Shield off: “The shield is off right now — nothing new is being checked. You are looking at past activity.”
- No data: “Nothing to show yet. Activity appears here once people start using the assistant.”
- Load failure: “Could not load activity. Reload the page to try again.”
- **At most one alert banner**, worst first, with CTA `Look at these`:
  1. “Personal data left Europe” — “{n} calls sent personal data to servers outside Europe in this period.”
  2. “A lot of your data is leaving Europe” — fires when sovereignty score < **40**.
  3. “The shield is catching a lot of personal data” — fires when personal-data catches > **10**.
- Four KPI cards: **`Times the shield stepped in`**, **`Personal data caught`**, **`Calls to outside services`**, **`Stayed in Europe`** (`NN/100`, tooltip: “Out of 100. Calls that stayed in Europe or on your own servers score full marks; personal data leaving Europe counts double against the score.”).
- Chart **“Activity over time”** with legend `Unsafe content`, `Personal data`, `Your custom rules`, `Checks before an outside AI`.
- Section **“What to look at”**, up to four top-5 cards: `Where it happened` (Direct chat / Agent / Routine / Notebook), `People with the most catches`, `What we caught most`, `Where data left Europe`.
- Fold **“The details”** with filter chips `Shield events` / `Data that left your org`:
  - Shield-events columns: `Time` · `Person` · `Where it happened` · `What we found` · `What we did`. Action words: Stopped, Hidden, Sent anyway, Placeholders, Search stopped, Noted only, Sent unchecked, Check failed.
  - Egress columns: `Time` · `Person` · `Where it happened` · `Service` · `Where it went` (`Your own server` for local calls).
  - Expanding a row shows: Kind, Direction, AI model, File, Conversation (shield) / Tool, Country, Operated by, Server address, Result, Took, Personal data (egress).
  - `Show more` loads +50, hard stop at **200** rows.
  - Non-category markers that can appear in “What we found”: “Protection was unavailable”, “Check ran out of time”, “File too large to fully check”, “Check ran reduced”, “Some placeholders were dropped”.

### 2.8 The end-user side (what learners will be asked about)

- **DLP review dialog** (mode `Ask`): title **“Check this before it goes to the AI”** (attachments: “Check this attachment before it goes to the AI”), subtitle “This prompt will be sent to **<provider>**” + badge `external`; “Tip: select text above to mark something the detector missed.”; checkbox “Remember my choice for this conversation”; buttons **`Block`**, **`Send anyway`**, **`Redact and send`** (or **`Send`** when nothing is marked). Legacy fallback dialog title: “Sensitive content detected” with a “Detected items” list.
- **Privacy panel under a message** (“How I got this answer”): “Privacy protection”, states `Tokenised`, `Tokenised (DLP)`, `Blocked`, `Privacy active`, `Restored from vault`, or “Scanned for personal data — nothing found.”; rows `Original message` (“stays on your device”), `Sent to AI`, `What the AI returned`, `Token mapping` (“Click to reveal”). These last rows only exist when **“Let people see what was sent to the AI”** is on.
- Blocking messages the user sees: “Prompt blocked by data-loss-prevention policy.”, “Prompt blocked by you.”, “Blocked: DLP decision timed out.”, “Privacy protection is temporarily unavailable, so your message was not sent. Please try again in a moment.”, “This message is too large to scan for personal data, so it was not sent. Please split it into smaller parts.”

---

## 3. Concepts a learner must understand

- **Privacy Shield** — one policy document per organisation (`org_privacy_shield_<orgId>`) that governs every chat, agent and (optionally) routine in that organisation. One master switch; when it is off nothing is checked.
- **PII Guard / detection service** — the on-premise sidecar (`guard-service`) that does the actual scanning with a GLiNER model. If it is not installed or not answering, *every* PII control on the page is decoration. Installed/uninstalled by a platform admin via `POST /api/admin/guard/install`.
- **Category** — one of the 21 kinds of personal data the detector is asked about. A category that is not ticked is never asked of the model, so it can never be found.
- **Sensitivity / confidence threshold** — how sure the detector must be before a finding counts. Stored as a float. **The dial runs backwards**: a *lower* number finds *more*. 0.70 is the calibrated anchor, i.e. the configuration every published quality number was measured at.
- **Tokenize (“Replace with placeholders”)** — sensitive spans are swapped for labels such as `[email_1]` before the message leaves; Bee Flow substitutes the real values back into the answer. The AI never sees the values. Enterprise.
- **Block (“Do not send the message”)** — the message is refused before it reaches a model, and the person is asked to rewrite it.
- **DLP pre-flight (“One last check before an outside AI”)** — a *second*, interactive check that runs only just before an **external** provider is called (unless `dlpScope` is `all`). Modes `Ask` / `Hide it` / `Do not send`.
- **Always review** — pause for the review dialog even on a clean scan, so a false negative can still be caught by a human.
- **Fail-closed vs fail-open** — what happens when the detector cannot run. `fail_closed` (the default, and not exposed in the org UI) refuses the message; `fail_open` sends it unmasked. There is a *separate* policy for the unscanned tail of a very large attachment (`attachmentLargeInputPolicy`), which defaults to `fail_open` but always leaves an amber warning and an audit row.
- **Custom sensitive terms (“Always hide these”)** — org-authored literal strings or regexes, redacted *in addition* to whatever the detector finds.
- **Never-hide allowlist (“Never hide these”)** — the mirror image: values that must never be treated as personal data. Matching is **exact on the normalised form** (lowercase, punctuation and whitespace stripped) and never a substring. Plus a shipped list of **221 public organisations** (Microsoft, PostNL, Belastingdienst…), on by default, which applies **only** to the `Organization` category.
- **Tool-call blocking** — per tool class (`external` = leaves your org, `internal` = stays on your server), refuse the tool when a listed category is involved, and strip that data out of the result.
- **Sovereignty score** — 0–100 over the period; calls that stayed in the EU or on your own servers score full marks, personal data leaving Europe counts double against it. Computed server-side over full aggregates.
- **Surface** — where an event came from: `Direct chat`, `Agent`, `Routine`, `Notebook`.
- **Clamped field** — a setting the licence does not allow, which the server silently forces to the allowed value and reports back in `clamped_fields`, so the UI can say why what you see differs from what you picked.
- **Staleness warning** — a regex collection or rule the shield still references but which no longer exists, so that part of the guard silently stops firing.

---

## 4. End-to-end workflows (exact click paths)

### W1 — Turn the shield on for the first time
1. Sign in as an organisation admin.
2. Open `Settings` → `Organisation` → `Privacy Shield`.
3. On tab **`Overview`**, switch **“Protect personal data”** on. The three greyed tabs become clickable.
4. Go to tab **`What we look for`**.
5. Under “How strict should we be?”, pick **`Balanced`** (the Recommended card, 0.70).
6. Under **“Kinds of personal data”**, click `All`, or tick the categories that matter (e.g. Person Names, Email Addresses, Phone Numbers, Home and street addresses, Bank Account Numbers, IBAN Numbers, National ID numbers (BSN and equivalents)).
7. Go to tab **`What happens`** and choose **`Replace with placeholders`** (Enterprise) or **`Do not send the message`**.
8. Leave **“Also protect routines”** and **“Also check knowledge bases when documents are added”** on.
9. Click **`Save All Changes`**. Expect the toast “Saved successfully!”.
10. Return to **`Overview`** and read the posture table: `Kinds of data we look for` must not say “0 of 21”.

### W2 — Turn on the interactive review before external models
1. `Settings` → `Organisation` → `Privacy Shield` → tab **`Leaving your org`**.
2. Switch on **“One last check before an outside AI”**.
3. Choose the mode card **`Ask`**.
4. Tick **“Always show this check, even when nothing is found”** if the organisation wants a human eye on every outbound message.
5. Click **`Save All Changes`**.
6. Verify: open a normal chat on a model that runs outside the organisation, send a message containing a name and an e-mail address. The dialog **“Check this before it goes to the AI”** appears with the findings highlighted; press **`Redact and send`**.
7. Under the sent message, open the privacy panel and confirm it reads `Tokenised (DLP)`.

### W3 — Add a company-specific term and an exception
1. `Settings` → `Organisation` → `Privacy Shield` → tab **`What we look for`**.
2. Expand **“Your own words and exceptions”**.
3. In **“Always hide these”**, type a name in `Give it a name` (e.g. `Contractnummer`) and press **`Add`**.
4. In the new row, set `What to look for` to `KC-\d{4}`, switch the segmented control from `Exact text` to **`Pattern (advanced)`**, leave `Case sensitive` off.
5. In **“Never hide these”**, type the exception (e.g. `Van Dijk Groep`) and press **`Add`**. Leave **“Always allow well-known companies”** on.
6. Click **`Save All Changes`**.
7. If a pattern does not compile, the save still succeeds for everything else and the offending row turns red with “Not saved — <regex engine message>”; the save-bar message reads “Saved, but N custom term(s) were rejected and are not in force.”

### W4 — Hold personal data back from tools
1. Tab **`Leaving your org`** → card **“Hold personal data back from tools”**.
2. Under **“Tools that send data outside your organisation”** (Enterprise), tick the categories that must never leave — e.g. National ID numbers, Bank Account Numbers, Medical Conditions — or press `All`.
3. Under **“Tools that stay on your own server”**, tick the narrower set you still want withheld internally.
4. Optionally switch on **“No web search while a file is attached”** and **“Check connected-app traffic for personal data”**.
5. Click **`Save All Changes`**. Check the `Overview` row `Held back from tools` reads e.g. “outside tools 7/21, own server 3/21”.

### W5 — Read the evidence and act on it
1. `Settings` → `Organisation` → `Privacy Shield` → tab **`What happened`**.
2. Set the range to `30d`.
3. Read the four KPIs; if the banner **“Personal data left Europe”** is present, press **`Look at these`** — the details fold opens on `Data that left your org`, pre-filtered to non-EU destinations.
4. Expand a row to see `Country`, `Operated by`, `Server address` and `Personal data`.
5. Fix the cause: go back to tab **`Leaving your org`** and switch on **“Use only AI hosted in the EU”** (if EU models are configured) and/or add the leaking categories to the external tool-block list.
6. Click **`Save All Changes`**, then re-check the tab a week later.

### W6 — Diagnose “the shield is on but nothing is being caught”
1. In the org settings page, check tab **`Overview`** → row `Kinds of data we look for`. If it reads “0 of 21”, that is the cause — tick categories on tab `What we look for`.
2. If categories are ticked, check `How strict`. A custom value of 90–100% will hide almost nothing.
3. If both look right, the detection service is the suspect. A platform admin opens `Admin` → `Security` → `Guardrails`; the amber banner **“PII Guard is not installed”** (“Personal-data detection cannot run, so the PII settings below have no effect. Regex patterns and sensitive terms still work — they do not need the service.”) or **“PII Guard is unreachable”** (“…Organisations set to fail closed are blocking messages; organisations set to fail open are sending them unmasked.”) is the answer. Press **`Install`** if offered.
4. Check `GET /api/org-privacy-shield/user/guard-status` → `{ configured, reachable }` — both must be `true`.
5. Confirm the runtime agrees with the form: `GET /api/org-privacy-shield/<orgId>/effective`.

---

## 5. Defaults and limits (the numbers)

**Shield document defaults** (`server/routes/orgPrivacyShield.js`, GET for an org with no saved row):

| Field | Default |
|---|---|
| `enabled` | `false` |
| `piiDetectionCategories` | `[]` (seeded once from the global `ai` blob if that has any) |
| `piiDetectionConfidenceThreshold` | `0.7` |
| `piiDetectionAction` | `'block'` |
| `piiFailureMode` | `'fail_closed'` (not exposed in the org UI) |
| `attachmentLargeInputPolicy` | `'fail_open'` |
| `applyToAutomations` | `true` (an absent field is read as ON) |
| `privacy_scan_knowledge_bases` | ON (absent = ON) |
| `piiAllowPublicOrgs` | `true` (absent = ON) |
| `piiAllowTerms` | `[]` |
| `dlpEnabled` | `false`; `dlpScope` `'external'`; `dlpMode` `'ask'`; `dlpAlwaysReview` `false`; `dlpFailureMode` `'fail_closed'` |
| `webSearchGuardEnabled`, `euModeEnabled`, `monitorIntegrations`, `showRawPayload`, `disableSearchOnUpload` | `false` |
| `toolPiiPolicy` | `{ external: { blockCategories: [] }, internal: { blockCategories: [] } }` |
| `action` (legacy regex action) | `'delete'`; `scope` `{ userInput: true, agentOutput: true }` |

**Hard caps and thresholds**

- Categories in the catalogue: **21**. Public-organisation allowlist: **221** entries.
- Sensitivity presets: **0.85 / 0.70 / 0.45**; slider range **0.10–1.00**, step **0.05**; preset snap window **±0.024**.
- Custom term: label ≤ **120** chars, pattern ≤ **500** chars. Allow term: ≤ **120** chars, max **500** entries. DLP allowlisted hosts: max **50**. Tool-class block list: max **40** ids per class.
- Manual marks in one DLP review: max **200**; only `offset`/`length` are sent, the text is re-sliced server-side.
- DLP decision timeout: **60 s** (`decisionQueue.DEFAULT_TIMEOUT_MS`). Decisions are in-memory only — a server restart invalidates every pending one.
- PII scan window: **8 000** chars (`PII_GUARD_WINDOW_CHARS`), overlap **256** chars, max **40** windows; scan deadline **300 000 ms** (`PII_GUARD_SCAN_DEADLINE_MS`); per-request guard timeout **90 000 ms** (`PII_GUARD_TIMEOUT_MS`).
- Circuit breaker: **3** consecutive guard failures → short-circuit for **10 000 ms**.
- Guard health probe memo in `shield-status`: **15 s**.
- Attachment scan: max **50** pages (`DLP_ATTACHMENT_MAX_PAGES`), per-page budget **10 000 ms**, whole-file budget **120 000 ms`.
- Token map per conversation: **2 000** placeholders (**5 000** for a notebook-bound conversation); overflow evicts the oldest and emits `token_evicted`.
- Activity tab: default range **30 d**; detail page size **50**, `Show more` +50 up to **200**; category/destination drills fetch the maximum 200 and filter client-side. Guardrail-event queries fall back to a **30-day** window, egress to **90 days**, when no explicit range is given.
- Activity alerts: sovereignty score < **40**, personal-data catches > **10**.

---

## 6. What happens on failure

- **Detector unreachable / model not ready** → `detectPii()` returns a degraded result. With `piiFailureMode: fail_closed` (the default) the message is refused and the user reads “Privacy protection is temporarily unavailable, so your message was not sent. Please try again in a moment.” An audit row is written with the marker `privacy_protection_unavailable`, shown in the activity table as “Protection was unavailable”.
- **Guard not installed at all** → the admin console shows “PII Guard is not installed”; PII settings have no effect at all, while regex patterns and custom sensitive terms keep working.
- **Scan deadline hit on a huge paste** → a partial, fail-closed result; marker `scan_timeout` (“Check ran out of time”).
- **Attachment past the page cap or the budget** → with `attachmentLargeInputPolicy: fail_open` the unscanned remainder is passed through but *visibly*: the badge “Scan incomplete” with “Some uploaded content could not be scanned and was sent to the AI unredacted.”, plus markers `scan_overflow` / `scan_timeout` / `scan_degraded`. With `fail_closed` the attachment is held: “Attachment held: {filename} is too large to fully scan for sensitive data. Split it or reduce the page count, then re-upload.”
- **DLP review not answered within 60 s** → the promise rejects and the message is treated as blocked: “Blocked: DLP decision timed out.”
- **Someone else's decision id** → `POST /api/chat/dlp-decision` returns **404** “Decision not found, expired, or not owned by this user.”
- **Shield config cannot be loaded** → the editor renders the red “Could not load these settings” box, no form, no Save. (This is deliberate: a blank form with a live Save button once overwrote a real configuration with constructor defaults.)
- **Invalid regex in a custom term** → the valid terms and the rest of the shield are still saved; the server returns `termErrors` and the UI flags the row and shows “Saved, with notes — see the message below.”
- **Licence does not cover a chosen setting** → the server clamps it, persists the clamped value, and returns `clamped_fields` + `clamped_tier`. The UI shows an amber “Saved. Note: …” (a warning, not an error). If tier resolution itself fails, the server **fails closed to community clamps**.
- **Placeholder ceiling hit in a long routine** → oldest placeholders are evicted and can no longer be turned back into real values; marker `token_evicted` (“Some placeholders were dropped”).
- **Monitoring endpoints on a plan without `advanced_usage_monitoring`** → the whole `/api/usage/guardrails/*` and `/api/usage/integrations/*` prefixes are refused by the capability gate; the tab shows the lock card. A **404** from those endpoints is deliberately treated as *empty*, not as an error.

---

## 7. Permission and licence gates

**Menu visibility**
- `Settings` → `Organisation` is shown when the user has `all` or `org_admin` permission, or `orgRole` is `admin` / `org_admin` (`agent-hub/src/pages/AdvancedSettings.jsx`, `canSeeOrg`). The `Privacy Shield` item itself carries no extra flag.
- `Admin` → `Security` → `Guardrails` is **`enterpriseOnly`** in `SecurityHub.jsx` (`hasTier('enterprise')`), so it disappears entirely on Community installs.

**Server-side authorisation**
- `GET /api/org-privacy-shield/:orgId` — `requireAuth` + **membership** of that org (super admins pass). Non-members: 403 “Not a member of this organization”.
- `PUT /api/org-privacy-shield/:orgId` — `requireAuth` + `isOrgAdminForOrg`. Others: 403 “Only organization admins can manage the privacy shield”.
- `GET /api/org-privacy-shield/:orgId/effective` — `requireAuth` + membership.
- `/api/usage/guardrails/*` and `/api/usage/integrations/*` — `requireMonitoringScope` (`server/routes/usageMonitoringAuth.js`): org member with an org-admin role → 200 scoped to the session org; plain member → 403 “Organization admin access required”; super admin **with** an org → 200 scoped to their own org; super admin **without** an org → 403 “No organisation context”; consumer without an org → 200 scoped to their own rows only. Dry-run rows are always excluded.
- `/api/admin/guard/*` (install / uninstall / status) — `requirePermission('admin_security')`. That permission is in the `org_admin` role in `server/config/orgRoles.json`; the roles `dpo` and `isms_auditor` get `admin_compliance` + `admin_monitoring` but **not** `admin_security`.
- `POST /api/chat/dlp-decision` — `requireAuth`, plus ownership of the decision id.
- `GET /api/privacy/shield-status` — `requireAuth`, always self-scoped, `Cache-Control: no-store`.

**Licence features** (`server/license/tiers.js`, all in the `enterprise` block)
- `pii_tokenize` → the `Replace with placeholders` action. The frontend disables the card (`canTokenizePii`); the server deliberately **does not** clamp the stored value — but a runtime without the feature blocks instead of tokenizing, which is exactly what the amber posture row reports.
- `web_search_guard` → “Protect web searches” **and** the external tool-class block list. Clamped on both read and write (`webSearchGuardEnabled` → false, `webSearchGuardPiiCategories` → `[]`, `toolPiiPolicy.external.blockCategories` → `[]`).
- `advanced_usage_monitoring` → the whole “What happened” tab and its endpoints.
- `guardrails_dlp` is declared in the enterprise tier list as well; the Guardrails console itself is gated by tier, not by this key, in the SPA.
- Upgrade link target: `https://beeflow.nl/pricing` (or `licenseUpgradeUrl` when the server supplies one).

There is **no** `requireLicenseFeature(...)` on the `/api/org-privacy-shield` mount — the shield document itself is readable and writable on every tier; only the individual premium settings are clamped.

---

## 8. How it connects to the rest of the product

- **Chat & agents** — the shield runs before every message; the header pill, composer line and privacy panel in chat all derive from `GET /api/privacy/shield-status`, which answers `enabled / source / action / failMode / guardReachable / euMode / coworkEnabled`. The product rule is: **claim only when `enabled && guardReachable`**, and only `action === 'redact'` may be worded as “replaced”.
- **Routines / automations** — covered when `applyToAutomations` is on (default). Routine events appear in the activity table as `Routine — <title>` and carry `automation_id` / `run_id` / `step_id`. Dry runs are excluded from every dashboard.
- **Knowledge bases** — “Also check knowledge bases when documents are added” redacts at ingest. Irreversible: the stored text is the checked text.
- **Cowork** — has its own per-org opt-in flag on top of the shield (`coworkEnabled` in the status route).
- **AI Config → Chat Models** — where the EU-hosted models are defined; the “Use only AI hosted in the EU” card only appears once at least one EU tier has a model id. The web-search cards only appear once a search provider is configured.
- **Compliance Hub** — saving the shield emits `DLP_CONFIG_CHANGED`, which re-runs the GDPR Art. 32 “Data Loss Prevention active” check and the ISO 27001 A.8.11/8.12 “Data masking & leak prevention” check immediately instead of waiting for the six-hourly sweep. Those checks' fix text points back here: “Open Security → Guardrails and enable both regex collections and PII detection.”
- **Usage & Monitoring** — the same two consolidated endpoints back the “What happened” tab; the tab replaced ~17 sections and 19 requests with two calls.
- **Encryption / Conversation Memory / Answer Reuse** — sibling org-level policies in the same menu, each with the same “pinned orgId, never guess” discipline.
- **Integrations / connectors** — `monitorIntegrations` decides whether connector traffic is also content-scanned; the egress ledger itself is always recorded.

---

## 9. Common mistakes

1. **Shield on, zero categories ticked.** Everything looks configured and nothing is ever found. The Overview row “Kinds of data we look for: 0 of 21” with the amber hint is the only warning.
2. **Turning the sensitivity dial the wrong way.** A *higher* percentage finds *less*. Setting 90% because it “sounds stricter” disables the shield in practice.
3. **Assuming the page works without the PII Guard.** With the service missing, every PII control is decoration — regex terms still fire, category detection does not. Note also that the org-settings Overview **does not currently render the “Detection service” posture row** (the editor calls `derivePosture` without a `guard` argument), so the only place that warning appears is the admin Guardrails console banner and `/user/guard-status`.
4. **Allowlisting a short word.** “Never hide these” is exact-match on the normalised value, but a careless entry like `Shell` or a common surname exempts that value **in every category, permanently**. “Shell” does *not* cover “Shell Advies BV” — each variant needs its own entry.
5. **Confusing the two checks.** “What happens” is the always-on PII gate; “One last check before an outside AI” is the interactive DLP pre-flight and by default only fires for **external** providers. Switching the first to Block and expecting an Ask dialog will not work.
6. **Expecting the dialog to appear for a local model.** With `dlpScope: external` (the default) a self-hosted or EU-local provider is skipped entirely.
7. **Setting the action to Tokenize on a Community plan.** It saves, the posture row goes amber, and the runtime blocks instead. Read the “Saved, with notes” message rather than assuming the setting took.
8. **Not noticing a rejected custom term.** A partial save reads as a clean save unless you read the amber bar and the red row.
9. **Editing the wrong organisation in the admin console.** The console mount has an org picker and *does* default to the first organisation; the settings mount never guesses. Switching orgs with unsaved edits triggers a confirm and discards them.
10. **Reading the “What happened” tab in the admin console.** It is not offered there on purpose — those endpoints scope to the *session* org, so it would show the wrong organisation.
11. **Turning on “Let people see what was sent to the AI” and forgetting who can see it.** Anyone who can open the conversation can reveal the real values.
12. **Expecting knowledge-base redaction to be retroactive.** It applies at ingest only; already-stored documents keep whatever was stored.
13. **Leaving the browser mid-edit.** Refresh/close is guarded by `beforeunload`, but in-app navigation is not — there is no router hook, so unsaved shield edits are lost when you click away inside the app.

---

## 10. Three scenarios for “Van Dijk Groep” (Dutch SME)

### S1 — Procurement: supplier contracts pasted into chat
Van Dijk Groep's inkoop team pastes supplier quotations, contract numbers and IBANs into chat to compare them. The admin:
1. Turns the shield on, sensitivity **`Balanced`**.
2. On **`What we look for`**, ticks Company names, IBAN Numbers, Bank Account Numbers, Tax numbers (VAT / BTW / RSIN), Email Addresses, Phone Numbers.
3. Adds a custom term under **“Always hide these”**: name `Inkoopcontractnummer`, pattern `VDG-INK-\d{6}`, type `Pattern (advanced)`.
4. Adds `Van Dijk Groep` and the big public suppliers (`PostNL`, `Signify`) under **“Never hide these”** so the AI still understands who the counterparties are — and leaves **“Always allow well-known companies”** on.
5. Sets **`What happens`** to `Replace with placeholders` so the model can still compare the quotations structurally.
**Teaching point:** the allowlist is what makes a redacted procurement comparison still readable — and the exactness rule means `Signify Nederland B.V.` needs its own entry.

### S2 — HR: sick-leave and re-integration files
HR uses a routine that summarises re-integration dossiers. Those contain names, BSN, addresses and medical conditions — special-category data.
1. On **`What we look for`**: Person Names, Home and street addresses, Date of Birth, National ID numbers (BSN and equivalents), Health Insurance Numbers, Medical Conditions, Medications. Sensitivity **`High sensitivity`** (0.45) — HR would rather over-hide.
2. On **`What happens`**: `Do not send the message`, and **“Also protect routines”** stays on, because the HR routine runs unattended at night.
3. On **`Leaving your org`**: under “Tools that send data outside your organisation” tick Medical Conditions, Medications, National ID numbers and Person Names, so a connector can never carry them out; switch on **“No web search while a file is attached”**.
4. Because the dossiers arrive as scanned PDFs, the admin also asks the platform admin about the **50-page** attachment cap and the `fail_open` default for the unscanned tail — for HR, `fail_closed` is the right choice, so a too-large dossier is held rather than partially sent.
**Teaching point:** unattended routines are exactly where a fail-open default is dangerous, and where the activity tab's `Routine — <title>` rows are the only evidence anyone will ever look at.

### S3 — Sales: a CRM export and an outside model
Sales wants a strong external model to draft proposals from a CRM export full of contact details.
1. On **`Leaving your org`**, the admin switches on **“One last check before an outside AI”**, mode **`Ask`**, and ticks **“Always show this check, even when nothing is found”** for the first month.
2. A sales rep pastes twelve customer rows; the dialog **“Check this before it goes to the AI”** appears, highlighting names, e-mail addresses and phone numbers. The rep selects one column the detector missed, uses **“Mark as personal data”**, ticks **“Remember my choice for this conversation”** and presses **`Redact and send`**.
3. A week later the admin opens **`What happened`**, sets the range to `30d`, and sees the banner “Personal data left Europe”. Pressing **`Look at these`** shows the calls, the destination host and the country.
4. The admin switches on **“Use only AI hosted in the EU”** and adds the leaking categories to the external tool-block list, then re-checks the `Stayed in Europe` KPI the next week.
**Teaching point:** the evidence tab is supposed to tell an admin something they did not know; the fix is usually two tabs away.

---

## 11. List/read API endpoints a “did the learner do it?” check can call

All are real routes read in `server/routes/`. All are session-cookie authenticated (`authFetch` sends credentials).

| Method | Path | Auth | What comes back |
|---|---|---|---|
| `GET` | `/api/org-privacy-shield/:orgId` | `requireAuth` + org membership | The whole shield document: `enabled`, `piiDetectionCategories[]`, `piiDetectionConfidenceThreshold`, `piiDetectionAction`, `piiFailureMode`, `attachmentLargeInputPolicy`, `dlpEnabled`, `dlpScope`, `dlpMode`, `dlpAlwaysReview`, `dlpFailureMode`, `dlpAllowlistedHosts[]`, `customSensitiveTerms[]` (each `{id,label,pattern,type,caseSensitive,createdAt,**createdBy**}`), `piiAllowTerms[]`, `piiAllowPublicOrgs`, `toolPiiPolicy{external,internal}`, `webSearchGuardEnabled`, `disableSearchOnUpload`, `monitorIntegrations`, `applyToAutomations`, `showRawPayload`, `euModeEnabled`, `collectionIds[]`, `scope`, `action`, **`updatedAt`**, **`updatedBy`** (owner field — the user id of the last saver), plus `clamped_fields[]`/`clamped_tier` and `stalenessWarnings[]` when applicable. **This is the single best verification endpoint for a “configure the shield” exercise.** |
| `GET` | `/api/org-privacy-shield/:orgId/effective` | `requireAuth` + org membership | `{ orgId, summary{ shieldEnabled, piiEnabled, piiCategoriesCount, piiConfidenceThreshold, piiConfidenceWarning, dlpEnabled, privacyScanEnabled, privacyAction, privacyScope, customTermsCount, stalenessWarnings[] }, rawShape{ …, updatedAt, updatedBy }, resolved }` — the config the runtime actually honours, after clamps. Good for “does it *really* apply?” checks. |
| `GET` | `/api/org-privacy-shield/user/guard-status` | `requireAuth` | `{ configured: bool, reachable: bool }` — is the PII Guard installed and answering. |
| `GET` | `/api/privacy/shield-status` | `requireAuth`, self-scoped | `{ enabled, source ('org'\|'personal'\|'platform'\|'off'), action ('redact'\|'block'\|'ask'\|null), failMode, guardReachable, euMode, coworkEnabled }`. Never 500s; degrades to all-off. Ideal for “is the learner's next message actually protected?”. |
| `GET` | `/api/usage/guardrails/overview?days=&startDate=&endDate=&interval=` | `requireMonitoringScope` (org-admin, own org) **+** licence `advanced_usage_monitoring` | `{ summary{ total_events, moderation_count, pii_count, regex_count, dlp_count, dlp_allowed, dlp_redacted, dlp_blocked, input_count, output_count, unique_users }, timeline[{period,total,moderation,pii,regex,dlp}], top_categories[{category,violation_type,count}], by_action[], top_users[{user_id, display_name, avatar, total, moderation, pii, regex, last_event}], by_surface[{surface,count}], health, window }` |
| `GET` | `/api/usage/guardrails/recent?limit=&cursor=&type=&user=` | same | Plain array of guardrail events. Row: `id, timestamp, organization_id, **user_id**, agent_id, agent_name, conversation_id, violation_type, violation_categories, direction, action_taken, source, model, attachment_filename, attachment_page, automation_id, run_id, step_id, is_dry_run` + hydrated `display_name` / `avatar`. `user_id` is the owner field. `limit` max **200**, keyset via `?cursor=<last id>`, default window 30 days. **The endpoint to prove “the learner's message was actually caught”.** |
| `GET` | `/api/usage/integrations/overview?days=&interval=` | same | `{ summary{ total_calls, unique_integrations, unique_destinations, unique_users, eu_count, local_count, non_eu_count, pii_non_eu_count, pii_events, error_count, blocked_count, avg_duration_ms, sovereignty_score, score_delta }, timeline[], top{ destinations, non_eu_destinations, integrations, actors, users }, pii_categories[], data_categories[], health, window }` |
| `GET` | `/api/usage/integrations/egress?limit=&cursor=&eu=&local=&user=&integration=&pii=` | same | Plain array. Row: `id, timestamp, organization_id, **user_id**, agent_id, agent_name, tool_name, integration_type, server_endpoint, dest_host, data_direction, peer_ip, peer_ip_source, tls_servername, connect_ms, is_local, operator, country_code, country_name, country_flag, is_eu, pii_categories_detected, status, error_message, duration_ms, is_dry_run, source, automation_id`. `limit` max **200**, default window 90 days. |
| `GET` | `/api/admin/guard/status` | `requirePermission('admin_security')` | Installer status of the PII Guard sidecar. |

Also present but **deprecated** (they answer with a `Deprecation: true` header): `/api/usage/guardrails/summary`, `/timeline`, `/by-user`, `/by-category`, `/by-action`, and the corresponding `/api/usage/integrations/*` singles. Prefer the two `…/overview` endpoints.

Write endpoints, for completeness (not for verification reads): `PUT /api/org-privacy-shield/:orgId` (org admin), `PUT /api/org-privacy-shield/user/me` (self), `POST /api/chat/dlp-decision` (self), `POST /api/admin/guard/install` and `/uninstall` (`admin_security`).
