# Fact sheet — org-compliance (Compliance Hub / "Compliance Center")

Audience: **org admin / DPO / ISMS auditor**.
Source of truth read for this sheet (all paths relative to ``):
`agent-hub/src/components/admin/compliance/**`, `agent-hub/src/pages/AdvancedSettings.jsx`,
`agent-hub/src/i18n/en-defaults.js`, `server/routes/compliance.js` + `server/routes/compliance/**`,
`server/routes/dsr.js`, `server/compliance/**`, `server/stores/{complianceStore,dsrStore,incidentStore,soaStore,riskStore,ismsDocStore,dpiaStore}.js`,
`server/config/orgRoles.json`, `server/license/tiers.js`, `server/modules/catalog.js`.

**Status: the feature exists and is large and real** (≈70 backend route handlers, 71 shipped checks, 11 register/admin screens).
It is mid-redesign (Sep 2026, uncommitted on branch `claude/builder-redesign-fase-1-6sun0h`): the new rail/header shell is live,
most pages are still the legacy ones mounted through adapters (`data/pages.jsx`). **Two rail rows render a placeholder today**:
`More frameworks` and `Data portability` → `PendingPage` = *"This section arrives with the next release"*. Do not write a lesson
step that clicks into those two.

---

## 1. What the feature is for

Bee Flow is sold as a GDPR-safe alternative to ChatGPT Teams. The Compliance Hub is the part of the product where an
organisation **proves** that: it runs automated checks against the workspace's own live configuration, keeps the registers a
DPO or CISO must keep (data-subject requests, incidents/breaches, processing register, DPIAs, risks, Statement of
Applicability, policies, audits, training, access log), and writes every material action into a **hash-chained evidence
ledger** so an auditor can be handed PDFs instead of screenshots.

Three ideas run through the whole thing:

1. **Scores come from live system state, not from a questionnaire.** A check reads the database/config (is encryption on? is
   the DLP guardrail firing? is there a DPO?) and returns pass / warn / fail / not_applicable.
2. **The product never lies with a zero.** A number the server did not send renders as *nothing*, not as "0" (see
   `railMeta.js` docblock — every branch returns `null` on `undefined`).
3. **The tool records, it does not file.** "Authority notified", "CRA report sent", "SCC attested", "training attested" are
   *attestations*: timestamp + actor + reference. Bee Flow never files with a supervisory authority, a CSIRT or ENISA.

---

## 2. Where it lives, and who can see it

**Menu path (primary):** Settings (gear) → sidebar entry **Compliance** (`settings.compliance`, scales icon, colour
`--kind-compliance`). It sits inside the **Organisation** group but is also shown to a pure DPO who has no other org rights.
URL: `/app/settings/organisation/compliance/<section>[/<checkId>]`.
The nav entry carries a warning-toned count badge = `counts.attention_open`.

**Menu path (secondary):** the admin dashboard, `admin/compliance/<section>`. The hub always *emits*
`admin/compliance/<section>` through `onNavigate`; `pages/settings/complianceNavAdapter.js` rewrites it back onto the
settings URL when it is mounted in Settings.

**Public demo (anonymous, no login):** `/__demo__/compliance` — a fictional Dutch insurance intermediary. Useful for
screenshots; downloads are disabled there (`exportsEnabled=false` → `downloadUrl()` returns null and the button is hidden).

### Gates (all three must be true)

| Layer | Gate | Where |
|---|---|---|
| Module | `requireModule('compliance')` — module id `compliance`, "Compliance Hub", category Governance, `defaultImported: true` | `server/index.js:605`, `server/modules/catalog.js` |
| Licence / entitlement | `requireCapability('compliance_hub_gdpr')` on the **whole** `/api/compliance` mount; enterprise tier self-hosted, on cloud a GA compound flag per subscription plan | `server/index.js:605`, `license/tiers.js`, `core/entitlements/betaFeatures.js` |
| Permission | `requirePermission('admin_compliance')` on **every** admin handler | all of `routes/compliance/*`, `routes/dsr.js` |

Frontend mirror: `AdvancedSettings.jsx` → `usePermissionCheck(user, ['admin_compliance'])` **AND**
`useCan('compliance_hub_gdpr')` decides whether the nav entry appears; the panel itself is wrapped in
`<RequireTier tier="enterprise" feature="compliance_hub_gdpr">`, so a below-enterprise deep link gets the standard
UpgradePrompt instead of a blank screen.

**Roles that grant `admin_compliance`** (`server/config/orgRoles.json`): `org_admin` ("Organisation Admin"),
`dpo` ("Data Protection Officer"), `isms_auditor` ("ISMS Internal Auditor"). `agent_admin`, `agent_editor` and `member` do **not**.
`/api/dsr` is mounted *without* the licence gate (`gate: null` in `featureMap`) because GDPR requires the public intake channel
to be reachable — but every admin DSR handler still requires `admin_compliance`.

Per-framework capabilities (`compliance_hub_nis2`, `_cra`, `_data_act`, `_pld`, `_eaa`, `_dora`, `_machinery`, `_custom`) are
enforced **in handler** by `compliance/frameworkPolicy.js`, not as separate mounts. A locked framework is *shown locked*,
never hidden; `POST /frameworks/:id/enable` then answers `403 {error:'feature_locked', feature, required, current, upgrade_url}`.
`compliance_hub_aia` and `compliance_hub_iso27001` are declared in `tiers.js` but **not enforced** — reserved for a future split.

---

## 3. The screens (real labels)

The shell is one **rail** (300 px, `ComplianceRail`) + one **48 px header** (`ComplianceHeader`) + one page (`data/pages.jsx`).

### Rail

Title **"Compliance"**, subtitle **"{org} · Compliance Hub"**, a reports icon button (aria "Reports and downloads"),
a search box placeholder **"Search checks, articles or registers…"** (empty result: **"Nothing matches"**), and a two-way
segmented control **All** / **Needs attention** (badge = attention count). Footer:
**"Evidence chain intact · {rows} rows · SHA-256"** or, in error ink, **"Evidence chain broken — check the integrity report"**.

Rows, in order, grouped by three group labels — **Frameworks**, **Registers**, **Admin**:

