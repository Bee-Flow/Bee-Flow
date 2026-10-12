---
title: "Audit & compliance"
---

# Audit & compliance

:::warning[Enterprise tier feature]

The Compliance Hub is a licensed feature (`compliance_hub_gdpr`). Self-hosted it requires an Enterprise or Full licence. On Bee Flow Cloud it is governed per subscription plan: the platform operator includes or excludes **Compliance Hub** in a plan's *Included beta features* list, so it can be switched on or off per organisation through the plan its subscription is on.

:::

Paths: **Admin → Compliance**, or for organisation admins and DPOs: **Settings → Organisation → Compliance**. The `dpo` organisation role grants access to the Compliance Hub and monitoring without full admin rights.

## The Compliance Hub

Continuous, automated checks against the GDPR and the EU AI Act — currently **21 checks** (15 GDPR, 6 AI Act), re-evaluated every 6 hours, on relevant events (agent published, DLP config changed, DSR submitted, non-EU transfer observed), and on demand.

Every check declares how its result is established, and the UI labels it:

| Label | Meaning |
|-------|---------|
| **Verified automatically** | Evaluated from live system state and telemetry (encryption env, TLS, guardrail events, activity ledger, DSR SLA…). |
| **Self-attested** | Reflects an administrator's declaration (DPO appointed, ROPA reviewed, AI-literacy training…). The tool cannot verify it independently. |
| **Verified + attested** | Automated evidence combined with an attestation (e.g. observed non-EU transfers × SCC attestations). |

The overall score (0–100, severity-weighted) always shows the split — a passing dashboard supports, but never replaces, legal review.

### Sections

| Section | What it does |
|---------|--------------|
| **Overview** | Score ring, GDPR/AI-Act traffic lights, score-over-time trend, top open items, PDF report download. |
| **GDPR / AI Act** | One card per check: why it matters, how to fix, live evidence, run history with the SHA-256 evidence chain, per-check re-run, and one-click auto-fix where safe (e.g. injecting the Art-50 AI disclosure into agent prompts, behind a confirmation listing the affected agents). |
| **DSR Inbox** | Data-subject requests with the 30-day Art. 12(3) countdown, status workflow, resolution summaries and a JSON data export per request. |
| **Incidents** | Breach registry (Art. 33/34): recording starts the 72-hour clock; email the configured breach recipients; record the authority notification (attestation with reference number) and, for high-risk incidents, the data-subject notification. Bulk-decrypt anomalies create a draft incident automatically. |
| **ROPA** | The Art. 30 register, auto-generated from live configuration (agents → activities, observed egress operators → processors, settings → controller). Review-and-confirm instead of typing; per-operator SCC/DPA attestation; PDF export. |
| **DPIA** | Art. 35 assessments per high-risk agent (heuristic flags automated-decision keywords, PII categories, external models): quick attestation or a short questionnaire (incl. the Art. 26 human-oversight answer); PDF export per assessment. |
| **Settings** | DPO contact, legal bases, data residency, memory-retention window, privacy-notice URL, AI-literacy attestation (Art. 4), breach recipients. A first-run wizard prefills these from your live configuration. Below them, the optional [Chat signals](chat-signals.md) card: counts that show whether the Privacy Shield works in chat, never used to evaluate employees, off by default. |

### Public data-subject request form