| Row label (real) | id | Right-hand meta |
|---|---|---|
| Overview | `overview` | `run {time}` |
| GDPR | `gdpr` | score dot + number |
| AI Act | `aia` | score |
| ISO 27001 | `iso` | score |
| More frameworks | `frameworks` | `{n} candidates` / `{n} candidates · {m} just in force` |
| NIS2 · CRA · Data Act · Product liability · Accessibility (EAA) · DORA · Machinery Regulation · Own frameworks | optional | score (row appears only once the org enabled it) |
| Requests (DSR) | `dsr` | overdue badge + `{n} open` |
| Incidents & breaches | `incidents` | clock + `{hours} h` + `{n} open` |
| Vulnerability register | `vulnerabilities` (optional, CRA) | `{n} open` |
| Processing register (ROPA) | `ropa` | `reviewed {date}` |
| DPIAs | `dpia` | `{n} to do` |
| Risk register | `risks` | `{n} · {high} high` |
| SoA (Annex A) | `soa` | `{approved}/{total} approved` |
| Policies | `policies` | `{n} · {due} review` |
| Audits & management review | `audits` | `{n} planned` |
| Training & competence | `training` | `{done}/{total}` |
| Access log | `access_log` | — |
| Data portability | `portability` (optional) | `{n} gaps` |
| Settings | `settings` | `DPO · legal bases` |
| Evidence connectors | `connectors` | `{n} · sweep {time}` |

Old bookmarks still work: `iso_overview`, `iso_controls` → `iso`; `iso_soa` → `soa`; `iso_risks` → `risks`;
`iso_policies` → `policies`; `iso_audit` → `audits`; `iso_training` → `training`; `iso_access_log` → `access_log`;
`iso_connectors` → `connectors`; `kaders` → `frameworks`. Unknown ids fall back to Overview.

### Header tabs per section (`?tab=` in the URL, no history entries)

- Overview: **Status · Calendar · Reports**
- Every framework page: **Checks · Timeline · Evidence**
- More frameworks: **All frameworks · Calendar · Per automation**
- Requests (DSR): **Requests · Public form · Settings**
- SoA: **Controls · History · Export**
- Audits: **Internal audits · Management reviews · Nonconformities · Objectives**

### Header buttons per section

- **Overview** — pill `Setup · step {step} of 4` *or* score headline + `{n} open`; info chip
  `Last run {time} · every {hours} h`; secondary **Report (PDF)**; primary **Run now** (label becomes *Running…*; disabled and
  titled **"Available after setup"** until onboarding is done).
- **Framework page** — score pill; chip `In force since {date}`; **Report (PDF)**; primary **Run again**.
- **Requests (DSR)** — pill `{n} past the deadline` (error) or `All requests within the deadline`; chip
  `Art. 12–22 · 30 days, +60 with reason`; refresh icon; primary **Record a request**.
- **SoA** — pill `{approved} of {total} approved · {n} to review`; chip `ISO/IEC 27001:2022 · Annex A`;
  secondary **Fill missing rows**; primary **SoA (PDF)**.
- **More frameworks** — pill `{active} active · {candidates} candidates`; chip `As of {date} · not legal advice`;
  primary **Add framework**.

### Page bodies worth naming

**Overview (Status):** score ring (**"Overall score"**), subtitle *"Automated assessment against GDPR and the EU AI Act.
Fix the red items first."*, four stats **Passing / Warnings / Failing / Not applicable**, **Run checks now**,
**Last run: …**, **Download report**. Card **"Needs attention"** ordered *"failing first, then by severity"*, empty state
*"Nothing needs attention — every check passes or is not applicable."*, failure state *"Could not read the attention list right now."*
All-clear state: **"All clear"**.

**Framework page (Checks tab):** toolbar with status filter pills, segmented **By status** / **By article**, search
*"Search checks…"*. Table columns **Check · Article · Verification · Last run**. Row actions: **Auto-fix**
(confirm block *"Apply the automatic fix?"* / *"This applies the automated remediation for this check to every affected item
below. The change is recorded in the evidence log…"*, buttons **Apply fix** / **Cancel**), a re-run icon
(*"Re-run this check"*), and a remediation link rendered as **Configure** / **Handle** / **Go to {section}** / **Open fix**.
Empty states: *"No checks have run yet. Click \"Run checks now\"."*, *"No checks match this filter."*,
*"The checks could not be read."*. A shared check shows *"· also counts for"* + the other framework refs.

**Requests (DSR):** filter pills **Open · Overdue · Completed · Rejected**, sort note **"By deadline"**, search
*"Search number or e-mail…"*. Table columns **Deadline · Request · Received · Via · Status**.
Channel labels: **Form /dsr · E-mail to DPO · Phone · Letter · Other**. Identity labels: *identity confirmed* /
*identity not yet confirmed* / *employee*. Footer note: *"Requests arrive through the public form (no account, rate-limited,
linked from the privacy notice) or are recorded here by hand. The 30-day clock starts at receipt, not when work starts."* +
link **View form**. Empty: *"No data-subject requests received."* / *"No requests match this filter."* /
*"The requests could not be read."*
Drawer sections: **Data subject** (with *"The full address is visible only to the DPO and the handler."*), **Timeline**,
**Found in Bee Flow**, **Summary of the handling**. Buttons **Start working**, **Fulfil and e-mail the data subject**,
**Reject…** → **Reject and e-mail the data subject**, **Extend +60 d** → **Extend by 60 days**, **Export**.
Footer note: *"Personal data leaves Bee Flow only by e-mail to the data subject. The export is the file of this request, not the data."*
Capture modal title **Record a request**, description *"For a request that arrived by e-mail, phone or letter. The 30-day clock
starts at receipt."*, fields **Kind of request · E-mail address of the data subject · Arrived via · Received on · Notes**,
submit **Record**.

**Incidents & breaches:** subtitle *"Record every (suspected) personal-data breach here. Detection starts the 72-hour Art. 33
clock…"*. **Record incident** → fields **What happened? · Details · Severity · Occurred at (if known) · High risk for the
people involved (triggers Art. 34)**, hint *"Recording starts the 72-hour clock from now. If the breach was detected earlier,
the clock legally started then — do not delay recording."*, submit **Record — start the clock**.
Statuses **Open · Assessing · Authority notified · Subjects notified · Closed**; pill **High risk**;
`{hours}h to Art. 33 deadline` / `{hours}h past the 72h deadline`. Actions **Start assessment**, **Notify breach recipients**,
**Record authority notification** (+ *"Authority case/reference number (optional)"*), **Record data-subject notification**,
**Close incident**. Note: *"\"Record authority notification\" is an attestation: your organisation files with the supervisory
authority itself (e.g. Autoriteit Persoonsgegevens); Bee Flow only records that it was done, by whom and when."*
Empty: *"No incidents recorded. If a breach is ever suspected, record it here immediately…"*

**Processing register (ROPA):** title **"Records of Processing Activities (Art. 30)"**, **Last reviewed {date}** /
*"Never reviewed — check the generated record below and mark it as reviewed."*, buttons **Regenerate from live configuration**,
**Mark as reviewed**, **Download ROPA (PDF)**. Tables: activities (**Activity · Purpose · Data categories · Retention · Transfers**)
and processors (**Operator · Location · Calls · Last seen · SCC / DPA**) with **Attest SCC** / **SCC attested** /
**EU — not required**. Empty: *"No published agents — no processing activities to record yet."*,
*"No outbound integration traffic observed."*

**DPIAs:** subtitle *"Agents flagged as high-risk (Art. 35) need a Data Protection Impact Assessment before they process
personal data…"*. Per agent: **No DPIA on record** or **DPIA on record ({mode}) — approved {date}**; **Attest existing DPIA**
(*"You assessed this agent outside Bee Flow — record that attestation (valid 12 months)."*) or the questionnaire
(**Purpose of processing · Personal data involved · Makes or supports automated decisions about people · Human oversight ·
Mitigations (one per line) · Residual risk** Low/Medium/High) → **Save assessment**, **Download DPIA (PDF)**.
Empty: *"No high-risk agents detected — no DPIA required right now."*

**Risk register:** stats **Total risks · Open · High (score ≥ 10) · Reviews overdue**. **Seed suggested risks**, **Add risk**
→ **Title · Description · Category · Likelihood (1–5) · Impact (1–5) · Owner · Next review**, categories
**Confidentiality / Integrity / Availability / Compliance**, statuses **Open / Treating / Accepted / Closed**.
Columns **Risk · Category · Score · Owner · Review due · Status**; score shown as `L{likelihood} × I{impact}`; pill **review overdue**.