Data subjects can submit GDPR requests **without an account** at `/privacy/requests` (rate-limited; the organisation is resolved from the subject's email). Link this page from your privacy notice — the URL is shown under Compliance → Settings. Submissions notify org admins and start the 30-day clock; a public status check by reference number + email is included.

### Deadlines are watched for you

A daily job notifies admins and DPOs about incidents nearing/past the 72-hour window, DSRs older than 25 days, and DPIAs expiring within 30 days.

### Evidence chain & exports

Every check run appends an immutable, SHA-256-hashed row to `compliance_evidence` (Art. 5(2) accountability). Exports are **PDF and JSON only** (no CSV by design):

| Export | Where |
|--------|-------|
| Compliance report (scores, verification split, all checks + evidence hashes) | Overview → *Download report (PDF)* |
| ROPA | ROPA → *Download ROPA (PDF)* |
| DPIA per agent | DPIA → *Download DPIA (PDF)* |
| DSR data export | DSR Inbox → per request (JSON) |

Each PDF footer carries the SHA-256 of its source data, and generating one writes an evidence row — a printed report can be matched against the immutable record it came from.

## What's logged

| Table | What it stores |
|-------|----------------|
| `guardrail_events` | PII / moderation / custom-term violations — categories and action taken, never plaintext content. |
| `integration_activity_log` | Outbound tool/integration calls with destination, operator, geo and EU flag (the data-sovereignty ledger; also feeds the Art-44/28 checks). |
| `compliance_checks` / `compliance_evidence` | Check results time-series + the append-only hashed evidence chain. |
| `dsr_requests`, `compliance_incidents`, `dpia_assessments` | The DSR, incident and DPIA registers. |
| `access_audit_log` | Access-control changes (users, roles, groups, invitations, organisations) **and every authentication event** — see below. |
| `chat_signal_counts` | Only when [chat signals](chat-signals.md) are switched on (off by default): weekly (employees) or daily (website visitors) counts of how the Privacy Shield handled chat messages. No user, conversation or agent, no message text, no values found; 30 to 90 days. |

### Authentication events (ISO/IEC 27001 A.8.15, A.5.16)

Every established session and every refused sign-in writes a row, whichever door
was used: password, OPAQUE, an SSO/OAuth callback, the Nextcloud connector, or a
signup that logs straight in. Each row carries the account, the organisation, the
originating IP address, the user agent, the method, and — for a refusal — a short
reason code (`invalid_credentials`, `throttled`, `account_suspended`,
`mfa_invalid_code`, …).

| Action | When |
|--------|------|
| `login_succeeded` | An unauthenticated session became an authenticated one. |
| `login_failed` | Credentials, or a second factor, were rejected. |
| `login_blocked` | The attempt was refused before credentials decided it — the abuse lockout, or an account whose status revokes access. |

**What a failure row deliberately does not contain: what was typed.** People type
their password into the username field, and an attempt against an account that
does not exist is personal data about someone who is not a user. So the submitted
identifier is never stored; the row carries a keyed, non-reversible fingerprint of
it instead, which is enough to see that the same name was tried nine times tonight
and not enough to read it back. Rows for an identifier that matched no account use
a separate `target_type`, so querying one account's history cannot sweep in
attempts that merely resembled its name.

The fingerprint key is derived from `MASTER_ENCRYPTION_KEY` (or `SESSION_SECRET`).
With neither set the key is random per process and the fingerprints are tagged
`v1-ephemeral`: they then correlate only within one server process, which the tag
says on the row rather than letting the counts be read as installation-wide.

Read them under **Compliance → ISO → Sign-in & access log**, filtered by event,
date and account, with a JSON export beside the table. The view is scoped to
your own organisation: a caller without one is refused rather than shown a
default, and platform-level events (which belong to no organisation) never
appear in an organisation's view.

**Exporting is itself recorded.** A.8.15 asks for logs to be protected, and
"who took a copy of everyone's sign-in times and addresses" is the question
asked after an account turns out to have been compromised — so an export writes
an `access_audit_exported` row naming the person, the filter and the number of
rows. The export is also rate-limited per person.

**Retention is off by default, deliberately.** These rows are evidence, and an
upgrade that silently started purging a customer's access-control history would
be the worst kind of helpful — so nothing is deleted until you say so. Set
`ACCESS_AUDIT_RETENTION_DAYS` to enable a window; it is refused below 365 days,
because a certification body samples roughly three months before Stage 2 but the
access-control evidence an auditor asks for spans the cycle. An unreadable value
keeps everything rather than deleting everything.

Leaving it unset keeps IP addresses indefinitely, which is the safe direction for
evidence and the wrong one for GDPR minimisation. That trade is yours to make;
the product will not make it for you.

Not yet shipped for these rows: a SIEM push. See the roadmap below.

Note (EU AI Act Art. 26(6)): activity logs must be retained at least six months — a dedicated check warns when the observed log span suggests early purging.

## Retention

The **memory retention** window (Compliance → Settings) is enforced automatically for stored user memories by a daily job, with a heartbeat verified by the Art. 5(1)(e) check. Conversation content is **not** auto-deleted; govern it via organisational policy.

## ISO 27001 (Enterprise)

The hub's second framework: switch the rail from **GDPR·AI** to **ISO** for an ISMS workspace built around ISO/IEC 27001:2022. It is designed so that preparing certification needs no separate GRC tool — the honest residue that stays human is listed below.

**Two numbers, never one.** The Readiness page deliberately shows *controls continuously verified* (the automated + connector share of Annex A) and *SoA rows approved* (all 93) separately, plus how long the ISMS has been operating — certification bodies sample roughly three months of history before Stage 2.

### How Bee Flow itself is scanned

The A.8.8 control below reads *your* Dependabot alerts. It is reasonable to ask
what the product does about its own, so, plainly:

| What | Where | Gates a PR? |
|------|-------|-------------|
| Secret scanning (gitleaks over the tree and the new commits, + a test-fixture rule) | `.github/workflows/secret-scan.yml` | Yes; also runs on every push to `main` |
| Dependency advisories, npm | `.github/workflows/dependency-audit.yml` | Yes, as a **ratchet**: the high/critical count may not rise above the committed baseline in `.github/security/audit-baseline.json`; also runs on every push to `main` |
| Dependency updates | `.github/dependabot.yml` — npm, pip and the GitHub Actions themselves | No, it raises PRs |
| Container images (base OS + bundled libraries) | `.github/workflows/image-scan.yml`, weekly against the published images | No, it reports |

The dependency gate ratchets rather than failing on any high advisory because
the tree carries advisories today, and a gate that is red on every pull request
from the day it lands gets switched off within a fortnight — which leaves less
coverage than before it existed. The baseline file is the honest record of where
the tree is; it goes down as Dependabot PRs land, and raising it takes a
deliberate edit with a reason.

- **Controls** — 23 automated checks against live system state (access registry, encryption parameters, logging ledgers, incident register, retention, DLP, suppliers, evidence-chain integrity, mail security, TLS) with the same hash-chained evidence trail as the GDPR checks.
- **SoA** — all 93 Annex A controls as decision rows: applicability, justification, how it is satisfied (continuously verified / via connector / self-attested / inherited from the IaaS provider), owner and review status. Approvals are written to the evidence chain; the PDF is only a render of the rows.
- **Policies** — 12 seeded ISMS document templates (original text) with versioning: publishing freezes a sha256-stamped version that members acknowledge under Settings → Security. The UI nudges until a template is actually customised — auditors spot generic templates instantly.
- **Connectors** — couple external systems for automatic evidence: GitHub (Dependabot SLA, branch protection, PR approvals, secret scanning, CI), Scaleway (backups, network exposure, EU residency), Google Workspace & Microsoft Entra (MFA coverage, dormant accounts), OpenObserve (alert rules, retention), Nextcloud, AFAS (HR feed), YouTrack, plus credential-less SPF/DKIM/DMARC and TLS-certificate probes. Credentials live in the encrypted connections vault; sweeps run every 6 hours and a changed snapshot re-runs the linked checks immediately.
- **Risks** — a register with a 5×5 matrix, treatment plans and recorded acceptance decisions; seedable from live facts (failing checks, unattested non-EU operators).
- **Audit & review** — internal audits with an independence probe (clause 9.2.2: the server flags an auditor who owns what they would audit; the `isms_auditor` role exists for this), findings that cite evidence hashes, an auto-prepared management-review agenda (the 9.3.2 inputs) with human minutes, a nonconformity register with corrective-action and effectiveness clocks, and security objectives.
- **Training** — per-person policy-acknowledgement coverage, platform learning progress and an attestation for external training; plus the obligations calendar (policy reviews, audits, access reviews, pentests) with due-date nudges.
- **Exports** — Statement of Applicability, clause 4–10 conformity statement (with explicit *not recorded* gaps), risk register, policy pack, the full compliance report, and a single evidence-bundle ZIP with a hash manifest for the auditor hand-over.

**What stays human, by design:** the independence of your internal auditor, the penetration test, physical-controls verification, risk judgment and management decisions. The tool records those decisions; it never makes them — and it never claims "certified" or "audit-proof".

## Roadmap (not yet shipped)

- Subject-access-request ZIP bundling across all stores (today: JSON export per DSR).
- SIEM webhook push for guardrail events.
- A retention window and a SIEM push for the authentication events described above (the view and the export shipped).
- Signed daily audit digests.
- An explicit AI-Act risk-tier classifier with manual override (today: the high-risk heuristic behind the DPIA/oversight checks).
- Automatic conversation-content retention enforcement (opt-in, destructive — currently deliberately manual).
- MDM/endpoint connectors (Intune/Jamf) for the device-facing Annex A controls (A.7.9, A.8.1).
- SOC 2 / NIS2 / DORA as additional frameworks on the same control↔check mapping.

## Where to next

- [Chat signals](chat-signals.md) — optional counts that show whether the Privacy Shield works in chat, with their preconditions, notice and objection switches.
- [Privacy shield](../features/privacy-shield.md) — the detection engine that produces guardrail events.
- [Reference → Telemetry](../reference/telemetry.md) — operational metrics.