**SoA (Annex A):** columns **Control · Title · How satisfied · Live check · Decision · Owner**; toggle
**"This control applies to us"** / **excluded**; **Justification** (placeholder *"Why this control applies (or why it is
excluded), and how it is satisfied…"*); decisions **to review / reviewed / approved**; **Save row**;
**Seed {count} missing rows** (hint *"Creates the missing Statement of Applicability rows from the control catalog — never
overwrites a decision you already made."*); **No owner assigned**, **No automated check yet**.

**Policies:** **Seed policy templates** (*"{count} policy templates available to seed"*), per doc **Published v{version}** /
**Draft — not yet published**, **acknowledgements**, pills **template not customised** and **review overdue**.
Editor fields **Title · Document (markdown) · Owner · Review due**; **Save draft**, **Publish**
(*"Freezes the current draft as a new version that members acknowledge"*). Nudge: *"This is still the unedited template — make
it your own before publishing. Auditors spot generic templates instantly."* Empty:
*"No policy documents yet — seed the templates to get started."*

**Audits & management review:** **Plan audit** → **Audit title · Scope · Auditor · Planned date**; independence card
**"Auditor independence"** with warning *"Independence conflict: this auditor {conflicts}"*. Statuses
**Planned / In progress / Closed**; **Start audit**, **Close audit**, **Add finding** (**Severity** Observation/Minor/Major,
**Control ref · Clause · What was observed · Evidence ref (optional)**), **Raise as nonconformity** → **Raised as NC**.
Empty: *"No internal audits yet. Clause 9.2 expects audits at planned intervals — plan the first one to start the programme."*

**Training & competence:** **People & competence** — *"Per member: which policies they acknowledged, platform learning
progress, and a security-training attestation for courses completed outside Bee Flow."* Per person:
`{n} policies acknowledged`, `{count} learning modules`, **Attest training** → **Record attestation** with note placeholder
*"Optional note — course, provider, certificate…"*, then **Training attested {date}** / **Re-attest**.
Empty: *"No members to show"*.

**Evidence connectors:** per connector a title/description (e.g. **"GitHub repository security"**, **"Scaleway
infrastructure"**, **"Mail security (SPF/DKIM/DMARC)"** — *no credential needed*), **Vault connection** picker
(*"Create a \"{provider}\" connection under Integrations first — the secret stays in the encrypted vault."*),
**Settings (JSON)** (invalid → *"Not valid JSON"*), **Save connector**, **Sweep now**.
State: **Enabled — swept every 6 hours and on demand**, **Swept {date}** / **Never swept**.
Toast on success: *"Sweep done — {subjects} subject(s), {changed} changed"*.

**Settings:** groups **Data Protection Officer** (*"Contact details of your DPO (GDPR Art. 37-39)."*), **Legal bases**
(Consent / Contract / Legal obligation / Vital interests / Public task / Legitimate interests),
**Data residency & retention** (EU only / Internal only, memory-retention window, privacy-notice URL),
**AI literacy (EU AI Act Art. 4)**, **Breach notification recipients** (*"Emails alerted on anomalous data-access events."*).

**Setup wizard** (shown once, `core.setupOpen`, four steps): title **"Compliance setup"**, subtitle *"Four quick questions so
we can score you correctly."*, steps **Data Protection Officer → Legal bases you rely on → Data residency & retention →
Breach notification recipients**. Auto-detect prefills and labels those fields *"Prefilled from your configuration — review and
adjust if needed."* Step 1 requires a name **and** an e-mail containing `@`; step 2 requires ≥ 1 legal basis.

**ISO readiness numbers** (now folded into the ISO header pill + Overview › Reports):
**Controls continuously verified** (`{failing} failing · {unchecked} not yet checked`), **SoA rows approved**,
**ISMS evidence continuity** (*"Operating since {date} ({days} days of snapshots)"*, hint *"Certification bodies sample roughly
three months of ISMS operation before Stage 2…"*), **Management-system clauses (4–10)** with per-clause
**in place / partial / not recorded**, and the **Stage-1 document pack**: **Statement of Applicability (PDF)**,
**Clause conformity (PDF)**, **Risk register (PDF)**, **Policy pack (PDF)**, **Full evidence bundle (ZIP)**.

**Public DSR form** (`/dsr`, also `/privacy/requests`, no login): **"Privacy request"**, subtitle
*"Under the GDPR you can ask what personal data we process about you… it will be answered within 30 days."*
Fields **Your email address**, **What would you like us to do?** (Access my data (Art. 15) / Correct my data (Art. 16) /
Delete my data (Art. 17) / Export my data (Art. 20) / Restrict processing (Art. 18) / Object to processing (Art. 21)),
**Anything we should know? (optional)**, **Submit request**. Then **Request received** + reference number, plus a
**Check an existing request** block (**Reference #**, **Your email**, **Check**).
`/dsr/verify?id=…&token=…` is the identity link from the acknowledgement mail → **Identity confirmed**.

---

## 4. Concepts a learner must understand

- **Framework** — a regulation or standard the hub scores (GDPR, AI Act, ISO 27001, NIS2, CRA, Data Act, product liability,
  EAA, DORA, Machinery Regulation, plus org-defined "own frameworks"). GDPR / AI Act / ISO 27001 are **core** and always on;
  the rest are opt-in per org and licence-gated.
- **Check** — one automated test with a home framework, an article/control ref, a severity and a `verification` label.
  It returns pass / warn / fail / not_applicable and an evidence blob. A check can *also count* for other frameworks
  (a GDPR Art. 33 check is ISO A.5.24 evidence too).
- **Verification label** — `automated` (read from live state), `attestation` (an admin declared it), `hybrid`. The UI splits
  the score so a self-declared control is never presented as a verified fact.
- **Score** — `round(Σ(weight × factor) / Σ(weight) × 100)` with factor 1.0 pass / 0.5 warn / 0 fail; `not_applicable` rows are
  excluded from the denominator. Weights: critical 3, high 2, medium 1, low 0.5.
- **Register** — a list a DPO/CISO keeps by hand or semi-automatically (DSR, incidents, ROPA, DPIA, risks, SoA, policies,
  audits, training, access log). A register serves several frameworks at once — that is why registers are no longer "under ISO".
- **DSR (data-subject request)** — a person exercising a GDPR right. Types: access, rectification, deletion, portability,
  restriction, objection. Channels: public_form, email_dpo, phone, letter, other. Identity: unverified,
  verified_email_link, verified_manual.
- **Evidence chain** — append-only `compliance_evidence` rows, each a link in a per-org SHA-256 hash chain
  (`seq / prev_hash / payload_hash / hash`). Tamper-evident; the rail footer reports whether it verifies.
- **ROPA (Art. 30)** — the processing register, *synthesised* from live configuration: published agents = purposes,
  observed outbound calls (180 days) = processors, settings = controller + retention. The admin reviews and stamps it.
- **DPIA (Art. 35)** — impact assessment per high-risk agent. Either the built-in questionnaire or an attestation that one was
  done elsewhere; an assessment expires (`expires_at`; the attestation route is described as valid 12 months).
- **SoA / Statement of Applicability** — the ISO 27001 sheet where all **93** Annex A controls get a decision (applicable or
  excluded), a justification, an owner, and a link to whichever live check evidences them.
- **Attestation** — a recorded human declaration (SCC signed, authority notified, training done, AI literacy confirmed).
  Timestamp + actor + optional reference, written to the evidence chain.
- **Relevance gate** — DORA and the Machinery Regulation only score once the org answers whether they apply
  (`framework_relevance`: relevant / not_relevant / unknown).
- **Locked vs disabled framework** — *locked* = the licence does not cover it (card visible, enable refused with
  `feature_locked`); *disabled* = the org chose not to enable it (its checks are not run, and old rows are hidden).
- **Needs attention** — the ranked merge of failing/warning checks and register facts (overdue DSR, incident clock without
  recipients, SoA rows still to review, overdue obligations, expired attestations). Sorted fail-before-warn, then severity.
- **Deadline clock** — a running statutory window rendered as a clock rail. Each kind has its own urgency threshold set by the
  server, never by the client.

---

## 5. End-to-end workflows (click by click)

### A. First-time setup and first score
1. Settings → **Compliance** (the entry is only there with `admin_compliance` + enterprise/plan flag).
2. The **Compliance setup** modal opens by itself (org not onboarded). Header pill reads `Setup · step 1 of 4`.
3. Step **Data Protection Officer**: pick a colleague with **Pick from your organisation** or type **Name**, **E-mail**,
   **Phone**. *Next* stays disabled until name + a valid e-mail are present.
4. Step **Legal bases you rely on**: tick at least one of Consent / Contract / Legal obligation / Vital interests /
   Public task / Legitimate interests (defaults `contract` + `legitimate_interests`).
5. Step **Data residency & retention**: **EU only** (default) or **Internal only**; retention window (default 365 days);
   privacy-notice URL.
6. Step **Breach notification recipients**: add one or more e-mail addresses. Finish.
7. `POST /api/compliance/settings/onboarded` stamps `onboarded_at` and **kicks off a full check run**. The header primary
   turns into **Run now**; the Overview fills with the score ring and **Needs attention**.
8. Press **Run now** (or **Run again** on a framework page) any time; the scheduler also sweeps every 6 hours.

### B. Handle a data-subject request end to end
1. Rail → **Requests (DSR)**. Filter pill **Open**; rows are sorted **By deadline**.
2. A request that arrived by e-mail/phone/letter: header primary **Record a request** → kind, the subject's e-mail,
   **Arrived via**, **Received on**, notes → **Record**. (A request from the public form is already there.)
3. Click the row. The drawer opens: **Data subject**, **Timeline**, **Found in Bee Flow**, **Summary of the handling**.
4. **Start working** (status pending → in_progress; stamped in the timeline).
5. If identity is not yet confirmed, confirm it (the subject can also click the link in the acknowledgement mail, which sets
   `verified_email_link`).
6. Read **Found in Bee Flow** — the read-only discovery scan: memories, datatable rows (grouped by table), form answers,
   knowledge-base documents, prior DSRs. It never deletes anything; conversations are not scanned (encrypted per org).
7. If you need more time: **Extend +60 d** → type the reason (Art. 12(3): complexity or number of requests) →
   **Extend by 60 days**. Allowed **once**; the subject is e-mailed automatically.
8. Write the **Summary of the handling**, then **Fulfil and e-mail the data subject** (or **Reject…** → reason →
   **Reject and e-mail the data subject**).
9. Optional: **Export** the dossier (JSON — how the request was handled, *not* the subject's data).

### C. Record a breach and run the 72-hour clock
1. Rail → **Incidents & breaches** → **Record incident**.
2. Fill **What happened?**, **Details**, **Severity** (low/medium/high), **Occurred at (if known)**, and tick
   **High risk for the people involved (triggers Art. 34)** when that is the case.
3. **Record — start the clock**. Toast: *"Incident recorded — the 72-hour clock is running"*. The rail row now shows the
   hours left; below 24 h it turns warning, past due it turns error.
4. **Notify breach recipients** — mails everyone in Settings → Breach notification recipients and stamps
   `recipients_notified_at`.
5. **Start assessment** (status → Assessing).
6. File with the supervisory authority *yourself*, then **Record authority notification** and paste the
   **Authority case/reference number (optional)**.
7. High-risk incidents: **Record data-subject notification** (Art. 34).
8. **Close incident**. Every stamp lands in the evidence chain.

### D. Review and publish the processing register (ROPA)
1. Rail → **Processing register (ROPA)**. The document is generated from live configuration; nothing to type.
2. Read the **Processing activities** table (Activity · Purpose · Data categories · Retention · Transfers).
3. Read **Processors** — operators derived from observed outbound calls over the last 180 days, with Location and Calls.
4. For each non-EU operator, once the DPA/SCC is signed, press **Attest SCC** → the cell reads **SCC attested**.
5. **Mark as reviewed** — stamps `ropa_reviewed_at` + reviewer and re-runs `GDPR-Art30-ropa-reviewed`.
6. **Download ROPA (PDF)** for the file; the PDF's SHA-256 is written to the evidence chain.

### E. Get ISO 27001 SoA + policies to a Stage-1 pack
1. Rail → **SoA (Annex A)**. Header secondary **Fill missing rows** seeds the missing rows from the 93-control catalog
   (never overwrites a decision you already made; physical controls get an inherited-from-IaaS justification template).
2. Per row: set **This control applies to us** or mark it **excluded**, write the **Justification** / **How satisfied**,
   pick an **Owner**, move **Decision** to *reviewed* then *approved*, **Save row**.
3. Rail → **Policies** → **Seed policy templates** (13 templates). Open one, edit **Document (markdown)**, set **Owner** and
   **Review due**, **Save draft**, then **Publish** — members are asked to acknowledge that exact version.
4. Rail → **Risk register** → **Seed suggested risks** or **Add risk**; score each Likelihood × Impact and record a treatment.
5. Rail → **Audits & management review** → **Plan audit**, run it, **Add finding**, **Raise as nonconformity**; record a
   management review.
6. Overview → **Reports** tab → download **Statement of Applicability (PDF)**, **Clause conformity (PDF)**,
   **Risk register (PDF)**, **Policy pack (PDF)**, **Full evidence bundle (ZIP)**.

### F. Turn on an extra framework
1. Rail → **More frameworks** (placeholder in this build — the same action exists via the API and, once FE lands, via the
   header primary **Add framework**).
2. Pick e.g. **NIS2**; if the licence does not cover it the card shows locked and enabling answers `feature_locked`.
3. Enabling runs the framework's checks immediately, so the new rail row appears **with** a score
   (`POST /frameworks/nis2/enable` → `{ framework, ran }`; a failed first sweep returns `run_error` but the framework *is* enabled).
4. DORA and Machinery first ask whether they apply (**relevant / not_relevant / unknown**) before they score.
5. The new register rows follow automatically: NIS2/DORA → Incidents; CRA → Vulnerability register; Data Act → Data portability.

---

## 6. Defaults, limits, numbers

| Thing | Value |
|---|---|
| Built-in checks shipped | **71** — GDPR 15, AI Act 7, ISO 27001 23, NIS2 9, CRA 4, Data Act 4, EAA 3, DORA 3, Machinery 2, PLD 1 |
| Frameworks in the catalogue | 10 built-in + org-defined "custom" |
| Core (always-on) frameworks | GDPR, AI Act, ISO 27001 |
| Severity weights | critical 3 · high 2 · medium 1 · low 0.5 |
| Scheduler | first sweep 90 s after boot, then **every 6 hours**, all orgs sequentially |
| Overview auto-run | only if the newest result is older than 6 h; `/counts` **never** triggers a run |
| `/counts` cache | 60 s per org, `Cache-Control: private, no-store` |
| Attention list | `?limit=` default **5**, max 50 |
| Evidence-chain verification | newest **200** rows |
| "Recently in force" window | 60 days |
| DSR deadline | **30 days** from receipt; extendable **once** by 60 days → `extended_until` = receipt + 90 days |
| DSR urgency threshold | ≤ **5 days** left = urgent |
| DSR public submit rate limit | **5 per hour per IP** |
| DSR public status/verify rate limit | **60 per hour per IP** |
| DSR field caps | notes 2000, extension reason 1000, result summary 4000 characters |
| DSR discovery | ≤ 200 datatables, 2 s per table, KB scan 5 s / 500 rows, memoised 30 s per request |
| Incident clocks | GDPR 72 h · NIS2 24 h / 72 h / 1 month · CRA 24 h / 72 h / 14 days · DORA customer notice default **4 h** |
| Incident severities / kinds | low, medium, high / breach, security_incident, vulnerability |
| Annex A controls | **93** (theme 5 organizational 37, 6 people 8, 7 physical 14, 8 technological 34) |
| Policy templates | **13** (information-security-policy, acceptable-use, access-control, cryptography, incident-response, business-continuity, supplier-security, secure-development, hr-security, asset-management, logging-monitoring, risk-management, exit-procedure) |
| Policy review cadence in the template text | every 12 months |
| Risk scale | likelihood 1–5 × impact 1–5 → score 1–25; **high = score ≥ 10** |
| Evidence connectors | **10** (github, scaleway, openobserve, google-workspace, microsoft-entra, nextcloud, afas, youtrack, mail-security, tls-endpoints); swept **every 6 hours** and on demand |
| Evidence file upload | max **15 MB** per file |
| Access log page | default 100 rows, max 500 |
| Access log export | max **50 000** rows per file, **20 exports per hour per user** |
| Setup wizard | 4 steps; retention default 365 days; residency default `eu` |
| DPIA attestation | described as valid 12 months (`expires_at` on the row) |
| Custom framework attestation | `attestation_valid_months` default 12 |

---

## 7. What happens on failure

- **No organisation on the session** → `403 {error:'no_organisation'}` on the strict routes (`/counts`, `/attention`,
  `/deadlines`, `/frameworks`, `/calendar`, `/access-audit*`). Older routes fall back to the literal org `'default'`.
- **Licence missing** → `403 {error:'feature_locked', feature, required, current, upgrade_url}`; the SPA shows the
  RequireTier upgrade prompt instead of the hub.
- **Framework disabled** → `409 {error:'framework_disabled', regulation, framework}` (e.g. recording a CRA vulnerability
  before enabling CRA — refused rather than starting a clock nobody watches).
- **`/counts` partial** → any kind that throws is **omitted** from the body (never 0) and the body is not cached.
  The rail row then shows its label and no meta.
- **Aggregate endpoint down** → the page renders its own failure line
  (*"Could not read the attention list right now."*, *"The checks could not be read."*, *"The requests could not be read."*).
- **DSR extend twice** → `409 already_extended`. **Acting on a closed request** → `409 not_open`.
  **Fulfil without a summary** → `400 result_summary is required when fulfilling`.
- **Bad verify token** → always the same `400 {error:'invalid_token'}` — a probe learns nothing.
- **Result/extension e-mail fails** → the status change still applies; the timeline gets an `email_failed` row and the
  server logs a warning. The DSR is **not** rolled back.
- **Notify breach recipients with no recipients configured** → `400 {error:'no_breach_recipients', message:'Add breach
  notification recipients under Compliance → Settings first.'}`
- **Access-log export too large** → `413 {error:'…over the 50000 an export carries…', code:'export_too_large', total, max}`.
- **Connector sweep fails** → toast *"Sweep failed — check the credential and settings"*; the connector stays enabled.
- **Enabling a framework whose first sweep fails** → the framework is enabled anyway, response carries `run_error`.
- **Exports switched off (public demo)** → download buttons are hidden, not broken.

---

## 8. How it connects to the rest of Bee Flow

- **Guardrails / Privacy Shield** — `GDPR-Art32-dlp-enabled`, `-dlp-efficacy` and `ISO27001-A.8.12-dlp` read the DLP/PII
  guardrail config *and* the guardrail event log. Remediation links jump to Security → Guardrails (in Settings: Organisation → Privacy).
- **Agents** — published agents are the ROPA's processing activities; high-risk agents drive the DPIA list;
  `AIA-Art50-ai-disclosure` and `AIA-Art13-transparency` inspect agent prompts/config; auto-fix can inject the AI disclosure.
- **Automations / automations** — `AIA-Art50-content-marking` looks at automations that generate content; the marking footer is a
  compliance setting (`ai_content_marking_enabled` / `_footer`) whose every flip is stamped and evidenced.
- **Memory** — the retention window from the setup wizard is enforced for stored memories (the retention job heartbeat is what
  `ISO27001-A.8.10-deletion` checks); DSR discovery counts a subject's memories.
- **Datatables & forms** — DSR discovery scans text/richtext columns and reports `form_answers` tables per automation.
- **Knowledge bases** — DSR discovery scans `kb_chunks`; the asset-inventory check counts KBs.
- **Integrations / token vault** — evidence connectors link to `integration_connections`; observed outbound calls feed the
  processor table and the supplier check.
- **Monitoring / activity log** — `ISO27001-A.8.15-logging` and `A.8.16-monitoring` read the sign-in, integration and guardrail
  ledgers; the **Access log** section reads `access_audit_log` (sign-ins + access-control changes + app publication changes).
- **Learning Center** — Training & competence shows each member's `learning_progress_user_<id>` module count next to their
  policy acknowledgements.
- **Users & roles** — the org directory feeds every owner/auditor/attester picker (`GET /org-users`, only fetched on the
  sections that have a picker); the DPO / ISMS auditor roles are how you give compliance access without full admin.
- **Licensing / modules** — the hub is one module in the marketplace catalog; per-framework capabilities are plan flags.
- **E-mail** — acknowledgement, extension and result letters to the data subject, and the internal breach mail. Per the
  project's BFSF-441 rule, **e-mail to the data subject is the only outbound channel personal data may take.**

---

## 9. Common mistakes

1. **Waiting to record a breach until the facts are clear.** The clock legally starts at *detection*. The form says so.
   Record first, assess in the register.
2. **Thinking "Record authority notification" files with the Autoriteit Persoonsgegevens.** It does not. It is an attestation.
   Same for CRA reports, SCC attestations and training attestations.
3. **Extending a DSR twice.** One extension only (Art. 12(3)); the second attempt is refused with `already_extended`.
4. **Starting the DSR clock from "when we picked it up".** It runs from receipt — that is why **Received on** is a field in
   the capture modal.
5. **Publishing a seeded policy unedited.** The UI warns: *"Auditors spot generic templates instantly."*
6. **Reading a blank rail meta as "zero".** A blank means the number is unknown (endpoint down or key withheld); a real
   "0 open" is printed.
7. **Expecting the SoA seed to fix your decisions.** It only creates missing rows; applicability, justification and approval
   stay human decisions.
8. **Expecting "Needs attention" to be complete when a store is down.** `complete:false` means the list may be short —
   the card says so rather than showing an empty "all good".
9. **Forgetting breach recipients.** Without them, **Notify breach recipients** 400s, and the attention list flags an incident
   clock running with no one to alert.
10. **Assuming a disabled framework's history stays visible.** Rows of a disabled framework are hidden everywhere, including
    old results from before the disable.
11. **Giving a DPO full org-admin rights "so they can see compliance".** `dpo` (and `isms_auditor`) already carry
    `admin_compliance`; the Compliance entry is deliberately outside the org-admin gate.
12. **Looking for the ISO "Readiness" and "Controls" pages.** They were merged into the single **ISO 27001** page
    (readiness numbers → header pill; the five downloads → Overview › Reports). Old links still resolve.
13. **Clicking More frameworks / Data portability in this build** — they render *"This section arrives with the next release"*.
14. **Marking a risk "Accepted" casually.** Accepting a risk is an explicit management decision and is stamped with who and when.

---

## 10. Three scenarios — "Van Dijk Groep" (Dutch SME)

### Scenario 1 — Procurement: a supplier without a signed DPA
Van Dijk Groep's inkoop team started using a US transcription vendor through an integration two months ago. At the next
6-hour sweep `GDPR-Art44-external-transfers` and `ISO27001-A.5.20-suppliers` flip to **fail**, and **Needs attention**
shows *"Supplier and cloud service agreements"* at the top. Marieke (org admin) opens **Processing register (ROPA)**,
scrolls to **Processors**, and finds the vendor with **Location** = US and 412 **Calls** in the last 180 days.
She has procurement sign the SCC/DPA, presses **Attest SCC** on that row, and the cell reads **SCC attested**.
She then presses **Mark as reviewed** and downloads **Download ROPA (PDF)** for the inkoopdossier. Both checks go green on the
next run; the attestation and the PDF hash are in the evidence chain.

### Scenario 2 — HR: an ex-employee asks for deletion
A former monteur mails `privacy@vandijkgroep.nl`: *"verwijder al mijn gegevens"*. Jeroen, the appointed DPO (org role
**Data Protection Officer**, so he sees only Settings → Compliance), opens **Requests (DSR)** → **Record a request**:
kind **Delete my data (Art. 17)**, the address, **Arrived via** = *E-mail to DPO*, **Received on** = yesterday 09:14.
The row appears with a 29-day clock. He clicks it, presses **Start working**, and reads **Found in Bee Flow**: 14 memories,
38 rows in *Verzuimregistratie*, 3 form answers, 0 knowledge-base documents — plus the note *"{n} rows fall under a statutory
retention duty — those are anonymised, not deleted."* (the HR table's lawful basis is legal_obligation with a 7-year retention).
He deletes what can go, anonymises the rest, writes the **Summary of the handling**, and presses
**Fulfil and e-mail the data subject**. The subject gets the letter; the register shows **Completed**; the check
`GDPR-Art17-dsr-deletion` re-runs immediately instead of waiting for the next sweep.

### Scenario 3 — Sales: an AI quote assistant and an enterprise buyer's security questionnaire
Sales publishes a customer-facing "Offerte-assistent" agent. `AIA-Art50-ai-disclosure` fails: the agent does not tell people it
is AI. On the **AI Act** page Marieke uses the row's **Auto-fix** → *"Apply the automatic fix?"* → **Apply fix**; the
disclosure is injected and the change lands in the evidence log. Two weeks later a large customer sends a security
questionnaire. She opens **SoA (Annex A)**, presses **Fill missing rows**, approves the rows that already have a live check
behind them, seeds and customises the **Policies** (starting with the Information Security Policy), plans the first audit under
**Audits & management review**, and then downloads the **Stage-1 document pack** — SoA PDF, Clause conformity PDF, Risk
register PDF, Policy pack PDF and the **Full evidence bundle (ZIP)** — as the answer to the questionnaire. The header pill on
the ISO page tells her how many controls are *continuously verified* versus *attested*, so she does not over-claim.

---

## 11. List/read endpoints a "did the learner do it?" check can call

All are `GET`, all require **session auth + `admin_compliance`**, and everything under `/api/compliance` additionally requires
the `compliance_hub_gdpr` entitlement + the `compliance` module. Org scoping is automatic from the caller's account.

| Method + path | What a row / the body contains | Owner-ish field |
|---|---|---|
| `GET /api/compliance/counts[?keys=a,b]` | `{ attention_open, last_run{at,interval_hours}, frameworks.<id>{score,tone}, frameworks_summary{active,candidates,recently_in_force,locked}, dsr{open,overdue,due_soon}, incidents{open,next_deadline_at,hours_left,vulnerabilities_open}, ropa{last_reviewed_at}, dpia{todo}, risks{total,high}, soa{approved,total}, policies{total,review_due}, audits{planned}, training{done,total}, connectors{count,next_sweep_at}, evidence{rows,chain_ok,algorithm,checked_rows}, onboarded, setup_step }`. Keys are **omitted** when unknown/ungated. | — |
| `GET /api/compliance/overview` | `organization_id, onboarded, settings (full compliance_settings row incl. `dpo_name`/`dpo_email`, `public_dsr_url`), overall{score,total,pass,warn,fail,na}, gdpr/aia/iso, frameworks{<id>:score}, frameworks_detail, verification_summary{automated,attestation,hybrid}, last_run_at, total_checks, first_scan_ran, score_formula` | `settings.dpo_name`, `settings.dpo_email` |
| `GET /api/compliance/checks[?framework=<id>]` | per check: `check_id, regulation, framework_id, frameworks[], in_force_since, article, severity, weight, scope, verification, scope_id, titleKey, descriptionKey, remediationKey, remediationLink, autoFixId, status(pass/warn/fail/not_applicable/pending), details, evidence, run_at` | — |
| `GET /api/compliance/checks/:id/history` | up to 100 past results of one check | — |
| `GET /api/compliance/attention?limit=5` | `{ items[{source:'check'|'register', id, title, severity, status, action{type:auto_fix|open_fix|navigate}, …}], tail[], warn_tail_count, complete }` | — |
| `GET /api/compliance/deadlines` | `{ items[{id, kind(dsr/incident/cra_early_warning/cra_full_report/obligation/attestation_expiry), ref, title, meta, started_at, due_at, state, pct, target}], empty_kinds[], complete, generated_at }` | — |
| `GET /api/compliance/frameworks` | `{ frameworks[{id, regulation, regulation_code, in_force_since, in_force_from, phases[], checks_count, registers[], calendar_count, enabled, core, locked, lock, relevance, relevance_gate, score, score_detail, recently_in_force}], custom[…] }` | — |
| `GET /api/compliance/calendar[?all=1]` | `{ milestones[{id, date, framework_id, kind, label_key, detail_key, relevant, affects, expected}], today_hint }` | — |
| `GET /api/compliance/settings` | the settings row + derived `public_dsr_url` | `dpo_name`, `dpo_email`, `dpo_phone` |
| `GET /api/compliance/ropa` | controller block, `activities[]` (activity/purpose/data categories/retention/transfers + `ai_act` block), `ai_systems[]`, `processors[]` (operator, location, calls, last_seen, scc state) | `settings.ropa_reviewed_by` via `/settings` |
| `GET /api/compliance/dpia` | latest assessment per agent: `id, agent_id, mode, risk_level, approved_by, approved_at, expires_at, created_at` | **`approved_by`** |
| `GET /api/compliance/dpia/:agentId` | one agent's latest DPIA | `approved_by` |
| `GET /api/compliance/incidents[?status=&kind=]` | `id, title, description, severity, kind, regimes[], status, high_risk, occurred_at, detected_at, deadline_at, early_warning_due_at/sent_at, final_report_due_at/sent_at, customer_notice_due_at/customer_notified_at, recipients_notified_at, authority_notified_at/_by/_reference, subjects_notified_at/_by, notes[], created_by, created_at, updated_at` | **`created_by`**, `authority_notified_by`, `subjects_notified_by` |
| `GET /api/compliance/iso/soa` | `{ controls[{ref, key, theme, bucket, titleKey, objectiveKey, checks[], entry}], stats{total,approved,reviewed,todo,excluded}, themes }`; `entry` holds the decision, justification, `how_met`, `evidence_ref`, `updated_by` | **`entry.owner_user_id`**, `entry.updated_by` |
| `GET /api/compliance/iso/soa/history` | the SoA decision trail | actor per row |
| `GET /api/compliance/iso/readiness` | the two ISO numbers + ISMS operating window | — |
| `GET /api/compliance/iso/docs` | `{ documents[{slug, title, status(draft/published), current_version, owner_user_id, review_due_at, ack_count, seeded_from, updated_at}], missing_seeds[] }` | **`owner_user_id`** |
| `GET /api/compliance/iso/docs/:slug` | one document incl. draft body | `owner_user_id` |
| `GET /api/compliance/iso/docs/published/me` | **auth only, no `admin_compliance`** — published docs + whether *this* user acknowledged the current version | the caller |
| `GET /api/compliance/iso/risks` | `{ risks[{id, title, description, category, likelihood, impact, score, status, owner_user_id, review_due_at, created_by, …}], treatments[], stats{total,open,high,overdue} }` | **`owner_user_id`**, `created_by` |
| `GET /api/compliance/iso/audit` | `{ audits[{id,title,scope,auditor_user_id,planned_at,started_at,completed_at,status}], findings[], reviews[], ncs[], objectives[], mr_inputs }` | **`auditor_user_id`** |
| `GET /api/compliance/iso/audit/independence/:userId` | conflicts for a proposed auditor | the user id asked about |
| `GET /api/compliance/iso/training` | `{ personnel[{user_id, displayName, email, policy_acks, policy_total, learning_done, attested_at, attested_note}], obligations[] }` | **`user_id`** |
| `GET /api/compliance/iso/connectors` | per connector: id, titleKey, descKey, coveredControls, credential, enabled, connection_id, settings, last_sweep_at | — |
| `GET /api/compliance/iso/connectors/:id/connections` | vault connections that fit this connector | — |
| `GET /api/compliance/evidence[?regulation=&limit=&offset=]` | evidence ledger rows: `seq, check_id, subject_type, subject_id, captured_at, hash, payload` | `payload.by` (actor) |
| `GET /api/compliance/evidence/:checkId` | the chain for one check | `payload.by` |
| `GET /api/compliance/evidence/chain` | `{ ok, rows_total, verified_rows, … }` integrity report | — |
| `GET /api/compliance/access-audit[?limit=&offset=&action=&from=&to=]` | `{ entries[{action, target_type, target_id, actor_user_id, ip, user_agent, details, created_at}], total, limit, offset, scope }`. 403 `no_organisation` when the caller has no org. | **`actor_user_id`** |
| `GET /api/compliance/access-audit/actions` | `{ actions: [...] }` — only actions that actually occurred | — |
| `GET /api/compliance/score-history` | one row per full sweep: `captured_at, gdpr_score, aia_score, iso_score, scores{<fw>:score}` | — |
| `GET /api/compliance/registry` | the static check catalogue (ids, regulations, articles, severities, verification) | — |
| `GET /api/compliance/portability` | Data Act export matrix per data kind | — |
| `GET /api/compliance/sbom`, `/sbom/meta` | the platform SBOM + its metadata (CRA) | — |
| `GET /api/compliance/ai-act/assessments[/:kind/:id][/signals]` | per-automation/agent AI Act assessment + derived signals | actor stamps on the row |
| `GET /api/compliance/machinery/detections`, `/machinery/subjects/:id/attestations` | industrial-integration detections + attestations | attester per row |
| `GET /api/compliance/custom/frameworks[/:id]`, `/custom/checks/:id/attestations` | org-defined frameworks, their checks and attestations | attester per row |
| `GET /api/compliance/org-users` | org directory for the owner/auditor pickers | `id`, `displayName`, `email` |
| `GET /api/dsr/requests[?status=]` | **masked** rows: `id, request_type, status, notes, result_summary, created_at, fulfilled_at, fulfilled_by, channel, identity_status, identity_verified_at, created_by, started_at, started_by, extended_until, extension_reason, extended_by, extended_at, due_at, subject_user_id, subject_email_masked, days_left, state`. **Never the full address.** | **`created_by` / `started_by` / `fulfilled_by`** |
| `GET /api/dsr/requests/:id` | the full row **including `subject_email`** — and it writes an access-audit row `dsr.subject_viewed` | `fulfilled_by`, plus the viewer is logged |
| `GET /api/dsr/requests/:id/timeline` | `{ id, timeline[{at, by, kind, text}] }` (masked) | `by` |
| `GET /api/dsr/requests/:id/discovery` | read-only scan result: counts per source, table names, deep links, `partial` | — |
| `GET /api/dsr/requests/:id/export` | dossier JSON download (no personal data) | — |

Binary/report endpoints (same auth, not useful as JSON assertions): `GET /api/compliance/report.pdf`, `/ropa.pdf`,
`/dpia/:agentId/pdf`, `/iso/soa.pdf`, `/iso/clause-conformity.pdf`, `/iso/risks.pdf`, `/iso/policy-pack.pdf`,
`/iso/evidence-bundle.zip`, `/access-audit/export`, `/custom/frameworks/:id/export.json`, `/evidence/file/:id`.

Public (no auth, rate-limited) — useful to verify a learner published/used the form:
`POST /api/dsr/requests` (5/h/IP), `GET /api/dsr/requests/:id/public?email=` → `{id, status, request_type, created_at,
due_at, extended_until, fulfilled_at}` (60/h/IP), `POST /api/dsr/requests/:id/verify` (60/h/IP).

**Best single assertions for "did the learner do it?"**
- Setup finished → `GET /api/compliance/counts?keys=onboarded,setup_step` → `onboarded === true`, `setup_step === null`.
- A DSR was recorded/handled → `GET /api/dsr/requests` and look for `channel !== 'public_form'` / `status === 'fulfilled'` +
  a non-empty `result_summary`, `fulfilled_by` = the learner's user id.
- An incident was recorded → `GET /api/compliance/incidents` → a row with `created_by` = learner, `detected_at` set,
  and later `authority_notified_at` / `recipients_notified_at`.
- ROPA reviewed → `GET /api/compliance/counts?keys=ropa` → `ropa.last_reviewed_at != null` (reviewer id via `/settings`).
- SoA progress → `GET /api/compliance/counts?keys=soa` → `soa.approved` increased; owner per row via `/iso/soa`.
- Policy published → `GET /api/compliance/iso/docs` → a doc with `status:'published'`, `current_version >= 1`,
  `owner_user_id` = learner.
- A check was actually run → `GET /api/compliance/overview` → `last_run_at` moved, or `/checks/:id/history` gained a row.
