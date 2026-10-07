/**
 * Fixtures for the Compliance Center demo.
 *
 * Targets `components/admin/compliance` — the hub at
 * /app/settings/organisation/compliance after the Sep-2026 redesign: the four
 * frameworks this fictional org runs (GDPR, EU AI Act, ISO 27001, DORA), the
 * six it can still switch on, the registers they share (DSR inbox, incidents
 * and vulnerabilities, ROPA, DPIAs, risks, SoA, policies, audits, training,
 * the access log) and the aggregates the shell reads on every screen —
 * /counts for the rail, /attention and /deadlines for the overview,
 * /frameworks and /calendar for the growing set, /evidence for the ledger.
 *
 * WHERE THE DATA COMES FROM
 * The catalog half — 10 frameworks, 18 regulatory milestones, 71 check
 * definitions, 93 Annex A controls, 10 connectors
 * — is GENERATED from the server's own registries into complianceCatalog.js
 * (`cd server && node scripts/genComplianceDemoCatalog.js`). Everything a
 * component turns into an i18n key or a cross-reference therefore matches the
 * product exactly. Hand-copying those was not an option: a wrong titleKey
 * renders as a blank cell rather than an error, and a control whose `checks`
 * array names a check that does not exist quietly empties the SoA's evidence
 * column.
 *
 * The organisation half is invented — Van Dael Assurantiën, a fictional Dutch
 * insurance intermediary. It is written to be recognisable to someone who does
 * this work: a score in the eighties rather than a perfect one, two real
 * failures, a DSR three days from its deadline, a breach that was notified in
 * time and one still inside the 72-hour window.
 *
 * SHAPES ARE DERIVED FROM WHAT THE PAGES READ, not from what looks reasonable.
 * The monitoring fixture shipped five separate bugs of the form "near-miss
 * field name renders a silent zero", so every container here mirrors the
 * server's response literally — `overview.controls.verified`, not
 * `overview.verified`; `eu_count`-style disjoint buckets where the component
 * subtracts. compliance.test.js pins the ones that would fail silently.
 */

import { ACCESS_LOG_ROUTES, accessAuditSeed, logAccess } from './complianceAccessLog';
import {
    CHECK_DEFS, ISO_CONTROLS, ISO_THEMES, ISO_CONNECTORS, FRAMEWORKS, MILESTONES,
} from './complianceCatalog';
import { INCIDENT_OPEN_STATUSES, incidentRoutes, incidentSeed } from './complianceIncidents';
import {
    PROJECT_CHECK_ID, projectActivities, projectSubjects, projectVerdict, ropaProjectRoutes, ropaProjectsSeed,
} from './complianceRopaProjects';
// The hub's own masker, not a second one: the register shows "h.•••@example.nl"
// in exactly the shape the product uses (BFSF-441, artboard 1c).
import { maskEmail } from '../../components/admin/compliance/shared/maskEmail';
// The English dictionary the SERVER reads when it builds "Needs attention"
// (compliance/attention.js: `titles[def.titleKey]`). An attention item carries
// a plain title, not a key, so the fixture resolves it the same way — which is
// also what keeps demo/registry.js's `expectText: 'AI disclosure to users'`
// true by construction rather than by a copied string.
import EN_DEFAULTS from '../../i18n/en-defaults';

const ORG = 'org_demo_vandael';
const now = () => Date.now();
const iso = (msAgo) => new Date(now() - msAgo).toISOString();
const days = (n) => n * 86_400_000;
const hours = (n) => n * 3_600_000;
// `iso(msAgo)` looks BACK, `inDays(n)` looks FORWARD. Both exist because half
// this data is history (a breach detected 19 hours ago) and half is a deadline
// (a review due in six days), and expressing a future date as `iso(-days(6))`
// reads as a typo every time somebody edits it.
const inDays = (n) => new Date(now() + days(n)).toISOString();

/* ── Who is in this fictional organisation ──────────────────────────── */

const ORG_USERS = () => ([
    { id: 'u_marieke', displayName: 'Marieke de Wit', email: 'm.dewit@vandael.example', phone: '+31 20 555 0142', orgRole: 'admin' },
    { id: 'u_joost', displayName: 'Joost Bakker', email: 'j.bakker@vandael.example', phone: '', orgRole: 'member' },
    { id: 'u_farah', displayName: 'Farah El Amrani', email: 'f.elamrani@vandael.example', phone: '', orgRole: 'admin' },
    { id: 'u_pieter', displayName: 'Pieter Hoogendijk', email: 'p.hoogendijk@vandael.example', phone: '', orgRole: 'member' },
    { id: 'u_sanne', displayName: 'Sanne Vermeer', email: 's.vermeer@vandael.example', phone: '', orgRole: 'member' },
    { id: 'u_ruben', displayName: 'Ruben Tak', email: 'r.tak@vandael.example', phone: '', orgRole: 'member' },
]);

/* ── The growing set of frameworks ───────────────────────────────────────
   Which frameworks this org has switched on is a per-org decision the server
   keeps in `compliance_settings.enabled_frameworks`; here it is state, so a
   visitor who enables NIS2 sees its checks appear, its rail row show up and
   its score be computed — the thing the Frameworks page is selling.

   The editorial choice: the three core frameworks plus DORA, because an
   insurance intermediary IS a financial entity under DORA Art. 2(1)(i) and a
   demo that gets that wrong teaches the wrong thing. NIS2 came into force
   30 days ago and the CRA reporting duty 3 days ago — both sit in the
   candidate list wearing the "just in force" badge. Machinery is marked NOT
   relevant with a reason: a broker operates no machinery, and recording that
   decision is what the relevance gate is for. */

const CORE_FRAMEWORK_IDS = ['gdpr', 'aia', 'iso27001'];
const ENABLED_FRAMEWORK_IDS = [...CORE_FRAMEWORK_IDS, 'dora'];

const FRAMEWORK_RELEVANCE = {
    gdpr: 'relevant', aia: 'relevant', iso27001: 'relevant', dora: 'relevant',
    // The EAA applies to consumer e-commerce, which is what the public policy
    // pages are — relevant, but not yet switched on.
    eaa: 'relevant',
    machinery: 'not_relevant',
    nis2: 'unknown', cra: 'unknown', data_act: 'unknown', pld: 'unknown',
};

const RELEVANCE_NOTES = {
    machinery: 'No industrial equipment in scope — the workspace talks to policy and claims systems only.',
};

// "Affects you" on a candidate card. Counts the server derives per org; here
// they describe the same fictional workspace the rest of the fixture does:
// four published assistants, two automations that write documents from AI output,
// one published web page and two live public forms.
const FRAMEWORK_AFFECTS = {
    aia: { automations: 2, agents: 4, webpages: null, forms: null },
    eaa: { automations: null, agents: null, webpages: 1, forms: 2 },
    machinery: { detections: 0, derived_relevance: 'unknown' },
};

const SETTINGS = () => ({
    organization_id: ORG,
    onboarded_at: iso(days(214)),
    dpo_name: 'Marieke de Wit',
    dpo_email: 'privacy@vandael.example',
    dpo_phone: '+31 20 555 0142',
    data_residency: 'eu',
    default_retention_days: 365,
    privacy_notice_url: 'https://vandael.example/privacy',
    legal_bases: ['contract', 'legal_obligation', 'legitimate_interests'],
    breach_recipients: ['privacy@vandael.example', 'j.bakker@vandael.example'],
    ai_literacy_material_url: 'https://vandael.example/intern/ai-basiskennis',
    ai_literacy_confirmed_at: iso(days(51)),
    ropa_reviewed_at: iso(days(23)),
    ropa_reviewed_by: 'u_marieke',
    scc_confirmed_operators: ['OpenAI, L.L.C.'],

    // ── Redesign fields (PLAN.md §1.3) ──
    enabled_frameworks: [...ENABLED_FRAMEWORK_IDS],
    framework_relevance: { ...FRAMEWORK_RELEVANCE },
    // Art. 50(2) content marking is still off — which is exactly why the
    // marking check warns until 2 December 2026 and the AI Act ladder has
    // something to offer ("Enable marking").
    ai_content_marking_enabled: false,
    ai_content_marking_footer: '',
    ai_content_marking_enabled_at: null,
    ai_content_marking_enabled_by: null,
    public_base_url: 'https://vandael.example',
    public_dsr_url: 'https://vandael.example/privacy/verzoek',
    sso_enforces_mfa: true,
    // DORA — the one non-core framework this org runs.
    incident_customer_contacts: ['risk@brandverzekeraar.example', 'ict@levensverzekeraar.example'],
    dora_customer_notice_hours: 4,
    dora_contract_clauses_confirmed_at: null,
    dora_contract_clauses_confirmed_by: null,
    dora_contract_template_url: '',
    machinery_manual_subjects: [],
});

/* ── Check results ──────────────────────────────────────────────────────
   One status map is the source of truth. Anything not named here passes, so
   adding a check to the product does not silently create a failing row in the
   demo — it appears as a pass, and the score stays believable.

   The failures are chosen to be the ones a real organisation actually carries:
   an unwritten policy, an overdue review, a control nobody has evidenced. */

const STATUS_OVERRIDES = {
    // GDPR — the two that genuinely bite most organisations.
    // NB: GDPR-Art35 and AIA-Art26 are per-source; their statuses come from
    // HIGH_RISK_AGENTS below, one row per assistant, not from this map.
    'GDPR-Art30-ropa-reviewed': 'pass',
    'GDPR-Art32-encryption-at-rest': 'pass',
    'GDPR-Art5-1-e-storage-limitation': 'warn',
    // EU AI Act — literacy confirmed, transparency notice still missing.
    'AIA-Art50-ai-disclosure': 'fail',
    // ISO 27001 — an unevidenced control and a supplier review that lapsed.
    'ISO27001-A.5.20-suppliers': 'fail',
    'ISO27001-A.8.8-vuln-mgmt': 'warn',
    'ISO27001-A.8.19-workplace-software': 'not_applicable',
    // DORA — the register and the reporting path are in place; the contract
    // clauses have not been re-confirmed this year.
    'DORA-Art30-contract-clauses': 'warn',
    // NIS2 is NOT enabled, so these two rows do not exist yet. They are here
    // so that switching NIS2 on in the demo surfaces real work — a registration
    // nobody has filed a month after the law started to apply — instead of an
    // instant 100.
    'NIS2-Art3-registration': 'fail',
    'NIS2-Art20-board-approval': 'warn',
};

const DETAILS = {
    'AIA-Art50-ai-disclosure': 'No disclosure text configured. Users are not told they are interacting with an AI system.',
    'ISO27001-A.5.20-suppliers': 'No signed processing agreement on file for 1 of 5 processors.',
    'ISO27001-A.8.8-vuln-mgmt': 'Last dependency scan is 41 days old; the policy says 30.',
    'GDPR-Art5-1-e-storage-limitation': 'Conversation content has no automatic retention limit; only stored memories expire (365 days).',
    'ISO27001-A.8.19-workplace-software': 'No managed endpoints in scope — staff work in the browser and the workspace is the system of record.',
    'DORA-Art30-contract-clauses': 'The Art. 30 clause set has not been confirmed against the current contract template this year.',
    'NIS2-Art3-registration': 'No registration reference on file. Entities in scope had to register with the national authority; the law has applied since 15 August 2026.',
    'NIS2-Art20-board-approval': 'The board has approved the measures, but the management training required by Art. 20(2) is not recorded.',
};

/* ── Per-source checks ──────────────────────────────────────────────────
   Two checks in the registry are `scope: 'per-source'` — GDPR Art. 35 (DPIA)
   and AI Act Art. 26 (human oversight). The runner expands those into ONE ROW
   PER SUBJECT with `scope_id = subject.id` (server/compliance/runner.js:25),
   and the pages depend on that: DpiaPage builds its rows by filtering the
   checks for `check_id === 'GDPR-Art35-dpia-high-risk' && c.scope_id`, reading
   the assistant's name and risk reason out of `evidence`.

   The fixture used to flatten both to a single `scope_id: null` row. The
   result was a demo that contradicted itself in two clicks: the Overview
   listed "DPIA for high-risk agents — 1 of 4 assistants … has no DPIA on
   record", and the DPIA section it linked to said "No high-risk agents
   detected — no DPIA required right now". Neither the missing-route check nor
   the shape tests can see that: the row existed and had the right shape, it
   just had no subject, so the page filtered it away and rendered its empty
   state. Only opening the section shows it.

   Subjects are the four published assistants, classified by the same
   heuristic the server uses (agents/art35-dpia-high-risk.js `_isHighRisk`) —
   the risk_reason strings are its output, not a paraphrase. Statuses are
   DERIVED from the DPIA fixture rather than declared, so the two can never
   disagree about which assistant is missing what. */
const HIGH_RISK_AGENTS = [
    { id: 'agent_claims', label: 'Schadebeoordeling', risk_reason: 'has a system prompt that mentions automated decisions' },
    { id: 'agent_intake', label: 'Polisintake', risk_reason: 'routes data to external provider (openai)' },
    { id: 'agent_helpdesk', label: 'Klantenservice-assistent', risk_reason: 'routes data to external provider (openai)' },
    { id: 'agent_kifid', label: 'Klachtdossier', risk_reason: 'processes PII categories: health, correspondence' },
];

const art35Row = (subject) => {
    const dpia = DPIA().find(d => d.agent_id === subject.id) || null;
    const evidence = { agent_id: subject.id, agent_name: subject.label, risk_reason: subject.risk_reason };
    if (!dpia) {
        return {
            status: 'fail',
            evidence,
            details: `No DPIA on record for "${subject.label}" — required because it ${subject.risk_reason}.`,
        };
    }
    return {
        status: 'pass',
        evidence: { ...evidence, mode: 'questionnaire', approved_at: dpia.approved_at },
        details: `DPIA on record (questionnaire) — last approved ${String(dpia.approved_at).slice(0, 10)}.`,
    };
};

const aia26Row = (subject) => {
    const dpia = DPIA().find(d => d.agent_id === subject.id) || null;
    const evidence = { agent_id: subject.id, agent_name: subject.label, risk_reason: subject.risk_reason };
    if (!dpia) {
        return {
            status: 'fail',
            evidence,
            details: `No current assessment for "${subject.label}" — record who oversees its output (Compliance → DPIA questionnaire, "Human oversight").`,
        };
    }
    return {
        status: 'pass',
        evidence: { ...evidence, human_oversight: dpia.answers.human_oversight },
        details: `Human oversight recorded for "${subject.label}": ${dpia.answers.human_oversight}`,
    };
};

/* The Art. 50(2) marking check is per-source too, but over the AUTOMATIONS that
   write a document out of AI output — the server finds them with
   `signals.listGeneratingAutomations`. Both warn rather than fail: marking is
   only required from 2 December 2026, and the check says so with the number of
   days left, exactly as the server does. */
const DOC_AUTOMATIONS = [
    { id: 'auto_polisbrief', label: 'Polisvoorwaarden-brief', ai_step_ids: ['step_draft'] },
    { id: 'auto_schadebrief', label: 'Schadebesluit-brief', ai_step_ids: ['step_reason'] },
];

const MARKING_DEADLINE = (MILESTONES.find(m => m.id === 'aia_marking_transition_end') || {}).date || '2026-12-02';

const daysUntilMarking = () =>
    Math.max(0, Math.ceil((new Date(`${MARKING_DEADLINE}T00:00:00Z`).getTime() - now()) / days(1)));

const markingRow = (subject) => ({
    status: 'warn',
    evidence: {
        automation_id: subject.id,
        marking_enabled: false,
        generating_steps: [{ id: `${subject.id}_doc`, signal: 'reference', ai_step_ids: subject.ai_step_ids }],
        ai_step_ids: subject.ai_step_ids,
        is_active: true,
        required_from: MARKING_DEADLINE,
        days_until_required: daysUntilMarking(),
    },
    details: `"${subject.label}" writes a document from AI output while content marking is off — required from 2 Dec 2026 (in ${daysUntilMarking()} days).`,
});

const PER_SOURCE = {
    'GDPR-Art35-dpia-high-risk': { subjects: () => HIGH_RISK_AGENTS, row: art35Row },
    'AIA-Art26-human-oversight': { subjects: () => HIGH_RISK_AGENTS, row: aia26Row },
    'AIA-Art50-content-marking': { subjects: () => DOC_AUTOMATIONS, row: markingRow },
    // One row per collaborative project with personal data, judged against its
    // processing record (complianceRopaProjects): the broker channel has none.
    [PROJECT_CHECK_ID]: { subjects: () => projectSubjects(ropaProjectsSeed()), row: (s) => projectVerdict(ropaProjectsSeed(), s.project) },
};

/* The Art. 50 pair carries a NEWER stamp than the sweep: both are re-run by an
   event when the AI settings change (server/compliance/events.js), and this
   org last touched those settings two hours ago. That is not decoration — the
   "Needs attention" list breaks a tie between two failing high-severity checks
   on recency, so this is what puts "AI disclosure to users" at the top of the
   card, where demo/registry.js expects to find it. */
const EVENT_RERUN = new Set(['AIA-Art50-ai-disclosure', 'AIA-Art50-content-marking']);

const rowsForCheck = (d, i) => {
    // Spread the run times over the last sweep so the "last run" column is not
    // 71 identical timestamps.
    const scheduled = EVENT_RERUN.has(d.check_id);
    const run_at = scheduled ? iso(hours(2)) : iso(hours(6) + i * 1_000);
    const run_type = scheduled ? 'event' : 'scheduled';
    const perSource = PER_SOURCE[d.check_id];
    if (perSource) {
        return perSource.subjects().map((subject, j) => {
            const r = perSource.row(subject);
            return {
                ...d,
                scope_id: subject.id,
                scope_type: 'source',
                run_at,
                run_type,
                ...r,
                // The runner stamps the subject's label on the result row
                // (runner._rowEvidence), so each per-subject row names its agent or automation.
                evidence: { ...r.evidence, subject_label: subject.label, sha256: `demo${String(i).padStart(4, '0')}${j}` },
            };
        });
    }
    return [{
        ...d,
        scope_id: null,
        scope_type: 'global',
        status: STATUS_OVERRIDES[d.check_id] || 'pass',
        details: DETAILS[d.check_id] || null,
        evidence: { sha256: `demo${String(i).padStart(4, '0')}` },
        run_at,
        run_type,
    }];
};

/**
 * The rows the runner would have PERSISTED: a disabled framework's checks are
 * not run and not stored (PLAN.md §1.4), so the list is the checks of the
 * enabled frameworks only — which is why enabling NIS2 in the demo makes 9
 * rows appear rather than un-hiding rows that were there all along.
 */
const CHECK_ROWS = (enabled = ENABLED_FRAMEWORK_IDS) => {
    const on = new Set(enabled);
    return CHECK_DEFS.flatMap((d, i) => (on.has(d.framework_id) ? rowsForCheck(d, i) : []));
};

/* ── Scores ─────────────────────────────────────────────────────────────
   Computed with the SERVER'S formula (compliance/score.js), not typed in:
   weight by severity, pass = 1.0, warn = 0.5, fail = 0, not_applicable
   excluded from the denominator. A hand-written score drifts the moment a
   status above changes, and a compliance demo whose arithmetic is wrong is
   worse than no demo. */

const SEVERITY_WEIGHT = { critical: 3, high: 2, medium: 1, low: 0.5 };

const computeScore = (rows) => {
    if (!rows.length) return { score: 0, total: 0, pass: 0, warn: 0, fail: 0, na: 0 };
    let earned = 0, max = 0, pass = 0, warn = 0, fail = 0, na = 0;
    for (const r of rows) {
        const w = SEVERITY_WEIGHT[r.severity] || 1;
        if (r.status === 'not_applicable') { na++; continue; }
        max += w;
        if (r.status === 'pass') { earned += w; pass++; }
        else if (r.status === 'warn') { earned += w * 0.5; warn++; }
        else fail++;
    }
    return { score: max > 0 ? Math.round((earned / max) * 100) : 100, total: rows.length, pass, warn, fail, na };
};

/** The newest stamp in the list — the server's `maxDate(latest, 'run_at')`. */
const lastRunAt = (rows) => rows.reduce(
    (m, r) => (r.run_at && (!m || new Date(r.run_at) > new Date(m)) ? r.run_at : m), null,
);

const verificationSummary = (rows) => {
    const s = { automated: { total: 0, pass: 0 }, attestation: { total: 0, pass: 0 }, hybrid: { total: 0, pass: 0 } };
    for (const r of rows) {
        if (r.status === 'not_applicable') continue;
        const v = s[r.verification] ? r.verification : 'automated';
        s[v].total++;
        if (r.status === 'pass') s[v].pass++;
    }
    return s;
};

/**
 * The rows that count for a regulation — its own checks PLUS the checks of
 * another framework that are tagged into it (`frameworks[]`). Same rule as
 * `routes/compliance/frameworks.js` (`_activeRowsFilter` + `scoresByFramework`)
 * and as the client's `checkSort.checksForRegulation`, so the ISO page, the
 * ISO score and the ISO rail number cannot disagree about which rows they are
 * talking about.
 */
const rowsForRegulation = (rows, regulation) => rows.filter(
    r => r.regulation === regulation || (r.frameworks || []).some(f => f.regulation === regulation),
);

const OVERVIEW = (rows = CHECK_ROWS()) => {
    const forReg = (reg) => rowsForRegulation(rows, reg);
    // Three shapes, exactly as routes/compliance/overview.js sends them:
    // `frameworks` is the plain score, `frameworks_detail` the whole count
    // object, `verification_summary_by_framework` the automated/attestation
    // split. The Overview's score cards read two of the three, so a fixture
    // that shipped only one leaves a card empty without erroring.
    const frameworkScores = {};
    const frameworkDetail = {};
    const frameworkVerification = {};
    for (const f of FRAMEWORKS) {
        // Only a framework whose OWN checks ran carries a score. A disabled
        // one still has rows pointing at it — half the registry is tagged into
        // NIS2 and DORA — and scoring those would put a number on a framework
        // the org never switched on.
        if (!rows.some(r => r.framework_id === f.id)) continue;
        const fRows = forReg(f.regulation);
        const detail = computeScore(fRows);
        frameworkScores[f.id] = detail.score;
        frameworkDetail[f.id] = detail;
        frameworkVerification[f.id] = verificationSummary(fRows);
    }
    return {
        frameworks: frameworkScores,
        frameworks_detail: frameworkDetail,
        verification_summary_by_framework: frameworkVerification,
        organization_id: ORG,
        // TRUE, deliberately. ComplianceHub opens the onboarding wizard over
        // the whole hub when this is falsy — a visitor would land on a
        // four-step setup form instead of the thing the page is selling.
        onboarded: true,
        settings: SETTINGS(),
        overall: computeScore(rows),
        gdpr: computeScore(forReg('GDPR')),
        aia: computeScore(forReg('AIA')),
        iso: computeScore(forReg('ISO27001')),
        verification_summary: verificationSummary(rows),
        last_run_at: lastRunAt(rows),
        total_checks: rows.length,
        first_scan_ran: false,
        score_formula: {
            weights: SEVERITY_WEIGHT,
            rule: 'score = round(sum(weight × statusFactor) / sum(weight) × 100), where statusFactor is 1.0 (pass), 0.5 (warn), 0 (fail). "not_applicable" rows are excluded from the denominator.',
        },
    };
};

// 90 days of history, drifting up to today's real score rather than ending on
// an invented number — a chart that disagrees with the headline is a bug the
// eye catches immediately.
const SCORE_HISTORY = () => {
    const rows = CHECK_ROWS();
    const end = computeScore(rows).score;
    const gdprEnd = computeScore(rows.filter(r => r.regulation === 'GDPR')).score;
    const aiaEnd = computeScore(rows.filter(r => r.regulation === 'AIA')).score;
    const isoEnd = computeScore(rows.filter(r => r.regulation === 'ISO27001')).score;
    const points = [];
    const STEPS = 13;
    for (let i = STEPS; i >= 0; i--) {
        const t = (STEPS - i) / STEPS;
        // Starts at 54, climbs, with a dip where the supplier check began
        // failing — a monotonic line looks generated.
        const dip = i === 4 ? -6 : 0;
        const at = (from, to) => Math.round(from + (to - from) * t) + dip;
        points.push({
            captured_at: iso(days(i * 7)),
            overall_score: at(54, end),
            gdpr_score: at(61, gdprEnd),
            aia_score: at(40, aiaEnd),
            iso_score: at(38, isoEnd),
        });
    }
    return points;
};

/* ── Data-subject requests ──────────────────────────────────────────────
   BE-2 rewrote this register around a clock and an allow-list. Two rules the
   fixture follows literally:

   1. THE LIST NEVER CARRIES A FULL ADDRESS. `subject_email_masked` is the only
      address in a list row (BFSF-441); the full one exists on
      `GET /requests/:id`, the single read that writes an access-audit row —
      and the demo writes that row too, into the access log you can open.
      The legacy inbox still prints `subject_email`, so the fixture puts the
      MASKED string there as well: a demo that renders "undefined · #2417" is
      broken, and a demo that prints a full address contradicts the product.
   2. The 30-day clock is COMPUTED (`due_at = created_at + 30 d`, or the
      extension), never typed, so the countdown on screen is real. */

const DSR_WINDOW_DAYS = 30;
const DSR_EXTENSION_DAYS = 60;

const dsrRow = (o) => ({
    organization_id: ORG,
    request_type: 'access',
    status: 'pending',
    notes: '',
    result_summary: '',
    fulfilled_at: null,
    fulfilled_by: null,
    channel: 'public_form',
    identity_status: 'unverified',
    identity_verified_at: null,
    created_by: null,
    started_at: null,
    started_by: null,
    extended_until: null,
    extension_reason: null,
    extended_by: null,
    extended_at: null,
    subject_user_id: null,
    timeline: [],
    ...o,
    due_at: o.extended_until
        || new Date(new Date(o.created_at).getTime() + days(DSR_WINDOW_DAYS)).toISOString(),
    subject_email_masked: maskEmail(o.subject_email),
    pending: o.status === 'pending' || o.status === 'in_progress',
});

const tl = (kind, at, extra = {}) => ({ kind, at, label_key: `compliance.dsr_timeline_${kind}`, ...extra });

const DSR = () => ([
    dsrRow({
        id: 2417,
        subject_email: 'h.veenstra@example.nl', request_type: 'access',
        status: 'in_progress', created_at: iso(days(27)),
        channel: 'public_form', identity_status: 'verified_email_link', identity_verified_at: iso(days(27) - hours(2)),
        started_at: iso(days(25)), started_by: 'u_marieke',
        notes: 'Policyholder asking for every message in which their claim was discussed.',
        timeline: [
            tl('received', iso(days(27))),
            tl('ack_sent', iso(days(27))),
            tl('identity_verified', iso(days(27) - hours(2))),
            tl('started', iso(days(25)), { by: 'u_marieke' }),
        ],
    }),
    dsrRow({
        id: 2416,
        subject_email: 'a.dekker@example.nl', request_type: 'deletion',
        status: 'pending', created_at: iso(days(9)),
        channel: 'public_form', identity_status: 'unverified',
        notes: 'Submitted through the public form on vandael.example/privacy.',
        timeline: [tl('received', iso(days(9))), tl('ack_sent', iso(days(9)))],
    }),
    dsrRow({
        id: 2415,
        subject_email: 'r.oosterhuis@example.nl', request_type: 'rectification',
        status: 'fulfilled', created_at: iso(days(34)), fulfilled_at: iso(days(21)), fulfilled_by: 'u_marieke',
        channel: 'email_dpo', identity_status: 'verified_manual', identity_verified_at: iso(days(33)),
        started_at: iso(days(33)), started_by: 'u_marieke',
        notes: 'Wrong date of birth in a claim summary.',
        result_summary: 'Corrected in the source record and re-indexed. Confirmed by email.',
        timeline: [
            tl('received', iso(days(34))), tl('identity_verified', iso(days(33)), { by: 'u_marieke' }),
            tl('started', iso(days(33)), { by: 'u_marieke' }),
            tl('fulfilled', iso(days(21)), { by: 'u_marieke' }), tl('result_emailed', iso(days(21))),
        ],
    }),
    dsrRow({
        id: 2414,
        subject_email: 'broker@example.com', request_type: 'portability',
        status: 'rejected', created_at: iso(days(48)), fulfilled_at: iso(days(40)), fulfilled_by: 'u_farah',
        channel: 'email_dpo', identity_status: 'unverified',
        notes: 'Requester could not be identified as the data subject.',
        result_summary: 'Rejected under Art. 12(6): identity not established after two requests for verification.',
        timeline: [
            tl('received', iso(days(48))), tl('note', iso(days(44)), { by: 'u_farah' }),
            tl('rejected', iso(days(40)), { by: 'u_farah' }), tl('result_emailed', iso(days(40))),
        ],
    }),
    dsrRow({
        id: 2413,
        subject_email: 'k.smits@example.nl', request_type: 'objection',
        status: 'fulfilled', created_at: iso(days(61)), fulfilled_at: iso(days(38)), fulfilled_by: 'u_marieke',
        channel: 'phone', identity_status: 'verified_manual', identity_verified_at: iso(days(60)),
        started_at: iso(days(60)), started_by: 'u_marieke',
        // Extended once, with a reason — the only extension GDPR allows, and
        // the one the drawer's "extend" button refuses to repeat.
        extended_until: new Date(now() - days(61) + days(DSR_WINDOW_DAYS + DSR_EXTENSION_DAYS)).toISOString(),
        extension_reason: 'Complex objection: the claim file spans two insurers and a Kifid complaint.',
        extended_by: 'u_marieke', extended_at: iso(days(40)),
        notes: 'Objection to automated triage of a claim.',
        result_summary: 'Automated triage disabled for this policyholder; claims routed to a handler.',
        timeline: [
            tl('received', iso(days(61))), tl('identity_verified', iso(days(60)), { by: 'u_marieke' }),
            tl('started', iso(days(60)), { by: 'u_marieke' }),
            tl('extended', iso(days(40)), { by: 'u_marieke' }), tl('extension_emailed', iso(days(40))),
            tl('fulfilled', iso(days(38)), { by: 'u_marieke' }), tl('result_emailed', iso(days(38))),
        ],
    }),
]);

const DSR_CLOSED = new Set(['fulfilled', 'rejected']);

/** `days_left` + `state` are CLOCKS: computed on read, never stored. */
const dsrClock = (r) => {
    if (DSR_CLOSED.has(r.status) || !r.due_at) return { days_left: null, state: 'none' };
    const left = new Date(r.due_at).getTime() - now();
    const daysLeft = Math.ceil(left / days(1));
    return { days_left: daysLeft, state: left < 0 ? 'overdue' : left <= days(5) ? 'urgent' : 'ok' };
};

/** One list row: the allow-list BE-2 returns — masked address, no timeline. */
const dsrListRow = (r) => {
    const row = { ...r, subject_email: r.subject_email_masked, ...dsrClock(r) };
    delete row.timeline;
    return row;
};

/** The audited detail: the one read that shows the address, timeline included. */
const dsrDetail = (r) => ({ ...r, ...dsrClock(r) });

/* The incident register (rows, clocks and write routes) is complianceIncidents.ts,
   the access log complianceAccessLog.ts, the project records complianceRopaProjects.ts. */

/* ── ROPA ───────────────────────────────────────────────────────────── */

const PROCESSORS = () => ([
    { operator: 'Bee Flow B.V. (self-hosted)', country_code: 'NL', country_name: 'Netherlands', is_eu: true, calls: 18_442, first_seen: iso(days(180)), last_seen: iso(hours(2)) },
    { operator: 'Mistral AI SAS', country_code: 'FR', country_name: 'France', is_eu: true, calls: 9_318, first_seen: iso(days(174)), last_seen: iso(hours(3)) },
    { operator: 'Microsoft Ireland Operations Ltd', country_code: 'IE', country_name: 'Ireland', is_eu: true, calls: 4_106, first_seen: iso(days(151)), last_seen: iso(days(1)) },
    { operator: 'OpenAI, L.L.C.', country_code: 'US', country_name: 'United States', is_eu: false, calls: 1_297, first_seen: iso(days(96)), last_seen: iso(days(2)) },
    { operator: 'Anthropic PBC', country_code: 'US', country_name: 'United States', is_eu: false, calls: 604, first_seen: iso(days(88)), last_seen: iso(days(4)) },
]);

const ACTIVITY_SEEDS = [
    { activity_id: 'agent_claims', name: 'Schadebeoordeling', purpose: 'Drafts a first assessment of a submitted claim against the policy terms, for a handler to check.' },
    { activity_id: 'agent_intake', name: 'Polisintake', purpose: 'Reads an application and extracts the fields a broker would otherwise retype.' },
    { activity_id: 'agent_helpdesk', name: 'Klantenservice-assistent', purpose: 'Answers policyholder questions from the product documentation, with citations.' },
    { activity_id: 'agent_kifid', name: 'Klachtdossier', purpose: 'Assembles the file for a Kifid complaint from the correspondence already on record.' },
];

const ROPA = (state = null) => {
    const processors = PROCESSORS();
    const s = state?.settings || SETTINGS();
    return {
        organization_id: ORG,
        controller: { name: 'Van Dael Assurantiën B.V.', dpo_name: s.dpo_name, dpo_email: s.dpo_email, dpo_phone: s.dpo_phone },
        legal_bases: s.legal_bases,
        data_residency: s.data_residency,
        generated_at: iso(0),
        last_reviewed_at: s.ropa_reviewed_at,
        last_reviewed_by: s.ropa_reviewed_by,
        scc_confirmed_operators: s.scc_confirmed_operators,
        activities: ACTIVITY_SEEDS.map(a => ({
            ...a,
            data_categories: ['Conversation content', 'User profile (when supplied)'],
            data_subjects: ['Authenticated users', 'External data subjects whose data is entered into conversations'],
            recipients: 'Processors listed below',
            transfers: processors.filter(p => !p.is_eu).map(p => p.operator),
            retention: `Stored memories: ${s.default_retention_days} days (enforced automatically). Conversation content: not auto-deleted — governed by organisational policy.`,
            security_measures: [
                'Encryption at rest (envelope AES-256-GCM)',
                'Encryption in transit (TLS)',
                'Access logging via guardrail_events',
                'DLP / PII redaction (where enabled)',
            ],
        })).concat(projectActivities(state?.ropaProjects || ropaProjectsSeed())),
        processors,
    };
};

/* ── DPIAs ──────────────────────────────────────────────────────────── */

// Rows in dpiaStore's shape: the questionnaire's answers under `answers`,
// the measures as a list, and the twelve-month expiry the drawer sets.
const DPIA = () => ([
    {
        id: 4, organization_id: ORG, mode: 'questionnaire', agent_id: 'agent_intake', agent_name: 'Polisintake',
        answers: {
            purpose: 'Extract structured application fields from documents a broker submits.',
            data_categories: 'Name, address, date of birth, policy history. No special categories.',
            automated_decisions: false,
            human_oversight: 'A broker reviews and confirms every extracted field before the application is created.',
        },
        mitigations: ['Runs against the local model', 'PII redaction on', 'Retention capped at 365 days'],
        risk_level: 'low', risk_reason: 'No decision is taken by the system and no special-category data is processed.',
        status: 'approved', approved_at: iso(days(74)), expires_at: iso(-days(291)),
    },
    {
        id: 3, organization_id: ORG, mode: 'questionnaire', agent_id: 'agent_helpdesk', agent_name: 'Klantenservice-assistent',
        answers: {
            purpose: 'Answer policyholder questions from the published product documentation.',
            data_categories: 'Question text, policy number where the caller supplies it.',
            automated_decisions: false,
            human_oversight: 'Answers are drafted for a service agent, who sends them.',
        },
        mitigations: ['Knowledge scoped to published documentation only', 'No claim files in retrieval'],
        risk_level: 'low', risk_reason: 'Retrieval is limited to material that is already public.',
        status: 'approved', approved_at: iso(days(66)), expires_at: iso(-days(299)),
    },
    {
        id: 2, organization_id: ORG, mode: 'questionnaire', agent_id: 'agent_kifid', agent_name: 'Klachtdossier',
        answers: {
            purpose: 'Assemble a complaint file from correspondence already on record.',
            data_categories: 'Correspondence, claim history, health information where the complaint concerns a disability policy.',
            automated_decisions: false,
            human_oversight: 'The file is assembled for a complaints officer, who writes the response.',
        },
        mitigations: ['EU-hosted models only for this assistant', 'Access limited to the complaints group'],
        risk_level: 'medium', risk_reason: 'Special-category data can appear in disability complaints, so the residency restriction is doing real work here.',
        status: 'approved', approved_at: iso(days(38)), expires_at: iso(-days(327)),
    },
]);

/* ── ISO 27001 ──────────────────────────────────────────────────────── */

// Which controls have an SoA decision, and what it is. Everything else is
// still "todo", which is honest for an organisation eight months in.
const SOA_APPROVED = new Set([
    'A.5.1', 'A.5.2', 'A.5.7', 'A.5.9', 'A.5.10', 'A.5.12', 'A.5.15', 'A.5.16', 'A.5.17', 'A.5.18',
    'A.5.23', 'A.5.28', 'A.5.30', 'A.5.34', 'A.6.1', 'A.6.2', 'A.6.3', 'A.6.5', 'A.6.6',
    'A.8.1', 'A.8.2', 'A.8.3', 'A.8.5', 'A.8.7', 'A.8.9', 'A.8.10', 'A.8.12', 'A.8.13',
    'A.8.15', 'A.8.16', 'A.8.20', 'A.8.24',
]);
const SOA_REVIEWED = new Set(['A.5.20', 'A.5.21', 'A.5.24', 'A.5.29', 'A.8.8', 'A.8.28', 'A.8.31', 'A.7.9']);
// Physical controls the organisation does not operate — they sit with the IaaS
// provider. An exclusion has to carry a justification or the row is worthless
// to an auditor, so every excluded control here has one.
const SOA_EXCLUDED = new Set(['A.7.1', 'A.7.2', 'A.7.3', 'A.7.4', 'A.7.5', 'A.7.6', 'A.7.8', 'A.7.11', 'A.7.12', 'A.7.13']);

const CHECKS_BY_CONTROL = () => {
    const byControl = {};
    for (const d of CHECK_DEFS) {
        if (d.regulation !== 'ISO27001') continue;
        // Check ids are ISO27001-<ref>-<slug>; the ref is the middle segment.
        const m = /^ISO27001-(A\.\d+\.\d+)-/.exec(d.check_id);
        if (!m) continue;
        (byControl[m[1]] = byControl[m[1]] || []).push(d.check_id);
    }
    return byControl;
};

const soaEntry = (ref, status) => ({
    control_ref: ref,
    organization_id: ORG,
    applicable: status !== 'excluded',
    status,
    justification: status === 'excluded'
        ? 'Physical premises and media are operated by our IaaS provider (Scaleway, FR). Inherited control; evidenced by the provider’s ISO 27001 certificate.'
        : 'In scope. Implemented and evidenced through the linked automated checks and the ISMS policy set.',
    owner_user_id: status === 'excluded' ? 'u_farah' : 'u_marieke',
    approved_at: status === 'approved' ? iso(days(29)) : null,
    reviewed_at: status === 'todo' ? null : iso(days(29)),
});

const SOA = () => {
    const checksByControl = CHECKS_BY_CONTROL();
    const statusOf = (ref) => (SOA_APPROVED.has(ref) ? 'approved'
        : SOA_REVIEWED.has(ref) ? 'reviewed'
            : SOA_EXCLUDED.has(ref) ? 'excluded' : 'todo');
    const controls = ISO_CONTROLS.map(c => {
        const status = statusOf(c.ref);
        return {
            ref: c.ref, key: c.key, theme: c.theme, bucket: c.bucket,
            titleKey: c.titleKey, objectiveKey: c.objectiveKey,
            checks: checksByControl[c.ref] || [],
            entry: status === 'todo' ? null : soaEntry(c.ref, status),
        };
    });
    return {
        controls,
        stats: {
            total: controls.length,
            approved: SOA_APPROVED.size,
            reviewed: SOA_REVIEWED.size,
            excluded: SOA_EXCLUDED.size,
            todo: controls.length - SOA_APPROVED.size - SOA_REVIEWED.size - SOA_EXCLUDED.size,
        },
        themes: ISO_THEMES,
    };
};

const POLICY_SEEDS = [
    ['isms-scope', 'ISMS scope statement', 'u_marieke'],
    ['information-security-policy', 'Information security policy', 'u_marieke'],
    ['access-control-policy', 'Access control policy', 'u_farah'],
    ['acceptable-use-policy', 'Acceptable use policy', 'u_farah'],
    ['supplier-security-policy', 'Supplier security policy', 'u_joost'],
    ['incident-response-plan', 'Incident response plan', 'u_farah'],
    ['business-continuity-plan', 'Business continuity plan', 'u_joost'],
    ['secure-development-policy', 'Secure development policy', 'u_farah'],
    ['cryptography-policy', 'Cryptography and key management policy', 'u_farah'],
    ['data-retention-policy', 'Data retention and disposal policy', 'u_marieke'],
];

const ISO_DOCS = () => ({
    // Two are still drafts and one review has lapsed. An ISMS in which every
    // policy is published, acknowledged by everyone and in date is not one
    // anybody who does this work would recognise.
    documents: POLICY_SEEDS.map(([slug, title, owner], i) => {
        const published = i < 8;
        return {
            slug, title,
            organization_id: ORG,
            status: published ? 'published' : 'draft',
            current_version: published ? (i === 1 ? 3 : 1) : 0,
            owner_user_id: owner,
            // The supplier policy (i === 4) is 11 days overdue; the rest are
            // spread across the next few months.
            review_due_at: i === 4 ? iso(days(11)) : inDays(38 + i * 21),
            ack_count: published ? [6, 6, 6, 5, 4, 6, 3, 5][i] : 0,
            edited: i === 1,
            updated_at: iso(days(30 + i * 4)),
        };
    }).map((d, i) => {
        // isms_documents keeps the working draft (`draft_body`) on every row;
        // publishing freezes it as the current version. A published policy's
        // draft is its published text, except the security policy, where the
        // owner has an unpublished change waiting (so Publish v4 is offered).
        const body = DOC_BODY(d);
        const draft = i === 1 ? `${body}\n\n## Remote work\n\nWork from home follows the same rules as the office; public Wi-Fi only through the company VPN.` : body;
        return { ...d, draft_body: draft, published_body: d.status === 'published' ? body : null, published_title: d.status === 'published' ? d.title : null };
    }),
    missing_seeds: [],
});

/** A document as ismsDocStore.listDocs serves it: the row, without the demo's frozen copy of the published version. */
const docListRow = ({ published_body: _body, published_title: _title, ...row }) => row;

const ISO_READINESS = () => {
    const rows = CHECK_ROWS().filter(r => r.regulation === 'ISO27001');
    const byCheck = Object.fromEntries(rows.map(r => [r.check_id, r.status]));
    const checksByControl = CHECKS_BY_CONTROL();
    const verifiable = ISO_CONTROLS.filter(c => c.bucket === 'auto' || c.bucket === 'connector');
    let verified = 0, failing = 0, unchecked = 0;
    for (const c of verifiable) {
        const statuses = (checksByControl[c.ref] || []).map(id => byCheck[id]).filter(Boolean);
        if (!statuses.length) { unchecked++; continue; }
        if (statuses.includes('fail')) failing++;
        else if (statuses.every(s => s === 'pass' || s === 'not_applicable')) verified++;
    }
    const docs = ISO_DOCS().documents;
    const published = docs.filter(d => d.status === 'published');
    const soa = SOA().stats;
    return {
        controls: { verifiable_total: verifiable.length, verified, failing, unchecked, catalog_total: ISO_CONTROLS.length },
        soa,
        operating_since: iso(days(214)),
        history_points: SCORE_HISTORY().map(h => ({ captured_at: h.captured_at, score: h.iso_score })),
        policies: {
            published: published.length,
            total: docs.length,
            acknowledgements: published.reduce((s, d) => s + (d.ack_count || 0), 0),
        },
        clauses: [
            { clause: '4', title: 'Context of the organisation', status: 'in_place' },
            { clause: '5', title: 'Leadership', status: 'in_place' },
            { clause: '6', title: 'Planning', status: 'in_place' },
            { clause: '7', title: 'Support', status: 'partial' },
            { clause: '8', title: 'Operation', status: 'in_place' },
            { clause: '9', title: 'Performance evaluation', status: 'partial' },
            { clause: '10', title: 'Improvement', status: 'in_place' },
        ],
    };
};

// Keyed by the catalogue's own ids (ISO_CONNECTORS). The collector writes
// 'ok' with no error, or 'error' with the message (jobs/isoEvidenceCollector
// markSweep); GitHub's last sweep hit the API rate limit. YouTrack is
// configured but switched off.
const CONNECTOR_STATE = {
    afas: { enabled: true, last_status: 'ok', connection_id: 'conn_afas_prod', swept: hours(9), snapshots: 46 },
    'microsoft-entra': { enabled: true, last_status: 'ok', connection_id: 'conn_entra_prod', swept: hours(9), snapshots: 52 },
    'tls-endpoints': { enabled: true, last_status: 'ok', connection_id: null, swept: hours(9), snapshots: 3 },
    github: { enabled: true, last_status: 'error', connection_id: 'conn_github_org', swept: hours(3), snapshots: 7, last_error: 'GitHub API rate limit exceeded — retry on the next sweep' },
    youtrack: { enabled: false, last_status: 'ok', connection_id: 'conn_youtrack', swept: days(20), snapshots: 0 },
};

const ISO_CONNECTOR_ROWS = () => ISO_CONNECTORS.map((c) => {
    const st = CONNECTOR_STATE[c.id];
    return {
        ...c,
        config: st ? {
            enabled: st.enabled,
            connection_id: st.connection_id,
            settings: {},
            last_sweep_at: iso(st.swept),
            last_status: st.last_status,
            last_error: st.last_error || null,
        } : null,
        // routes/compliance/isoConnectors.js: a count of the latest snapshots, for enabled connectors only.
        snapshots: st?.enabled ? st.snapshots : 0,
    };
});

const RISKS = () => {
    const risks = [
        { id: 11, title: 'Policyholder data reaches a model outside the EEA', category: 'confidentiality', description: 'A member selects a US-hosted model for a claim conversation containing health information.', likelihood: 3, impact: 4, status: 'treating', owner_user_id: 'u_marieke', review_due_at: iso(days(34)) },
        { id: 10, title: 'Supplier without a processing agreement', category: 'compliance', description: 'A processor is in use before the DPA is countersigned.', likelihood: 2, impact: 4, status: 'open', owner_user_id: 'u_joost', review_due_at: inDays(6) },
        { id: 9, title: 'Assistant output relied on without review', category: 'integrity', description: 'A handler treats a drafted claim assessment as a decision rather than a draft.', likelihood: 3, impact: 3, status: 'treating', owner_user_id: 'u_farah', review_due_at: iso(days(12)) },
        { id: 8, title: 'Shared credential in a support conversation', category: 'confidentiality', description: 'Members paste credentials into tickets or chats.', likelihood: 2, impact: 3, status: 'treating', owner_user_id: 'u_farah', review_due_at: iso(days(58)) },
        { id: 7, title: 'Knowledge base retains documents past their retention period', category: 'compliance', description: 'Source documents outlive the retention policy because deletion is manual.', likelihood: 3, impact: 2, status: 'open', owner_user_id: 'u_marieke', review_due_at: inDays(21) },
        { id: 6, title: 'Single administrator for the workspace', category: 'availability', description: 'One person holds every administrative permission.', likelihood: 2, impact: 3, status: 'accepted', owner_user_id: 'u_joost', review_due_at: iso(days(90)), accepted_at: iso(days(44)), accepted_by: 'u_joost' },
        { id: 5, title: 'Laptop loss exposes cached exports', category: 'confidentiality', description: 'Exported PDFs are kept in local downloads folders.', likelihood: 2, impact: 2, status: 'closed', owner_user_id: 'u_farah', review_due_at: iso(days(120)) },
    ].map(r => ({
        ...r,
        organization_id: ORG,
        source: 'manual',
        score: r.likelihood * r.impact,
        created_at: iso(days(120)),
        updated_at: r.accepted_at || iso(days(30)),
    }));
    const treatments = [
        { id: 5, risk_id: 11, option: 'mitigate', description: 'Model allowlist per assistant; the claims assistants are pinned to EU-hosted models.', due_at: iso(days(20)), done_at: iso(days(22)), owner_user_id: 'u_marieke' },
        { id: 4, risk_id: 11, option: 'mitigate', description: 'Privacy Shield set to redact health terms before any outbound call.', due_at: inDays(30), done_at: null, owner_user_id: 'u_farah' },
        { id: 3, risk_id: 9, option: 'mitigate', description: 'Assistant output carries a standing "draft — a handler decides" banner, and the handbook says the same.', due_at: iso(days(9)), done_at: iso(days(10)), owner_user_id: 'u_farah' },
        { id: 2, risk_id: 8, option: 'mitigate', description: 'Secret detection on outbound messages; credentials are blocked rather than redacted.', due_at: inDays(14), done_at: null, owner_user_id: 'u_farah' },
        { id: 1, risk_id: 10, option: 'avoid', description: 'Processor suspended until the agreement is signed.', due_at: inDays(3), done_at: null, owner_user_id: 'u_joost' },
    ];
    return { risks, treatments, stats: riskStats(risks) };
};

/** riskStore.getStats, over the rows as they are now: HIGH_SCORE is 10, closed risks drop out of high and overdue. */
const riskStats = (risks) => {
    const by = (status) => risks.filter(r => r.status === status).length;
    return {
        total: risks.length,
        open: by('open'), treating: by('treating'), accepted: by('accepted'), closed: by('closed'),
        high: risks.filter(r => r.score >= 10 && r.status !== 'closed').length,
        overdue_reviews: risks.filter(r => r.status !== 'closed' && r.review_due_at && new Date(r.review_due_at).getTime() < now()).length,
    };
};

const AUDIT = () => {
    const audits = [
        { id: 2, title: 'Internal audit 2026-H1 — Annex A 5, 6 and 8', scope_note: 'Organisational, people and technological controls. Excludes physical (inherited).', auditor_user_id: 'u_joost', status: 'in_progress', planned_at: iso(days(20)), started_at: iso(days(6)), closed_at: null, organization_id: ORG },
        { id: 1, title: 'Internal audit 2025-H2 — full ISMS', scope_note: 'First full pass after the ISMS went live.', auditor_user_id: 'u_joost', status: 'closed', planned_at: iso(days(190)), started_at: iso(days(178)), closed_at: iso(days(160)), organization_id: ORG },
    ];
    const findings = [
        { id: 4, audit_id: 2, clause: 'A.5.20', control_ref: 'A.5.20', severity: 'major', description: 'One processor is in use without a signed processing agreement.', evidence_ref: 'Supplier register, row 5', nonconformity_id: 2, created_at: iso(days(5)) },
        { id: 3, audit_id: 2, clause: 'A.8.8', control_ref: 'A.8.8', severity: 'minor', description: 'Dependency scanning ran 41 days ago; the policy requires 30.', evidence_ref: 'CI history', nonconformity_id: 1, created_at: iso(days(5)) },
        { id: 2, audit_id: 2, clause: '9.3', control_ref: null, severity: 'observation', description: 'Management review minutes record decisions but not the inputs considered.', evidence_ref: 'MR minutes, 12 Feb', nonconformity_id: null, created_at: iso(days(4)) },
        { id: 1, audit_id: 1, clause: 'A.5.15', control_ref: 'A.5.15', severity: 'minor', description: 'Access review for the claims group was not evidenced.', evidence_ref: 'Access review folder', nonconformity_id: null, created_at: iso(days(170)) },
    ];
    const ncs = [
        { id: 2, title: 'Processor without a signed agreement', description: 'Raised from internal audit 2026-H1, finding 4.', severity: 'major', source: 'internal_audit', status: 'corrective_action', owner_user_id: 'u_joost', due_at: iso(days(9)), corrective_action: 'Suspend the processor, countersign the agreement, and add a pre-use gate to the supplier checklist.', effectiveness_review_due_at: inDays(60), effectiveness_confirmed_at: null, effectiveness_confirmed_by: null, closed_at: null, created_at: iso(days(5)) },
        { id: 1, title: 'Dependency scanning behind policy', description: 'Raised from internal audit 2026-H1, finding 3.', severity: 'minor', source: 'internal_audit', status: 'effectiveness_review', owner_user_id: 'u_farah', due_at: iso(days(2)), corrective_action: 'Scan moved into the nightly pipeline rather than a manual step.', effectiveness_review_due_at: inDays(45), effectiveness_confirmed_at: null, effectiveness_confirmed_by: null, closed_at: null, created_at: iso(days(5)) },
    ];
    // Attendees as ReviewsTab stores them: { id, name }, so a former member still reads by name.
    const person = (id) => ({ id, name: ORG_USERS().find(u => u.id === id)?.displayName || id });
    const reviews = [
        {
            id: 2, held_at: iso(days(47)), attendees: ['u_marieke', 'u_joost', 'u_farah'].map(person),
            decisions: 'Approved the SoA as it stands. Agreed to bring the supplier register under the same review cycle as the policy set. Next review in Q3.',
            // The 9.3.2 agenda as it stood on the day (mr_inputs, snapshotted with the minutes).
            inputs: { score_now: 71, score_90d_ago: 54, failing_checks: 3, open_nonconformities: 1, open_incidents: 0, risks_open: 2, risks_high: 1, soa_approved: '28/93', last_internal_audit: iso(days(160)) },
            minutes_evidence_ref: 'MR minutes, Q2', organization_id: ORG,
        },
        { id: 1, held_at: iso(days(168)), attendees: ['u_marieke', 'u_joost'].map(person), decisions: 'ISMS scope confirmed. Accepted the single-administrator risk for one cycle with a named deputy to be appointed.', inputs: {}, minutes_evidence_ref: null, organization_id: ORG },
    ];
    const objectives = [
        { id: 3, title: 'Every applicable Annex A control has an approved SoA decision', measure: 'Approved SoA rows / applicable controls', target: '100%', owner_user_id: 'u_marieke', review_due_at: inDays(40), status: 'active' },
        { id: 2, title: 'No nonconformity open past its due date', measure: 'Overdue nonconformities', target: '0', owner_user_id: 'u_farah', review_due_at: inDays(18), status: 'active' },
        { id: 1, title: 'All staff attest to the security policy set each year', measure: 'Attestations / personnel', target: '100%', owner_user_id: 'u_joost', review_due_at: iso(days(30)), status: 'achieved' },
    ];
    const soa = SOA().stats;
    const risk = RISKS().stats;
    return {
        audits, findings, reviews, ncs, objectives,
        mr_inputs: {
            score_now: computeScore(CHECK_ROWS()).score,
            score_90d_ago: 54,
            failing_checks: CHECK_ROWS().filter(r => r.status === 'fail').length,
            open_nonconformities: ncs.filter(n => n.status !== 'closed').length,
            open_incidents: incidentSeed(ORG).filter(i => INCIDENT_OPEN_STATUSES.includes(i.status)).length,
            risks_open: risk.open,
            risks_high: risk.high,
            soa_approved: `${soa.approved}/${soa.total}`,
            last_internal_audit: audits.filter(a => a.status === 'closed').map(a => a.closed_at).sort().pop() || null,
        },
    };
};

/** An iso_obligations row: the store's defaults around what differs. */
const obligation = ({ id, title, kind, subject, owner, due_at, recur_months }) => ({
    id, organization_id: ORG, title, kind, subject, owner_user_id: owner, due_at, recur_months,
    notify_offsets: [30, 7, 0], completed_at: null, completed_by: null, created_by: 'u_marieke',
    created_at: iso(days(120)), updated_at: iso(days(120)),
});

const TRAINING = () => {
    const publishedTotal = ISO_DOCS().documents.filter(d => d.status === 'published').length;
    const rows = [
        ['u_marieke', 8, 6, iso(days(51))],
        ['u_joost', 8, 5, iso(days(49))],
        ['u_farah', 8, 6, iso(days(51))],
        ['u_pieter', 6, 3, null],
        ['u_sanne', 8, 4, iso(days(12))],
        ['u_ruben', 4, 2, null],
    ];
    const byId = Object.fromEntries(ORG_USERS().map(u => [u.id, u]));
    return {
        personnel: rows.map(([id, acks, learning, attested]) => ({
            user_id: id,
            displayName: byId[id].displayName,
            email: byId[id].email,
            policy_acks: acks,
            policy_total: publishedTotal,
            learning_done: learning,
            attested_at: attested,
            attested_note: attested ? 'Read and understood the security policy set.' : null,
        })),
        // The open obligations (the route lists completed_at IS NULL only), with
        // kinds from the server's OBLIGATION_KINDS (routes/compliance/isoProcess.js).
        // One open row per kind and subject: the store's unique index.
        obligations: [
            obligation({ id: 3, title: 'Annual security awareness refresher', kind: 'training', subject: 'All personnel', owner: 'u_joost', due_at: iso(days(26)), recur_months: 12 }),
            obligation({ id: 2, title: 'Quarterly access review — claims group', kind: 'access_review', subject: 'Claims group', owner: 'u_farah', due_at: iso(days(4)), recur_months: 3 }),
            obligation({ id: 1, title: 'Annual supplier review', kind: 'supplier_review', subject: 'Processors', owner: 'u_joost', due_at: inDays(33), recur_months: 12 }),
        ],
    };
};

/* ═══ The aggregates the redesigned hub reads ════════════════════════════
   /counts, /attention, /deadlines, /frameworks, /calendar and /evidence are
   not separate stories: the server DERIVES all six from the same registers
   this fixture already holds. So they are derived here too. A hand-written
   attention list would keep claiming a check fails after a visitor auto-fixed
   it, and a hand-written count would disagree with the register it sits next
   to — the two bugs this screen cannot afford, because both look deliberate.
   ════════════════════════════════════════════════════════════════════════ */

// sections.js canonical ids, per regulation code (compliance/attention.js).
const SECTION_FOR_REGULATION = {
    GDPR: 'gdpr', AIA: 'aia', ISO27001: 'iso', NIS2: 'nis2', CRA: 'cra', DATA_ACT: 'data_act',
    PLD: 'pld', EAA: 'eaa', DORA: 'dora', MACHINERY: 'machinery', CUSTOM: 'custom',
};

const FRAMEWORK_BY_ID = new Map(FRAMEWORKS.map(f => [f.id, f]));
const FRAMEWORK_BY_REGULATION = new Map(FRAMEWORKS.map(f => [f.regulation, f]));

const MILESTONE_COUNTS = MILESTONES.reduce((acc, m) => {
    acc[m.framework_id] = (acc[m.framework_id] || 0) + 1;
    return acc;
}, {});

const sectionPath = (section) => `/app/admin/compliance/${section}`;
const incidentPath = (id) => `/app/admin/compliance/incidents/${id}`;

/* ── GET /frameworks ─────────────────────────────────────────────────── */

const RECENTLY_IN_FORCE_DAYS = 60;

const recentlyInForce = (f) => {
    if (!f.in_force_since) return false;
    const since = new Date(f.in_force_since).getTime();
    return since <= now() && now() - since <= days(RECENTLY_IN_FORCE_DAYS);
};

const frameworkRow = (f, state) => {
    const enabled = state.frameworks.enabled.includes(f.id);
    const rows = enabled ? rowsForRegulation(state.checks, f.regulation) : [];
    const detail = rows.length ? computeScore(rows) : null;
    return {
        id: f.id,
        regulation: f.regulation,
        name_key: f.name_key,
        regulation_code: f.regulation_code,
        in_force_since: f.in_force_since,
        in_force_from: f.in_force_from,
        phases: f.phases,
        description_key: f.description_key,
        affects_key: f.affects_key,
        affects: FRAMEWORK_AFFECTS[f.id] || null,
        checks_count: f.checks_count,
        registers: f.registers,
        calendar_count: MILESTONE_COUNTS[f.id] || 0,
        enabled,
        core: !!f.core,
        // Nothing is locked in the demo: the entitlements the demo host serves
        // are an enterprise plan, and a lock the visitor cannot explain is
        // worse than no lock at all.
        locked: null,
        lock: null,
        relevance: state.frameworks.relevance[f.id] || 'unknown',
        relevance_gate: !!f.relevance_gate,
        score: detail ? detail.score : null,
        score_detail: detail,
        recently_in_force: recentlyInForce(f),
        sources: f.sources || [],
        legal_review: legalReview(f),
    };
};

// The server's compliance/frameworks.js legalReview, for the demo clock: how
// many days ago the catalogue entry was checked against its sources.
const LEGAL_REVIEW_STALE_DAYS = 90;
const legalReview = (f) => {
    const verified = typeof f.legal_status_verified === 'string' ? f.legal_status_verified : null;
    const ms = verified ? Date.parse(`${verified}T00:00:00Z`) : NaN;
    const age = Number.isFinite(ms) ? Math.max(0, Math.floor((Date.now() - ms) / 86400000)) : null;
    return {
        verified_on: Number.isFinite(ms) ? verified : null,
        age_days: age,
        stale: age === null || age > LEGAL_REVIEW_STALE_DAYS,
        stale_after_days: LEGAL_REVIEW_STALE_DAYS,
        sources: (f.sources || []).length,
    };
};

const catalogueReview = () => {
    const rows = FRAMEWORKS.map(f => ({ id: f.id, ...legalReview(f) }));
    const dated = rows.filter(r => r.verified_on).sort((a, b) => a.verified_on.localeCompare(b.verified_on));
    const unknown = rows.some(r => !r.verified_on);
    return {
        verified_on: unknown ? null : (dated[0]?.verified_on ?? null),
        age_days: unknown ? null : (dated[0]?.age_days ?? null),
        stale: rows.some(r => r.stale),
        stale_ids: rows.filter(r => r.stale).map(r => r.id),
        stale_after_days: LEGAL_REVIEW_STALE_DAYS,
    };
};

const customFrameworkRow = (fw, state) => {
    const checks = state.custom.checks.filter(c => c.framework_id === fw.id);
    const attested = checks.filter(c => latestAttestation(state, c)?.outcome === 'compliant').length;
    return {
        id: `custom:${fw.id}`,
        custom_id: fw.id,
        code: fw.code,
        name: fw.name,
        reference: fw.reference,
        description: fw.description,
        status: fw.status,
        attestation_valid_months: fw.attestation_valid_months,
        checks_count: checks.length,
        attested_count: attested,
        enabled: fw.status === 'active',
        core: false,
        locked: null,
        relevance: 'relevant',
        score: checks.length ? Math.round((attested / checks.length) * 100) : null,
        score_detail: null,
        created_at: fw.created_at,
        updated_at: fw.updated_at,
    };
};

const FRAMEWORKS_BODY = (state) => ({
    frameworks: FRAMEWORKS.map(f => frameworkRow(f, state)),
    custom: state.custom.frameworks.filter(f => f.status !== 'archived').map(f => customFrameworkRow(f, state)),
    catalogue: catalogueReview(),
});

/* ── GET /calendar ───────────────────────────────────────────────────── */

// A milestone is relevant when its framework is enabled, or when it is a
// candidate the org has NOT marked 'not_relevant' (compliance/calendar.js).
const milestoneRelevant = (m, state) => {
    if (state.frameworks.enabled.includes(m.framework_id)) return true;
    return state.frameworks.relevance[m.framework_id] !== 'not_relevant';
};

const CALENDAR_BODY = (state, all = false) => {
    const milestones = MILESTONES.map(m => ({
        id: m.id,
        date: m.date || null,
        framework_id: m.framework_id,
        kind: m.kind,
        label_key: m.label_key,
        detail_key: m.detail_key,
        relevant: milestoneRelevant(m, state),
        affects: m.affects_kind && milestoneRelevant(m, state) ? (FRAMEWORK_AFFECTS[m.framework_id] || null) : null,
        expected: m.expected || null,
        affects_kind: m.affects_kind || null,
    }));
    return {
        milestones: all ? milestones : milestones.filter(m => m.relevant || m.kind === 'uncertain'),
        today_hint: null,
    };
};

/* ── GET /attention ──────────────────────────────────────────────────── */

const ATTENTION_ACTION_KEY = {
    auto_fix: 'compliance.attention_action_auto_fix',
    open_fix: 'compliance.attention_action_open_fix',
    navigate: 'compliance.attention_action_navigate',
};

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS_RANK = { fail: 0, warn: 1 };

/** The title an attention row shows: the check's English title, as the server resolves it. */
const checkTitle = (row) => EN_DEFAULTS[row.titleKey] || row.check_id;

const checkAttentionItem = (row) => {
    const section = SECTION_FOR_REGULATION[row.regulation] || 'overview';
    const rowTarget = `${sectionPath(section)}/${encodeURIComponent(row.check_id)}`;
    const action = row.autoFixId
        ? { type: 'auto_fix', label_key: ATTENTION_ACTION_KEY.auto_fix, target: rowTarget, auto_fix_id: row.autoFixId }
        : {
            type: 'open_fix',
            label_key: ATTENTION_ACTION_KEY.open_fix,
            target: row.remediationLink ? `/app/${String(row.remediationLink).replace(/^\/+/, '')}` : rowTarget,
        };
    return {
        id: `check:${row.check_id}:${row.scope_id || 'global'}`,
        source: 'check',
        code: row.check_id,
        severity: row.severity,
        status: row.status,
        title: checkTitle(row),
        meta: {
            frameworks: (row.frameworks || []).map(f => ({ regulation: f.regulation, ref: f.ref })),
            severity: row.severity,
            verification: row.verification || 'automated',
            detail: row.details || null,
            scope_id: row.scope_id || null,
            run_at: row.run_at || null,
        },
        action,
        _at: new Date(row.run_at).getTime() || 0,
    };
};

const registerAttentionItem = ({ id, code, severity, status, title, detail, section, target, regulation, ref, at }) => ({
    id: `register:${id}`,
    source: 'register',
    code,
    severity,
    status,
    title,
    meta: {
        frameworks: regulation ? [{ regulation, ref }] : [],
        severity,
        verification: 'register',
        detail: detail || null,
    },
    action: { type: 'navigate', label_key: ATTENTION_ACTION_KEY.navigate, target: target || sectionPath(section) },
    _at: at || 0,
});

const ATTENTION = (state, limit = 5) => {
    const items = state.checks
        .filter(r => r.status === 'fail' || r.status === 'warn')
        .map(checkAttentionItem);

    // The registers say things no check says yet (compliance/attention.js).
    for (const r of state.dsr) {
        if (DSR_CLOSED.has(r.status)) continue;
        const due = new Date(r.due_at).getTime();
        const target = `${sectionPath('dsr')}/${r.id}`;
        const common = { section: 'dsr', target, regulation: 'GDPR', ref: 'Art. 12(3)', at: new Date(r.created_at).getTime() };
        if (due < now()) {
            items.push(registerAttentionItem({
                ...common, id: `dsr:${r.id}:overdue`, code: 'dsr_overdue', severity: 'critical', status: 'fail',
                title: `DSR #${r.id} (${r.request_type}) is overdue`,
                detail: 'The 30-day response window has closed.',
            }));
        } else if (due - now() <= days(5)) {
            items.push(registerAttentionItem({
                ...common, id: `dsr:${r.id}:due_soon`, code: 'dsr_due_soon', severity: 'high', status: 'warn',
                title: `DSR #${r.id} (${r.request_type}) is due in ${Math.max(0, Math.ceil((due - now()) / days(1)))} day(s)`,
                detail: 'Fulfil or extend (once, +60 days with a reason) before the window closes.',
            }));
        }
        if (r.identity_status === 'unverified' && now() - new Date(r.created_at).getTime() > days(7)) {
            items.push(registerAttentionItem({
                ...common, id: `dsr:${r.id}:unverified`, code: 'dsr_identity_unverified', severity: 'medium', status: 'warn',
                title: `DSR #${r.id} (${r.request_type}): identity not verified after 7 days`,
                detail: 'Verify the data subject before releasing or deleting data (Art. 12(6)).',
            }));
        }
    }

    const soaStats = state.soa.stats;
    if (soaStats.todo > 0) {
        items.push(registerAttentionItem({
            id: 'soa:todo', code: 'soa_todo', severity: 'medium', status: 'warn',
            title: `${soaStats.todo} Statement-of-Applicability row(s) still to decide`,
            detail: `${soaStats.approved} of ${soaStats.total} controls approved.`,
            section: 'soa', regulation: 'ISO27001', ref: 'cl. 6.1.3(d)', at: 0,
        }));
    }

    for (const o of state.training.obligations) {
        const due = new Date(o.due_at).getTime();
        if (o.completed_at || due >= now()) continue;
        items.push(registerAttentionItem({
            id: `obligation:${o.id}`, code: 'obligation_overdue', severity: 'high', status: 'fail',
            title: `Overdue: ${o.title}`,
            detail: `Due ${o.due_at.slice(0, 10)}.`,
            section: 'training', target: sectionPath('training'),
            regulation: 'ISO27001', ref: 'cl. 9', at: due,
        }));
    }

    for (const a of state.aiAct) {
        if (!a.expires_at || new Date(a.expires_at).getTime() >= now()) continue;
        items.push(registerAttentionItem({
            id: `ai_act:${a.target_kind}:${a.target_id}`, code: 'ai_act_attestation_expired', severity: 'medium', status: 'warn',
            title: `AI Act self-assessment expired (${a.target_kind === 'agent' ? 'agent' : 'automation'})`,
            detail: `Recorded outcome "${a.outcome}" expired ${a.expires_at.slice(0, 10)} — reassess.`,
            section: 'frameworks', target: `${sectionPath('frameworks')}?tab=per_automation`,
            regulation: 'AIA', ref: 'Art. 53', at: new Date(a.expires_at).getTime(),
        }));
    }

    items.sort((a, b) => (STATUS_RANK[a.status] - STATUS_RANK[b.status])
        || ((SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
        || (b._at - a._at));

    const strip = ({ _at, ...rest }) => rest; // eslint-disable-line no-unused-vars
    const rest = items.slice(limit);
    return {
        items: items.slice(0, limit).map(strip),
        total: items.length,
        tail: rest.map(i => ({ id: i.id, title: i.title, severity: i.severity, status: i.status })),
        warn_tail_count: rest.filter(i => i.status === 'warn').length,
        fail_tail_count: rest.filter(i => i.status === 'fail').length,
        complete: true,
        generated_at: iso(0),
    };
};

/* ── GET /deadlines ──────────────────────────────────────────────────── */

const URGENT_BELOW_MS = {
    dsr: days(5),
    incident: hours(24),
    cra_early_warning: hours(6),
    cra_full_report: hours(24),
    obligation: days(7),
    attestation_expiry: days(30),
};

const DEADLINE_ARTICLE = {
    dsr: 'GDPR Art. 12(3)',
    incident: 'GDPR Art. 33',
    cra_early_warning: 'CRA Art. 14(2)(a)',
    cra_full_report: 'CRA Art. 14(2)(b)',
    obligation: 'ISO 27001 cl. 9',
    attestation_expiry: 'AI Act Art. 53',
};

const deadlineItem = (kind, id, ref, title, meta, startedAt, dueAt, target) => {
    const due = dueAt ? new Date(dueAt).getTime() : null;
    const started = startedAt ? new Date(startedAt).getTime() : null;
    let state = 'none';
    let pct = 0;
    if (due != null) {
        if (due <= now()) { state = 'overdue'; pct = 1; } else {
            state = (due - now()) <= URGENT_BELOW_MS[kind] ? 'urgent' : 'ok';
            if (started != null && due > started) pct = Math.round(Math.min(1, Math.max(0, (now() - started) / (due - started))) * 1000) / 1000;
        }
    }
    return {
        id: `${kind}:${id}`,
        kind,
        ref,
        title,
        meta: { article: DEADLINE_ARTICLE[kind], ...meta },
        started_at: startedAt || null,
        due_at: dueAt || null,
        state,
        pct,
        target,
    };
};

const DSR_TITLE = {
    access: 'Access request', deletion: 'Deletion request', rectification: 'Rectification request',
    portability: 'Portability request', restriction: 'Restriction request', objection: 'Objection',
};

const DEADLINE_KINDS = Object.keys(URGENT_BELOW_MS);

const DEADLINES = (state) => {
    const items = [];
    for (const r of state.dsr) {
        if (DSR_CLOSED.has(r.status)) continue;
        items.push(deadlineItem('dsr', r.id, `#${r.id}`, DSR_TITLE[r.request_type] || 'Data-subject request', {
            request_type: r.request_type, status: r.status, identity_status: r.identity_status,
            channel: r.channel, extended: !!r.extended_until,
        }, r.started_at || r.created_at, r.due_at, `${sectionPath('dsr')}/${r.id}`));
    }
    const craOn = state.frameworks.enabled.includes('cra');
    for (const i of state.incidents) {
        if (i.status === 'closed') continue;
        const regimes = i.regimes || [];
        const isCra = i.kind === 'vulnerability' || regimes.includes('CRA');
        const base = { incident_kind: i.kind, regimes, severity: i.severity, reported_via: i.reported_via };
        if (isCra && craOn) {
            if (i.early_warning_due_at && !i.early_warning_sent_at) {
                items.push(deadlineItem('cra_early_warning', i.id, `INC-${i.id}`, i.title,
                    { ...base, stage: 'early_warning' }, i.detected_at, i.early_warning_due_at, incidentPath(i.id)));
            }
            if (i.final_report_due_at && !i.final_report_sent_at) {
                items.push(deadlineItem('cra_full_report', i.id, `INC-${i.id}`, i.title,
                    { ...base, stage: 'full' }, i.detected_at, i.final_report_due_at, incidentPath(i.id)));
            }
        }
        if (i.deadline_at && !i.authority_notified_at && i.kind !== 'vulnerability') {
            items.push(deadlineItem('incident', i.id, `INC-${i.id}`, i.title, base,
                i.detected_at, i.deadline_at, incidentPath(i.id)));
        }
    }
    for (const o of state.training.obligations) {
        if (o.completed_at || !o.due_at) continue;
        items.push(deadlineItem('obligation', o.id, String(o.kind || 'obligation').replace(/_/g, ' '), o.title,
            { kind: o.kind, recur_months: o.recur_months }, null, o.due_at, sectionPath('training')));
    }
    for (const a of state.aiAct) {
        if (!a.expires_at) continue;
        items.push(deadlineItem('attestation_expiry', `${a.target_kind}:${a.target_id}`,
            a.target_kind === 'agent' ? 'Agent' : 'Automation', a.title,
            { target_kind: a.target_kind, target_id: a.target_id, outcome: a.outcome },
            a.attested_at, a.expires_at, `${sectionPath('frameworks')}?tab=per_automation`));
    }
    const rank = { overdue: 0, urgent: 1, ok: 2, none: 3 };
    items.sort((a, b) => (rank[a.state] - rank[b.state])
        || (new Date(a.due_at || 0) - new Date(b.due_at || 0)));
    const present = new Set(items.map(i => i.kind));
    return {
        items,
        empty_kinds: DEADLINE_KINDS.filter(k => !present.has(k)),
        complete: true,
        generated_at: iso(0),
    };
};

/* ── The evidence ledger and its hash chain ──────────────────────────── */

/**
 * A 64-hex string derived from the sequence number. Not a real digest — there
 * is nothing to hash in a fixture — but stable across a reload and different
 * for every row, which is what the ledger, the "sha256 …" line in a check's
 * history and the chain footer all render.
 */
const fakeHash = (n) => {
    let x = (n * 2654435761) % 4294967296;
    let out = '';
    while (out.length < 64) {
        x = (x * 1103515245 + 12345) % 4294967296;
        out += x.toString(16).padStart(8, '0');
    }
    return out.slice(0, 64);
};

const EVIDENCE = (state) => {
    const entries = [];
    const push = (o) => entries.push(o);
    // Collected in any order, then SEALED in the order they were captured:
    // `seq` counts the appends, so a ledger whose sequence numbers disagree
    // with its timestamps is not a chain anybody would believe.
    push({
        check_id: null, subject_type: 'framework', subject_id: 'dora',
        payload: { action: 'enable', framework_id: 'dora', regulation: 'DORA', by: 'u_marieke', at: iso(days(96)) },
        captured_at: iso(days(96)),
    });
    for (const c of state.soa.controls.filter(c => c.entry)) {
        push({
            check_id: null, subject_type: 'soa', subject_id: c.ref,
            payload: { action: 'soa_decision', control_ref: c.ref, status: c.entry.status, by: c.entry.owner_user_id, at: c.entry.reviewed_at },
            captured_at: c.entry.reviewed_at,
        });
    }
    for (const r of state.dsr) {
        push({
            check_id: 'GDPR-Art15-dsr-access', subject_type: 'dsr_request', subject_id: r.id,
            payload: { action: 'dsr_received', id: r.id, type: r.request_type, channel: r.channel, at: r.created_at },
            captured_at: r.created_at,
        });
    }
    for (const i of state.incidents) {
        push({
            check_id: 'GDPR-Art33-breach-detection', subject_type: 'incident', subject_id: i.id,
            payload: { action: 'incident_recorded', incident_id: i.id, kind: i.kind, regimes: i.regimes, severity: i.severity, at: i.detected_at },
            captured_at: i.detected_at,
        });
    }
    for (const r of state.ropaProjects?.registrations || []) {
        // routes/compliance/projectRegistrations.js: ids and the basis only, never the purpose text.
        push({
            check_id: PROJECT_CHECK_ID, subject_type: 'processing-record', subject_id: `project:${r.subject_id}`,
            payload: {
                action: 'project_processing_recorded', project_id: r.subject_id, lawful_basis: r.lawful_basis,
                retention_days: r.retention_days, has_purpose: !!r.purpose, actor: r.confirmed_by, at: r.confirmed_at,
            },
            captured_at: r.confirmed_at,
        });
    }
    for (const a of state.aiAct) {
        push({
            check_id: 'AIA-Art53-model-inventory', subject_type: 'ai_act_assessment', subject_id: `${a.target_kind}:${a.target_id}`,
            payload: { target_kind: a.target_kind, target_id: a.target_id, outcome: a.outcome, actor: a.attested_by, attested_at: a.attested_at },
            captured_at: a.attested_at,
        });
    }
    for (const c of state.checks) {
        push({
            check_id: c.check_id, subject_type: 'check_run', subject_id: c.scope_id || null,
            payload: { status: c.status, run_type: c.run_type, scope_id: c.scope_id || null, at: c.run_at },
            captured_at: c.run_at,
        });
    }
    return entries
        .sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at))
        .map((o, i) => {
            const seq = i + 1;
            return {
                id: seq,
                organization_id: ORG,
                seq,
                prev_hash: seq === 1 ? null : fakeHash(seq - 1),
                payload_hash: fakeHash(seq + 5000),
                hash: fakeHash(seq),
                storage_key: null,
                ...o,
            };
        })
        // Served newest first, the way the store reads it.
        .reverse();
};

const CHAIN = (state) => {
    const rows = state.evidence;
    const head = rows[0] || null;
    return {
        ok: true,
        rows_total: rows.length,
        chained_rows: rows.length,
        pre_chain_rows: 0,
        pre_chain_invalid: 0,
        verified_rows: rows.length,
        first_break: null,
        head: head ? { seq: head.seq, hash: head.hash } : null,
        window: head ? { limit: 500, from_seq: 1, to_seq: head.seq } : null,
        latest_captured_at: head ? head.captured_at : null,
        checked_at: iso(0),
        algorithm: 'SHA-256',
    };
};

/** Evidence rows per framework id — the "Bewijs" tab count in the header. */
const evidenceByFramework = (rows) => {
    const out = {};
    for (const r of rows) {
        if (!r.check_id) continue;
        const reg = String(r.check_id).split('-')[0];
        const f = FRAMEWORK_BY_REGULATION.get(reg);
        if (!f) continue;
        out[f.id] = (out[f.id] || 0) + 1;
    }
    return out;
};

/* ── GET /iso/soa/history ────────────────────────────────────────────── */

const SOA_HISTORY = (state) => state.evidence
    .filter(r => r.subject_type === 'soa')
    .map(r => ({
        id: r.id,
        control_ref: r.subject_id,
        status: r.payload.status,
        changed_at: r.captured_at,
        changed_by: r.payload.by,
        note: 'Decision recorded with the justification on the row.',
    }));

/* ── AI Act assessments (the ladder's register) ──────────────────────── */

const AI_ACT_SIGNALS = {
    'agent:agent_claims': {
        contains_ai: true, customer_facing: false, generates_content: true, disclosure_present: true,
        marking_enabled: false, annex_iii_hint: true, annex_iii_categories: ['insurance'],
        steps: { ai: [{ id: 'prompt', label: 'Schadebeoordeling', type: 'agent', path: [] }], generating: [] },
        surfaces: { published: true },
    },
    'agent:agent_helpdesk': {
        contains_ai: true, customer_facing: true, generates_content: false, disclosure_present: false,
        marking_enabled: false, annex_iii_hint: false, annex_iii_categories: [],
        steps: { ai: [{ id: 'prompt', label: 'Klantenservice-assistent', type: 'agent', path: [] }], generating: [] },
        surfaces: { published: true },
    },
    'automation:auto_polisbrief': {
        contains_ai: true, customer_facing: true, generates_content: true, disclosure_present: false,
        marking_enabled: false, annex_iii_hint: false, annex_iii_categories: [],
        steps: {
            ai: [{ id: 'step_draft', label: 'Draft the letter', type: 'ai_step', path: [] }],
            generating: [{ id: 'auto_polisbrief_doc', label: 'Write the PDF', signal: 'reference', aiStepIds: ['step_draft'], path: [] }],
        },
        surfaces: { form_triggers: 1, form_page_steps: 2, live_form_pages: 1 },
    },
};

const AI_ACT = () => ([
    {
        target_kind: 'agent', target_id: 'agent_claims', title: 'Schadebeoordeling',
        outcome: 'high_risk',
        answers: {
            art5: { answer: 'no', practices: [] },
            art50: { interacts: 'no', disclosure: 'yes', generates: 'yes', marking: 'no' },
            annex_iii: { answer: 'yes', category: 'insurance' },
        },
        attested_by: 'u_marieke', attested_at: iso(days(38)),
        expires_at: new Date(now() - days(38) + days(365)).toISOString(),
        current: true,
        open_duties: ['art50_2_marking'],
    },
    {
        target_kind: 'agent', target_id: 'agent_helpdesk', title: 'Klantenservice-assistent',
        outcome: 'transparency',
        answers: {
            art5: { answer: 'no', practices: [] },
            art50: { interacts: 'yes', disclosure: 'no', generates: 'no', marking: 'unknown' },
            annex_iii: { answer: 'no', category: null },
        },
        attested_by: 'u_farah', attested_at: iso(days(52)),
        expires_at: new Date(now() - days(52) + days(365)).toISOString(),
        current: true,
        open_duties: ['art50_1_disclosure'],
    },
    {
        // Recorded thirteen months ago: expired last month, which is what puts
        // "AI Act self-assessment expired" in the attention list and an
        // overdue clock in the deadlines card.
        target_kind: 'automation', target_id: 'auto_polisbrief', title: 'Polisvoorwaarden-brief',
        outcome: 'transparency',
        answers: {
            art5: { answer: 'no', practices: [] },
            art50: { interacts: 'yes', disclosure: 'no', generates: 'yes', marking: 'no' },
            annex_iii: { answer: 'no', category: null },
        },
        attested_by: 'u_marieke', attested_at: iso(days(395)),
        expires_at: iso(days(30)),
        current: false,
        open_duties: ['art50_1_disclosure', 'art50_2_marking'],
    },
]);

const aiActKey = (kind, id) => `${kind}:${id}`;

const aiActDetail = (state, kind, id) => {
    const row = state.aiAct.find(a => a.target_kind === kind && a.target_id === id) || null;
    const signals = AI_ACT_SIGNALS[aiActKey(kind, id)] || null;
    if (!row) {
        // Never assessed: live signals, no answers — the ladder opens on step 1.
        if (!signals) return null;
        return { target_kind: kind, target_id: id, title: id, signals, answers: null, outcome: null, current: false, history: [] };
    }
    return { ...row, signals, history: [{ ...row }] };
};

/* ── Own frameworks (the custom register) ────────────────────────────── */

const CUSTOM_FRAMEWORK = () => ({
    id: 'cfw_vvg',
    organization_id: ORG,
    code: 'VVG',
    name: 'Gedragscode Verzekeraars',
    reference: 'Verbond van Verzekeraars, editie 2024',
    description: 'The sector code the office signed up to. Nine articles; the five that touch the workspace are attested here every year.',
    attestation_valid_months: 12,
    status: 'active',
    created_at: iso(days(120)),
    updated_at: iso(days(31)),
});

const CUSTOM_CHECKS = () => ([
    ['3.1', 'Klantbelang centraal in geautomatiseerde beoordelingen', 'A handler decides every claim; the assistant drafts.', 'high', true, 'AIA-Art26-human-oversight'],
    ['4.2', 'Transparante communicatie over AI-gebruik', 'Policyholders are told when they are reading AI-drafted text.', 'high', true, null],
    ['5.1', 'Zorgvuldige omgang met gezondheidsgegevens', 'Health data in disability complaints stays with EU-hosted models.', 'critical', true, null],
    ['6.3', 'Klachtbehandeling binnen de Kifid-termijn', 'Complaint files are assembled within the Kifid response window.', 'medium', false, null],
    ['8.1', 'Jaarlijkse zelfevaluatie vastgelegd', 'The board records the yearly self-evaluation against this code.', 'medium', true, null],
].map(([ref, title, description, severity, evidence_required, mapped_check_id], i) => ({
    id: `cck_${ref.replace('.', '_')}`,
    framework_id: 'cfw_vvg',
    ref,
    title,
    description,
    severity,
    evidence_required,
    mapped_check_id,
    sort_order: i,
    check_id: `CUSTOM-VVG-${ref}`,
})));

const CUSTOM_ATTESTATIONS = () => ([
    { ref: '3.1', outcome: 'compliant', at: 31, statement: 'Every claim decision is taken by a handler; the assistant output carries a draft banner.' },
    { ref: '4.2', outcome: 'partial', at: 31, statement: 'The letter template says so; the chat surface does not yet (see AI Act Art. 50).' },
    { ref: '5.1', outcome: 'compliant', at: 31, statement: 'Klachtdossier is pinned to EU-hosted models; Privacy Shield redacts health terms outbound.' },
    { ref: '8.1', outcome: 'compliant', at: 31, statement: 'Recorded in the management review of 47 days ago.' },
].map(({ ref, outcome, at, statement }, i) => ({
    id: `att_${i + 1}`,
    organization_id: ORG,
    check_id: `CUSTOM-VVG-${ref}`,
    subject_id: null,
    outcome,
    statement,
    evidence_refs: [`Management review ${new Date(now() - days(47)).toISOString().slice(0, 10)}`],
    attested_by: 'u_marieke',
    attested_at: iso(days(at)),
    expires_at: new Date(now() - days(at) + days(365)).toISOString(),
    superseded_at: null,
})));

const latestAttestation = (state, check) => state.custom.attestations
    .filter(a => a.check_id === check.check_id && !a.superseded_at)
    .sort((a, b) => new Date(b.attested_at) - new Date(a.attested_at))[0] || null;

const customCheckRow = (state, c) => ({ ...c, latest_attestation: latestAttestation(state, c) });

/* ── GET /portability (Data Act Art. 30) ─────────────────────────────── */

// kind, held, formats, scope, route, gap
const PORTABILITY_ROWS = [
    ['automations', 34, ['json'], 'per-item', 'GET /api/automation/:id/export', null],
    ['datatables', 12, ['csv'], 'per-item', 'GET /api/datatables/:id/rows.csv', null],
    ['studio_apps', 3, ['json'], 'per-item', 'GET /api/studio-apps/:id/data/export', null],
    ['cms_sites', 1, ['zip', 'json'], 'per-item', 'GET /api/cms/sites/:siteId/export', null],
    ['solutions', 2, ['json'], 'per-item', 'POST /api/projects/:id/package/export', null],
    ['meeting_notes', 96, ['md', 'txt'], 'per-item', 'GET /api/transcriptions/:id/export', null],
    ['notebooks', 8, ['docx', 'pdf'], 'per-item', 'POST /api/notebooks/:id/export/docx', null],
    ['dsr_requests', 5, ['json'], 'per-item', 'GET /api/dsr/requests/:id/export', null],
    ['access_audit', 1842, ['json'], 'bulk', 'GET /api/compliance/access-audit/export', null],
    ['compliance_evidence', 0, ['zip'], 'bulk', 'GET /api/compliance/iso/evidence-bundle.zip', null],
    ['memories', 214, ['json'], 'bulk', 'GET /agents/memory/export/all', null],
    ['agents', 4, [], 'per-item', null, 'compliance.pf_gap_agents'],
    ['knowledge_bases', 6, [], 'bulk', null, 'compliance.pf_gap_knowledge_bases'],
    ['conversations', 4187, [], 'bulk', null, 'compliance.pf_gap_conversations'],
    ['ai_webpages', 1, [], 'per-item', null, 'compliance.pf_gap_ai_webpages'],
    ['form_submissions', 268, [], 'bulk', null, 'compliance.pf_gap_form_submissions'],
];

const PORTABILITY = (state) => PORTABILITY_ROWS.map(([kind, held, formats, scope, route, gapKey]) => {
    const [method, path] = route ? route.split(' ') : [null, null];
    return {
        kind,
        label_key: `compliance.pf_kind_${kind}`,
        held: kind === 'compliance_evidence' ? state.evidence.length : held,
        held_scope: kind === 'cms_sites' ? 'platform' : 'org',
        route: route ? { method, path } : null,
        extra_routes: kind === 'notebooks' ? [{ method: 'POST', path: '/api/notebooks/:id/export/pdf' }] : [],
        render_only: kind === 'ai_webpages'
            ? { method: 'POST', path: '/api/webpages/:id/export/pdf', formats: ['pdf'] }
            : null,
        formats,
        scope,
        mounted: !!route,
        gap_key: gapKey,
    };
});

/* ── GET /machinery/detections ───────────────────────────────────────── */

const MACHINERY_CLASSIFICATIONS = ['safety_component', 'monitoring_only', 'not_safety_component'];

// Nothing industrial in an insurance office — and an empty, SCANNED result is
// the answer the Machinery Regulation question deserves, not a blank panel.
const MACHINERY_DETECTIONS = () => ({
    scanned: { custom_integrations: 3, mcp_servers: 2, automations: 34, webhooks: 4 },
    matches: [],
    skipped: [],
    manual_subjects: [],
    classifications: MACHINERY_CLASSIFICATIONS,
});

/* ── GET /counts ─────────────────────────────────────────────────────── */

const SWEEP_INTERVAL_HOURS = 6;

/* server/routes/compliance/counts.js nextIncidentClock: the most urgent OPEN
   clock over every stage of every incident, a stage of its own column winning
   a tie with the rolled-up deadline_at. */
const nextIncidentClock = (incidents) => incidents.flatMap(i => [
    ['early_warning', i.early_warning_due_at, i.early_warning_sent_at],
    ['customer_notice', i.customer_notice_due_at, i.customer_notified_at],
    ['final_report', i.final_report_due_at, i.final_report_sent_at],
    ['authority', i.deadline_at, i.authority_notified_at],
].filter(([, due, done]) => due && !done).map(([stage, due]) => ({ stage, at: new Date(due).getTime() })))
    .reduce((best, c) => (best.at == null || c.at < best.at ? c : best), { at: null, stage: null });

/* counts.js hoursLeft: whole hours rounded away from zero, like deadlineMath. */
const hoursAwayFromZero = (ms) => (ms < 0 ? -1 : 1) * Math.ceil(Math.abs(ms) / hours(1));

const COUNTS = (state) => {
    const enabled = state.frameworks.enabled;
    const isoOn = enabled.includes('iso27001');
    const gdprOn = enabled.includes('gdpr');
    const frameworkScores = {};
    for (const id of enabled) {
        const f = FRAMEWORK_BY_ID.get(id);
        if (!f) continue;
        const rows = rowsForRegulation(state.checks, f.regulation);
        const score = rows.length ? computeScore(rows).score : null;
        frameworkScores[id] = { score, tone: score == null ? 'none' : score >= 80 ? 'good' : score >= 60 ? 'warn' : 'bad' };
    }
    const openDsr = state.dsr.filter(r => !DSR_CLOSED.has(r.status));
    const openIncidents = state.incidents.filter(i => i.status !== 'closed');
    const nextClock = nextIncidentClock(openIncidents);
    const nextDeadline = nextClock.at;
    const docs = state.docs.documents.filter(d => d.status === 'published');
    const personnel = state.training.personnel;
    const connectors = state.connectors.filter(c => c.config?.enabled);
    const lastSweep = connectors
        .map(c => (c.config.last_sweep_at ? new Date(c.config.last_sweep_at).getTime() : 0))
        .sort((a, b) => b - a)[0] || 0;
    const portabilityGaps = PORTABILITY(state).filter(r => !r.mounted).length;

    const body = {
        attention_open: ATTENTION(state, 0).total,
        last_run: { at: lastRunAt(state.checks), interval_hours: SWEEP_INTERVAL_HOURS },
        frameworks: frameworkScores,
        frameworks_summary: {
            active: enabled.length,
            candidates: FRAMEWORKS.length - enabled.length,
            recently_in_force: FRAMEWORKS.filter(f => !enabled.includes(f.id) && recentlyInForce(f)).length,
            locked: 0,
        },
        evidence: {
            rows: state.evidence.length,
            chain_ok: true,
            algorithm: 'SHA-256',
            checked_rows: state.evidence.length,
            by_framework: evidenceByFramework(state.evidence),
        },
        portability: { gaps: portabilityGaps },
        onboarded: true,
        setup_step: null,
    };
    if (gdprOn) {
        body.dsr = {
            open: openDsr.length,
            overdue: openDsr.filter(r => dsrClock(r).state === 'overdue').length,
            due_soon: openDsr.filter(r => dsrClock(r).state === 'urgent').length,
        };
        body.incidents = {
            // getDeadlineStats: "open" is nothing filed with an authority yet.
            open: openIncidents.filter(i => INCIDENT_OPEN_STATUSES.includes(i.status)).length,
            next_deadline_at: nextDeadline == null ? null : new Date(nextDeadline).toISOString(),
            next_stage: nextClock.stage,
            hours_left: nextDeadline == null ? null : hoursAwayFromZero(nextDeadline - now()),
            vulnerabilities_open: enabled.includes('cra')
                ? openIncidents.filter(i => i.kind === 'vulnerability').length
                : null,
        };
        body.ropa = { last_reviewed_at: state.settings.ropa_reviewed_at };
        body.dpia = { todo: HIGH_RISK_AGENTS.length - state.dpia.length };
    }
    if (isoOn) {
        body.risks = (({ total, high }) => ({ total, high }))(riskStats(state.risks.risks));
        body.soa = { approved: state.soa.stats.approved, total: state.soa.stats.total, todo: state.soa.stats.todo };
        body.policies = {
            total: docs.length,
            review_due: docs.filter(d => d.review_due_at && new Date(d.review_due_at).getTime() < now()).length,
        };
        body.audits = { planned: state.audit.audits.filter(a => a.status !== 'closed').length };
        body.training = {
            done: personnel.filter(p => p.policy_acks >= p.policy_total).length,
            total: personnel.length,
        };
        body.connectors = {
            count: connectors.length,
            next_sweep_at: lastSweep ? new Date(lastSweep + hours(SWEEP_INTERVAL_HOURS)).toISOString() : null,
        };
    }
    return body;
};

/* ── Mutable state ──────────────────────────────────────────────────── */

export function createState() {
    const state = {
        settings: SETTINGS(),
        checks: CHECK_ROWS(),
        dsr: DSR(),
        incidents: incidentSeed(ORG),
        dpia: DPIA(),
        soa: SOA(),
        docs: ISO_DOCS(),
        connectors: ISO_CONNECTOR_ROWS(),
        risks: RISKS(),
        audit: AUDIT(),
        training: TRAINING(),
        // ── Redesign state ──
        // Which frameworks are on, and what the org decided about the rest.
        // Enabling one adds its checks; disabling removes them again, because
        // a disabled framework is not run and not persisted (PLAN.md §1.4).
        frameworks: {
            enabled: [...ENABLED_FRAMEWORK_IDS],
            relevance: { ...FRAMEWORK_RELEVANCE },
            notes: { ...RELEVANCE_NOTES },
        },
        aiAct: AI_ACT(),
        custom: {
            frameworks: [CUSTOM_FRAMEWORK()],
            checks: CUSTOM_CHECKS(),
            attestations: CUSTOM_ATTESTATIONS(),
        },
        // The access log (A.8.15) lives in complianceAccessLog: server-shaped rows and actions.
        accessAudit: accessAuditSeed(ORG),
        ropaProjects: ropaProjectsSeed(),
        evidence: [],
    };
    // The ledger is built LAST: every row in it is the trace of something
    // above, so it can only be derived once the rest of the state exists.
    state.evidence = EVIDENCE(state);
    return state;
}

/** Re-derive the evidence ledger after a write, so the chain keeps counting. */
function reseal(state) {
    state.evidence = EVIDENCE(state);
}

/** After a project's record changes: re-run its GDPR-Art30-project-personal-data slot, as the route does. */
function rejudgeProject(state, projectId) {
    const project = state.ropaProjects.projects.find(p => p.project_id === projectId);
    if (project) {
        const v = projectVerdict(state.ropaProjects, project);
        const at = new Date().toISOString();
        state.checks = state.checks.map(c => (c.check_id === PROJECT_CHECK_ID && c.scope_id === `project:${projectId}`
            ? { ...c, ...v, evidence: { ...c.evidence, ...v.evidence }, run_at: at, run_type: 'event' }
            : c));
    }
    reseal(state);
}

const ok = () => ({ ok: true });

/** The next free id in a register: the registers are SERIAL columns, so a number. */
const nextId = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;

/** A demo 4xx: the same body the server sends, so the UI shows its real error. */
const refuse = (error, status = 400, extra = {}) => new Response(
    JSON.stringify({ error, ...extra }),
    { status, headers: { 'Content-Type': 'application/json' } },
);

/* ── Routes ─────────────────────────────────────────────────────────────
   Writes mutate the in-tab state and are gone on reload. They are answered
   rather than 404'd because a compliance screen is mostly buttons — "mark
   reviewed", "record an incident", "attest" — and a demo where every button
   errors teaches a visitor that the product is broken. */

/* Azure service telemetry only exists on Azure deployments; the usage
   section asks for it regardless. Empty is the honest answer, as in the
   monitoring demo. */
const EMPTY_AZURE = Object.fromEntries(
    ['summary', 'by-type', 'by-user'].map((ep) => [`GET /api/usage/azure-services/${ep}`, ep === 'summary' ? () => ({}) : () => ([])]),
);

/** Route params are strings; the registers' ids are numbers, as the server's SERIAL columns are. */
const sameId = (a, b) => String(a) === String(b);

export const ROUTES = {
    ...EMPTY_AZURE,
    'GET /api/compliance/overview': ({ state }) => ({ ...OVERVIEW(state.checks), settings: state.settings }),
    'GET /api/compliance/checks': ({ state, query }) => {
        const fw = query.get('framework');
        if (!fw) return state.checks;
        const f = FRAMEWORK_BY_ID.get(fw);
        return f ? rowsForRegulation(state.checks, f.regulation) : [];
    },
    'GET /api/compliance/score-history': () => SCORE_HISTORY(),

    /* ── The five aggregates the shell reads (PLAN.md §1.2) ───────────── */

    // The rail's numbers, the settings badge and the header pills — one cheap
    // read, derived from the same state the registers serve. `?keys=` filters
    // it exactly as the server does for the settings-nav badge.
    'GET /api/compliance/counts': ({ state, query }) => {
        const body = COUNTS(state);
        const keys = query.get('keys');
        if (!keys) return body;
        const wanted = keys.split(',').map(s => s.trim()).filter(Boolean);
        return Object.fromEntries(wanted.filter(k => k in body).map(k => [k, body[k]]));
    },
    'GET /api/compliance/attention': ({ state, query }) => {
        const raw = query.get('limit');
        const limit = raw === null ? 5 : Math.min(50, Math.max(0, parseInt(raw, 10) || 0));
        return ATTENTION(state, limit);
    },
    'GET /api/compliance/deadlines': ({ state }) => DEADLINES(state),
    'GET /api/compliance/calendar': ({ state, query }) => CALENDAR_BODY(state, query.get('all') === '1'),
    'GET /api/compliance/frameworks': ({ state }) => FRAMEWORKS_BODY(state),

    // Enabling a framework is the one mutation on this page with visible
    // consequences everywhere else: its checks are run and stored, its score
    // appears, its rail row shows up, its calendar dates stop being filtered
    // away and an evidence row records who switched it on.
    'POST /api/compliance/frameworks/:id/enable': ({ state, params }) => {
        const f = FRAMEWORK_BY_ID.get(params.id);
        if (!f) return refuse('unknown_framework');
        if (!state.frameworks.enabled.includes(f.id)) {
            state.frameworks.enabled = [...state.frameworks.enabled, f.id];
            state.checks = CHECK_ROWS(state.frameworks.enabled);
            state.settings = { ...state.settings, enabled_frameworks: [...state.frameworks.enabled] };
            reseal(state);
        }
        return { framework: frameworkRow(f, state) };
    },
    'POST /api/compliance/frameworks/:id/disable': ({ state, params }) => {
        const f = FRAMEWORK_BY_ID.get(params.id);
        if (!f) return refuse('unknown_framework');
        // GDPR, the AI Act and ISO 27001 are always on — the server answers
        // 400 framework_core rather than pretending the switch did something.
        if (f.core) return refuse('framework_core');
        state.frameworks.enabled = state.frameworks.enabled.filter(id => id !== f.id);
        state.checks = CHECK_ROWS(state.frameworks.enabled);
        state.settings = { ...state.settings, enabled_frameworks: [...state.frameworks.enabled] };
        reseal(state);
        return { framework: frameworkRow(f, state) };
    },
    'POST /api/compliance/frameworks/:id/relevance': ({ state, params, body }) => {
        const f = FRAMEWORK_BY_ID.get(params.id);
        if (!f) return refuse('unknown_framework');
        state.frameworks.relevance = { ...state.frameworks.relevance, [f.id]: body?.relevance || 'unknown' };
        if (body?.note) state.frameworks.notes = { ...state.frameworks.notes, [f.id]: String(body.note) };
        state.settings = { ...state.settings, framework_relevance: { ...state.frameworks.relevance } };
        return { framework: frameworkRow(f, state) };
    },
    'GET /api/compliance/settings': ({ state }) => state.settings,
    'PUT /api/compliance/settings': ({ state, body }) => {
        state.settings = { ...state.settings, ...(body || {}) };
        return state.settings;
    },
    'POST /api/compliance/settings/onboarded': ({ state }) => {
        state.settings = { ...state.settings, onboarded_at: new Date().toISOString() };
        return state.settings;
    },
    'POST /api/compliance/auto-detect-settings': ({ state }) => state.settings,
    'GET /api/compliance/org-users': () => ORG_USERS(),

    // A scan re-runs against the same fictional configuration, so the result
    // is the same list with fresh timestamps — not new random statuses.
    'POST /api/compliance/checks/run': ({ state }) => {
        // The whole sweep moves forward by the same delta, so the rows keep
        // the order they finished in. Stamping all 54 with one identical
        // `now` would reshuffle "Needs attention", which breaks ties on
        // recency — the list would reorder for no reason a visitor can see.
        const delta = now() - new Date(lastRunAt(state.checks)).getTime();
        state.checks = state.checks.map(c => ({
            ...c,
            run_at: new Date(new Date(c.run_at).getTime() + delta).toISOString(),
            run_type: 'manual',
        }));
        reseal(state);
        return { ...OVERVIEW(state.checks), settings: state.settings };
    },
    'POST /api/compliance/checks/:id/run': ({ state, params }) => {
        state.checks = state.checks.map(c => (c.check_id === params.id ? { ...c, run_at: new Date().toISOString() } : c));
        return ok();
    },
    'POST /api/compliance/checks/:id/auto-fix': ({ state, params }) => {
        state.checks = state.checks.map(c => (c.check_id === params.id
            ? { ...c, status: 'pass', details: 'Fixed from this screen.', run_at: new Date().toISOString() }
            : c));
        return { fixed: true };
    },
    // One trail per slot, as compliance_checks keeps it: the newest row is the
    // slot's current result, older runs behind it. `?scope_id=` narrows it to
    // one subject's slot, as the server does (getCheckHistory).
    'GET /api/compliance/checks/:id/history': ({ state, params, query }) => {
        const scope = query.get('scope_id');
        const slots = (state.checks || []).filter(c => c.check_id === params.id);
        const trail = (slot) => {
            const scope_id = slot?.scope_id ?? null;
            const status = slot?.status || 'pass';
            return [
                { check_id: params.id, scope_id, status, run_at: slot?.run_at || iso(hours(6)), run_type: slot?.run_type || 'scheduled', details: slot?.details ?? null },
                { check_id: params.id, scope_id, status: status === 'fail' ? 'fail' : 'pass', run_at: iso(days(7)), run_type: 'scheduled', details: null },
                { check_id: params.id, scope_id, status: 'warn', run_at: iso(days(14)), run_type: 'scheduled', details: 'First observed as a warning.' },
            ];
        };
        const rows = (slots.length ? slots : [null]).flatMap(trail);
        return scope ? rows.filter(r => r.scope_id === scope) : rows;
    },
    /* ── The evidence ledger ──────────────────────────────────────────
       Order matters here: the transport matches the FIRST route whose
       pattern fits, so `/evidence` and `/evidence/chain` must be declared
       above `/evidence/:checkId` — otherwise "chain" is read as a check id,
       which is the same trap the server's router carries a comment about. */
    'GET /api/compliance/evidence': ({ state, query }) => {
        const regulation = query.get('regulation');
        const limit = Math.min(200, Math.max(1, parseInt(query.get('limit'), 10) || 50));
        const offset = Math.max(0, parseInt(query.get('offset'), 10) || 0);
        const all = regulation
            ? state.evidence.filter(r => String(r.check_id || '').startsWith(`${regulation}-`))
            : state.evidence;
        return { rows: all.slice(offset, offset + limit), total: all.length, limit, offset };
    },
    'GET /api/compliance/evidence/chain': ({ state }) => CHAIN(state),
    'GET /api/compliance/evidence/:checkId': ({ state, params }) =>
        state.evidence.filter(r => r.check_id === params.checkId),

    /* ── Data-subject requests (BE-2's surface) ───────────────────────── */

    'GET /api/dsr/requests': ({ state, query }) => {
        const status = query.get('status');
        const rows = status ? state.dsr.filter(r => r.status === status) : state.dsr;
        return rows.map(dsrListRow);
    },
    // A manual capture: the DPO writes down a request that arrived by phone or
    // by letter. The 30-day clock starts at receipt, not at the moment of
    // typing, which is why `received_at` is honoured when it is given.
    'POST /api/dsr/requests/manual': ({ state, body }) => {
        const created = body?.received_at || new Date().toISOString();
        const row = dsrRow({
            id: nextId(state.dsr),
            subject_email: body?.subject_email || 'onbekend@example.nl',
            request_type: body?.request_type || 'access',
            status: 'pending',
            created_at: created,
            channel: body?.channel || 'email_dpo',
            // A request a DPO recorded in person is verified by that act.
            identity_status: 'verified_manual',
            identity_verified_at: created,
            created_by: 'u_marieke',
            notes: body?.notes || '',
            timeline: [tl('received', created), tl('identity_verified', created, { by: 'u_marieke' })],
        });
        state.dsr = [row, ...state.dsr];
        reseal(state);
        return dsrListRow(row);
    },
    'GET /api/dsr/requests/:id/timeline': ({ state, params }) => {
        const r = state.dsr.find(x => sameId(x.id, params.id));
        return { id: r ? r.id : Number(params.id), timeline: r ? r.timeline : [] };
    },
    // The read-only subject scan. Counts only, no addresses, and one source
    // the product deliberately does NOT scan — saying so is the point.
    'GET /api/dsr/requests/:id/discovery': ({ state, params }) => {
        const r = state.dsr.find(x => sameId(x.id, params.id));
        if (!r) return null;
        return {
            subject: { email_masked: r.subject_email_masked, user_id: null },
            sources: [
                { kind: 'user_account', count: 0, label_key: 'compliance.dsr_discovery_user_account', href: null },
                { kind: 'memories', count: 0, label_key: 'compliance.dsr_discovery_memories', href: null },
                { kind: 'datatable_rows', count: 4, label_key: 'compliance.dsr_discovery_datatable_rows', href: 'admin/studio/datatables' },
                { kind: 'form_answers', count: 2, label_key: 'compliance.dsr_discovery_form_answers', href: 'admin/studio/forms' },
                { kind: 'kb_chunks', count: 1, label_key: 'compliance.dsr_discovery_kb_chunks', href: 'admin/knowledge' },
                { kind: 'prior_dsrs', count: 0, label_key: 'compliance.dsr_discovery_prior_dsrs', href: 'admin/compliance/dsr' },
            ],
            retention_notes: [
                'Claim records are kept for 7 years under the Wft — a deletion request is answered with a restriction for those.',
            ],
            not_scanned: ['conversations'],
            partial: false,
            errors: [],
            scanned_at: iso(0),
        };
    },
    'POST /api/dsr/requests/:id/start': ({ state, params }) => {
        const at = new Date().toISOString();
        state.dsr = state.dsr.map(r => (sameId(r.id, params.id)
            ? { ...r, status: 'in_progress', started_at: r.started_at || at, started_by: 'u_marieke', timeline: [...r.timeline, tl('started', at, { by: 'u_marieke' })] }
            : r));
        return dsrListRow(state.dsr.find(r => sameId(r.id, params.id)));
    },
    // Art. 12(3) allows ONE extension of two months, with a reason. The
    // second attempt is refused with the same 409 the server sends, because a
    // demo that lets you extend twice teaches the wrong rule.
    'POST /api/dsr/requests/:id/extend': ({ state, params, body }) => {
        const r = state.dsr.find(x => sameId(x.id, params.id));
        if (!r) return refuse('not_found', 404);
        if (r.extended_at) return refuse('already_extended', 409);
        if (DSR_CLOSED.has(r.status)) return refuse('not_open', 409);
        if (!body?.reason) return refuse('reason_required');
        const at = new Date().toISOString();
        const until = new Date(new Date(r.created_at).getTime() + days(DSR_WINDOW_DAYS + DSR_EXTENSION_DAYS)).toISOString();
        const next = {
            ...r, extended_until: until, due_at: until, extension_reason: String(body.reason),
            extended_by: 'u_marieke', extended_at: at,
            timeline: [...r.timeline, tl('extended', at, { by: 'u_marieke' }), tl('extension_emailed', at)],
        };
        state.dsr = state.dsr.map(x => (x.id === r.id ? next : x));
        reseal(state);
        return dsrListRow(next);
    },
    'POST /api/dsr/requests/:id/verify-identity': ({ state, params, body }) => {
        const at = new Date().toISOString();
        state.dsr = state.dsr.map(r => (sameId(r.id, params.id)
            ? {
                ...r, identity_status: 'verified_manual', identity_verified_at: at,
                timeline: [
                    ...r.timeline,
                    tl('identity_verified', at, { by: 'u_marieke' }),
                    ...(body?.note ? [tl('note', at, { by: 'u_marieke', note: String(body.note) })] : []),
                ],
            }
            : r));
        return dsrListRow(state.dsr.find(r => sameId(r.id, params.id)));
    },
    'POST /api/dsr/requests/:id/fulfil': ({ state, params, body }) => {
        const at = new Date().toISOString();
        const status = body?.status === 'rejected' ? 'rejected' : 'fulfilled';
        state.dsr = state.dsr.map(r => (sameId(r.id, params.id)
            ? {
                ...r, status, result_summary: body?.result_summary || r.result_summary, pending: false,
                fulfilled_at: at, fulfilled_by: 'u_marieke',
                timeline: [
                    ...r.timeline, tl(status, at, { by: 'u_marieke' }),
                    ...(body?.notify_subject === false ? [] : [tl('result_emailed', at)]),
                ],
            }
            : r));
        reseal(state);
        return dsrListRow(state.dsr.find(r => sameId(r.id, params.id)));
    },
    // The ONE read that shows the address in full — and the one that writes an
    // access-audit row, which the demo's access log then shows you.
    'GET /api/dsr/requests/:id': ({ state, params }) => {
        const r = state.dsr.find(x => sameId(x.id, params.id));
        if (!r) return null;
        // routes/dsr.js: the request id and its type, never the address.
        logAccess(state, {
            action: 'dsr.subject_viewed', target_type: 'dsr_request', target_id: String(r.id),
            changed_by: 'u_marieke', new_values: { request_type: r.request_type },
        });
        return dsrDetail(r);
    },

    ...incidentRoutes({ org: ORG, reseal, refuse }),

    'GET /api/compliance/ropa': ({ state }) => ROPA(state),
    // Collaborative projects with personal data and their processing records
    // (complianceRopaProjects). A write re-judges that project's
    // GDPR-Art30-project-personal-data row and lands in the evidence chain.
    ...ropaProjectRoutes(rejudgeProject),
    'POST /api/compliance/ropa/review': ({ state }) => {
        const at = new Date().toISOString();
        state.settings = { ...state.settings, ropa_reviewed_at: at };
        return { ok: true, reviewed_at: at, reviewer: 'u_marieke' };
    },
    'POST /api/compliance/settings/scc': ({ state, body }) => {
        const list = new Set(state.settings.scc_confirmed_operators || []);
        if (body?.confirmed === false) list.delete(body?.operator);
        else list.add(body?.operator);
        state.settings = { ...state.settings, scc_confirmed_operators: [...list] };
        return state.settings;
    },

    'GET /api/compliance/dpia': ({ state }) => state.dpia,
    'GET /api/compliance/dpia/:agentId': ({ state, params }) =>
        state.dpia.find(d => d.agent_id === params.agentId) || null,
    'POST /api/compliance/dpia/:agentId': ({ state, params, body }) => {
        const existing = state.dpia.find(d => d.agent_id === params.agentId);
        const saved = {
            ...(existing || { id: nextId(state.dpia), organization_id: ORG, agent_id: params.agentId }),
            ...(body || {}),
            status: 'approved',
            approved_at: new Date().toISOString(),
        };
        state.dpia = existing
            ? state.dpia.map(d => (d.agent_id === params.agentId ? saved : d))
            : [saved, ...state.dpia];
        return saved;
    },

    'GET /api/compliance/iso/soa': ({ state }) => state.soa,
    // The change log, read out of the evidence ledger the way the server does
    // (rows with `subject_type = 'soa'`) — one source of truth, not two.
    'GET /api/compliance/iso/soa/history': ({ state }) => SOA_HISTORY(state),
    'POST /api/compliance/iso/soa/seed': ({ state }) => ({ seeded: state.soa.stats.todo }),
    'PUT /api/compliance/iso/soa/:ref': ({ state, params, body }) => {
        state.soa = {
            ...state.soa,
            controls: state.soa.controls.map(c => (c.ref === params.ref
                ? { ...c, entry: { ...(c.entry || soaEntry(params.ref, 'reviewed')), ...(body || {}) } }
                : c)),
        };
        return state.soa.controls.find(c => c.ref === params.ref)?.entry || null;
    },

    'GET /api/compliance/iso/readiness': () => ISO_READINESS(),

    'GET /api/compliance/iso/docs': ({ state }) => ({ ...state.docs, documents: state.docs.documents.map(docListRow) }),
    // Mirrors ismsDocStore.getDoc: the working draft plus the frozen current
    // version (`published`), which the policy drawer compares before it
    // offers Publish. PUT keeps the text as the draft; publishing freezes it.
    'GET /api/compliance/iso/docs/:slug': ({ state, params }) => {
        const d = state.docs.documents.find(x => x.slug === params.slug);
        if (!d) return null;
        const frozen = d.published_body ?? DOC_BODY(d);
        const published = d.status === 'published' && d.current_version
            ? { version: d.current_version, title: d.published_title ?? d.title, body: frozen }
            : null;
        return { ...docListRow(d), draft_body: d.draft_body ?? frozen, published };
    },
    'PUT /api/compliance/iso/docs/:slug': ({ state, params, body }) => {
        const { body: text, ...meta } = body || {};
        state.docs = {
            ...state.docs,
            documents: state.docs.documents.map(d => (d.slug === params.slug
                ? { ...d, ...meta, ...(typeof text === 'string' ? { draft_body: text } : {}), edited: true }
                : d)),
        };
        return docListRow(state.docs.documents.find(d => d.slug === params.slug));
    },
    'POST /api/compliance/iso/docs/:slug/publish': ({ state, params }) => {
        state.docs = {
            ...state.docs,
            documents: state.docs.documents.map(d => (d.slug === params.slug
                ? {
                    ...d, status: 'published', current_version: (d.current_version || 0) + 1,
                    published_title: d.title, published_body: d.draft_body ?? d.published_body ?? DOC_BODY(d),
                }
                : d)),
        };
        return docListRow(state.docs.documents.find(d => d.slug === params.slug));
    },
    'POST /api/compliance/iso/docs/seed': ({ state }) => ({ seeded: state.docs.missing_seeds.length }),

    'GET /api/compliance/iso/connectors': ({ state }) => state.connectors,
    'GET /api/compliance/iso/connectors/:id/connections': () => ([]),
    'PUT /api/compliance/iso/connectors/:id': ({ state, params, body }) => {
        state.connectors = state.connectors.map(c => (sameId(c.id, params.id)
            ? { ...c, config: { ...(c.config || { settings: {}, last_sweep_at: null, last_status: null, last_error: null }), ...(body || {}) } }
            : c));
        return state.connectors.find(c => sameId(c.id, params.id));
    },
    'POST /api/compliance/iso/connectors/:id/sweep': ({ state, params }) => {
        const at = new Date().toISOString();
        state.connectors = state.connectors.map(c => (sameId(c.id, params.id)
            ? { ...c, config: { ...(c.config || {}), last_sweep_at: at, last_status: 'ok', last_error: null } }
            : c));
        return { swept: true, at };
    },

    'GET /api/compliance/iso/risks': ({ state }) => ({ ...state.risks, stats: riskStats(state.risks.risks) }),
    'POST /api/compliance/iso/risks': ({ state, body }) => {
        const r = {
            id: nextId(state.risks.risks), organization_id: ORG, created_at: new Date().toISOString(),
            likelihood: 2, impact: 2, status: 'open', ...(body || {}),
        };
        r.score = (r.likelihood || 0) * (r.impact || 0);
        state.risks = { ...state.risks, risks: [r, ...state.risks.risks] };
        return r;
    },
    'PUT /api/compliance/iso/risks/:id': ({ state, params, body }) => {
        state.risks = {
            ...state.risks,
            risks: state.risks.risks.map(r => {
                if (!sameId(r.id, params.id)) return r;
                // As riskStore.update: every write bumps updated_at, and the first
                // move to 'accepted' stamps who (the demo's admin) and when.
                const next = { ...r, ...(body || {}), updated_at: new Date(now()).toISOString() };
                if (next.status === 'accepted' && !r.accepted_at) Object.assign(next, { accepted_at: next.updated_at, accepted_by: 'u_marieke' });
                next.score = (next.likelihood || 0) * (next.impact || 0);
                return next;
            }),
        };
        return state.risks.risks.find(r => sameId(r.id, params.id));
    },
    'POST /api/compliance/iso/risks/:id/treatments': ({ state, params, body }) => {
        const t = { id: nextId(state.risks.treatments), risk_id: Number(params.id), done_at: null, ...(body || {}) };
        state.risks = { ...state.risks, treatments: [t, ...state.risks.treatments] };
        return t;
    },
    'POST /api/compliance/iso/risks/seed': ({ state }) => ({ seeded: state.risks.risks.length }),

    'GET /api/compliance/iso/audit': ({ state }) => state.audit,
    'GET /api/compliance/iso/audit/independence/:userId': ({ params }) => ({
        // Joost owns no control in the audited scope, so he can audit it.
        independent: params.userId === 'u_joost',
        owns_controls: params.userId === 'u_joost' ? [] : ['A.8.2', 'A.8.15'],
    }),
    'POST /api/compliance/iso/audits': ({ state, body }) => {
        const a = { id: nextId(state.audit.audits), status: 'planned', organization_id: ORG, closed_at: null, ...(body || {}) };
        state.audit = { ...state.audit, audits: [a, ...state.audit.audits] };
        return a;
    },
    'PUT /api/compliance/iso/audits/:id': ({ state, params, body }) => {
        state.audit = { ...state.audit, audits: state.audit.audits.map(a => (sameId(a.id, params.id) ? { ...a, ...(body || {}) } : a)) };
        return state.audit.audits.find(a => sameId(a.id, params.id));
    },
    'POST /api/compliance/iso/audits/:id/findings': ({ state, params, body }) => {
        const f = { id: nextId(state.audit.findings), audit_id: Number(params.id), created_at: new Date().toISOString(), ...(body || {}) };
        state.audit = { ...state.audit, findings: [f, ...state.audit.findings] };
        return f;
    },
    'POST /api/compliance/iso/reviews': ({ state, body }) => {
        const r = { id: nextId(state.audit.reviews), organization_id: ORG, ...(body || {}) };
        state.audit = { ...state.audit, reviews: [r, ...state.audit.reviews] };
        return r;
    },
    'POST /api/compliance/iso/ncs': ({ state, body }) => {
        const n = { id: nextId(state.audit.ncs), status: 'open', created_at: new Date().toISOString(), ...(body || {}) };
        state.audit = { ...state.audit, ncs: [n, ...state.audit.ncs] };
        return n;
    },
    'PUT /api/compliance/iso/ncs/:id': ({ state, params, body }) => {
        state.audit = { ...state.audit, ncs: state.audit.ncs.map(n => (sameId(n.id, params.id) ? { ...n, ...(body || {}) } : n)) };
        return state.audit.ncs.find(n => sameId(n.id, params.id));
    },
    'POST /api/compliance/iso/objectives': ({ state, body }) => {
        const o = { id: nextId(state.audit.objectives), status: 'active', ...(body || {}) };
        state.audit = { ...state.audit, objectives: [o, ...state.audit.objectives] };
        return o;
    },
    'PUT /api/compliance/iso/objectives/:id': ({ state, params, body }) => {
        state.audit = { ...state.audit, objectives: state.audit.objectives.map(o => (sameId(o.id, params.id) ? { ...o, ...(body || {}) } : o)) };
        return state.audit.objectives.find(o => sameId(o.id, params.id));
    },

    // The route lists the OPEN obligations only, soonest first.
    'GET /api/compliance/iso/training': ({ state }) => ({
        ...state.training,
        obligations: state.training.obligations.filter(o => !o.completed_at).sort((a, b) => new Date(a.due_at) - new Date(b.due_at)),
    }),
    'POST /api/compliance/iso/training/:userId/attest': ({ state, params, body }) => {
        const at = new Date().toISOString();
        state.training = {
            ...state.training,
            personnel: state.training.personnel.map(p => (p.user_id === params.userId
                ? { ...p, attested_at: at, attested_note: body?.note || '' }
                : p)),
        };
        return ok();
    },
    'POST /api/compliance/iso/obligations': ({ state, body }) => {
        const b = body || {};
        const o = {
            ...obligation({ id: nextId(state.training.obligations), title: b.title, kind: b.kind || 'custom', subject: b.subject || '', owner: b.owner_user_id || null, due_at: b.due_at, recur_months: b.recur_months ?? null }),
            created_at: iso(0), updated_at: iso(0),
        };
        state.training = { ...state.training, obligations: [o, ...state.training.obligations] };
        return o;
    },
    // isoObligationStore.completeObligation: stamp it, and a recurring one
    // opens its next occurrence `recur_months` after the old due date.
    'POST /api/compliance/iso/obligations/:id/complete': ({ state, params }) => {
        const existing = state.training.obligations.find(o => sameId(o.id, params.id));
        if (!existing) return null;
        if (existing.completed_at) return { completed: existing, next: null };
        const at = new Date().toISOString();
        const completed = { ...existing, completed_at: at, completed_by: 'u_marieke', updated_at: at };
        let next = null;
        if (existing.recur_months) {
            const due = new Date(existing.due_at);
            due.setUTCMonth(due.getUTCMonth() + existing.recur_months);
            next = {
                ...obligation({ ...existing, id: nextId(state.training.obligations), owner: existing.owner_user_id, due_at: due.toISOString() }),
                created_at: at, updated_at: at,
            };
        }
        state.training = {
            ...state.training,
            obligations: [...(next ? [next] : []), ...state.training.obligations.map(o => (o.id === existing.id ? completed : o))],
        };
        return { completed, next };
    },

    /* ── AI Act assessments (the ladder, and the register behind it) ──── */

    'GET /api/compliance/ai-act/assessments': ({ state }) => state.aiAct.map(a => ({
        target_kind: a.target_kind, target_id: a.target_id, title: a.title, outcome: a.outcome,
        attested_by: a.attested_by, attested_at: a.attested_at, expires_at: a.expires_at, current: a.current,
    })),
    'GET /api/compliance/ai-act/assessments/:kind/:id/signals': ({ params }) =>
        AI_ACT_SIGNALS[aiActKey(params.kind, params.id)] || refuse('target_not_found', 404),
    'GET /api/compliance/ai-act/assessments/:kind/:id': ({ state, params }) =>
        aiActDetail(state, params.kind, params.id) || refuse('target_not_found', 404),
    // Recording an assessment stamps who and when, and starts the 12-month
    // clock the register counts down (Art. 53) — the same row the expired
    // automation above is an example of.
    'PUT /api/compliance/ai-act/assessments/:kind/:id': ({ state, params, body }) => {
        const answers = body?.answers || {};
        const signals = AI_ACT_SIGNALS[aiActKey(params.kind, params.id)] || null;
        const outcome = answers.art5?.answer === 'yes' ? 'prohibited'
            : answers.annex_iii?.answer === 'yes' ? 'high_risk'
                : (signals?.contains_ai === false) ? 'not_applicable'
                    : (signals?.customer_facing || signals?.generates_content
                        || answers.art50?.interacts === 'yes' || answers.art50?.generates === 'yes') ? 'transparency'
                        : 'minimal';
        const at = new Date().toISOString();
        const existing = state.aiAct.find(a => a.target_kind === params.kind && a.target_id === params.id);
        const row = {
            target_kind: params.kind, target_id: params.id,
            title: existing?.title || params.id,
            outcome, answers,
            attested_by: 'u_marieke', attested_at: at,
            expires_at: outcome === 'not_applicable' ? null : new Date(now() + days(365)).toISOString(),
            current: true,
            open_duties: outcome === 'transparency' && signals && !signals.disclosure_present ? ['art50_1_disclosure'] : [],
        };
        state.aiAct = [row, ...state.aiAct.filter(a => !(a.target_kind === params.kind && a.target_id === params.id))];
        reseal(state);
        return { ...row, signals };
    },

    /* ── Own frameworks (`compliance_hub_custom`) ─────────────────────── */

    'GET /api/compliance/custom/frameworks': ({ state, query }) => {
        const all = query.get('include_archived') === '1';
        return state.custom.frameworks
            .filter(f => all || f.status !== 'archived')
            .map(f => ({ ...f, checks_count: state.custom.checks.filter(c => c.framework_id === f.id).length }));
    },
    'POST /api/compliance/custom/frameworks': ({ state, body }) => {
        const code = String(body?.code || '').toUpperCase();
        if (!/^[A-Z0-9_]{2,24}$/.test(code)) return refuse('custom_framework_code_invalid');
        if (state.custom.frameworks.some(f => f.code === code)) return refuse('custom_framework_code_taken', 409);
        const at = new Date().toISOString();
        const fw = {
            id: `cfw_${code.toLowerCase()}`, organization_id: ORG, code,
            name: body?.name || code, reference: body?.reference || null, description: body?.description || null,
            attestation_valid_months: body?.attestation_valid_months ?? 12,
            status: body?.status || 'draft', created_at: at, updated_at: at,
        };
        state.custom = { ...state.custom, frameworks: [...state.custom.frameworks, fw] };
        return fw;
    },
    'GET /api/compliance/custom/frameworks/:id/export.json': ({ state, params }) => {
        const fw = state.custom.frameworks.find(f => sameId(f.id, params.id));
        if (!fw) return refuse('not_found', 404);
        const { organization_id: _org, ...rest } = fw; // eslint-disable-line no-unused-vars
        return {
            exported_at: iso(0),
            framework: rest,
            checks: state.custom.checks.filter(c => c.framework_id === fw.id).map(c => customCheckRow(state, c)),
        };
    },
    'POST /api/compliance/custom/frameworks/:id/checks': ({ state, params, body }) => {
        const rows = Array.isArray(body) ? body : (body?.checks || body?.rows || []);
        const fw = state.custom.frameworks.find(f => sameId(f.id, params.id));
        if (!fw) return refuse('not_found', 404);
        const added = rows.map((r, i) => ({
            id: `cck_${fw.code.toLowerCase()}_${state.custom.checks.length + i + 1}`,
            framework_id: fw.id,
            ref: String(r.ref || i + 1),
            title: r.title || '',
            description: r.description || '',
            severity: r.severity || 'medium',
            evidence_required: !!r.evidence_required,
            mapped_check_id: r.mapped_check_id || null,
            sort_order: state.custom.checks.length + i,
            check_id: `CUSTOM-${fw.code}-${r.ref || i + 1}`,
        }));
        state.custom = { ...state.custom, checks: [...state.custom.checks, ...added] };
        return { checks: added, count: added.length };
    },
    'GET /api/compliance/custom/frameworks/:id': ({ state, params }) => {
        const fw = state.custom.frameworks.find(f => sameId(f.id, params.id));
        if (!fw) return refuse('not_found', 404);
        return { ...fw, checks: state.custom.checks.filter(c => c.framework_id === fw.id).map(c => customCheckRow(state, c)) };
    },
    'PUT /api/compliance/custom/frameworks/:id': ({ state, params, body }) => {
        if (body && 'code' in body) return refuse('code_immutable');
        state.custom = {
            ...state.custom,
            frameworks: state.custom.frameworks.map(f => (sameId(f.id, params.id) ? { ...f, ...(body || {}), updated_at: new Date().toISOString() } : f)),
        };
        return state.custom.frameworks.find(f => sameId(f.id, params.id)) || refuse('not_found', 404);
    },
    'DELETE /api/compliance/custom/frameworks/:id': ({ state, params }) => {
        state.custom = {
            ...state.custom,
            frameworks: state.custom.frameworks.map(f => (sameId(f.id, params.id) ? { ...f, status: 'archived' } : f)),
        };
        return { ok: true, status: 'archived' };
    },
    'DELETE /api/compliance/custom/checks/:id': ({ state, params }) => {
        state.custom = { ...state.custom, checks: state.custom.checks.filter(c => !sameId(c.id, params.id)) };
        return ok();
    },
    'GET /api/compliance/custom/checks/:id/attestations': ({ state, params }) => {
        const c = state.custom.checks.find(x => sameId(x.id, params.id));
        if (!c) return refuse('not_found', 404);
        return state.custom.attestations
            .filter(a => a.check_id === c.check_id)
            .sort((a, b) => new Date(b.attested_at) - new Date(a.attested_at));
    },
    // An attestation IS the evidence for a custom check: append-only, with the
    // statement and the refs, and refused when the item demands evidence and
    // none is given.
    'POST /api/compliance/custom/checks/:id/attest': ({ state, params, body }) => {
        const c = state.custom.checks.find(x => sameId(x.id, params.id));
        if (!c) return refuse('not_found', 404);
        const outcome = body?.outcome;
        if (!['compliant', 'partial', 'non_compliant', 'not_applicable'].includes(outcome)) return refuse('invalid_outcome');
        const refs = Array.isArray(body?.evidence_refs) ? body.evidence_refs.filter(Boolean) : [];
        if (c.evidence_required && refs.length === 0) return refuse('evidence_required');
        const months = body?.expires_in_months
            ?? (state.custom.frameworks.find(f => f.id === c.framework_id)?.attestation_valid_months ?? 12);
        const at = new Date().toISOString();
        const attestation = {
            id: `att_${state.custom.attestations.length + 1}`,
            organization_id: ORG,
            check_id: c.check_id,
            subject_id: body?.subject_id || null,
            outcome,
            statement: body?.statement || '',
            evidence_refs: refs,
            attested_by: 'u_marieke',
            attested_at: at,
            expires_at: months == null ? null : new Date(now() + days(Math.round(months * 30.4))).toISOString(),
            superseded_at: null,
        };
        state.custom = { ...state.custom, attestations: [attestation, ...state.custom.attestations] };
        return attestation;
    },

    /* ── Data Act export matrix · Machinery detector · access log ─────── */

    'GET /api/compliance/portability': ({ state }) => PORTABILITY(state),
    'GET /api/compliance/machinery/detections': () => MACHINERY_DETECTIONS(),
    'GET /api/compliance/machinery/subjects/:id/attestations': ({ state, params }) =>
        state.custom.attestations.filter(a => a.subject_id === params.id),
    'POST /api/compliance/machinery/subjects/:id/attest': ({ state, params, body }) => {
        const classification = body?.classification || body?.outcome;
        if (!MACHINERY_CLASSIFICATIONS.includes(classification)) return refuse('invalid_outcome');
        const at = new Date().toISOString();
        const attestation = {
            id: `att_m_${state.custom.attestations.length + 1}`,
            organization_id: ORG,
            check_id: 'MACHINERY-Art18-safety-component-assessment',
            subject_id: params.id,
            // The store's vocabulary has no classification, so it rides in the
            // statement — exactly what checks/machinery/art18-* reads back.
            outcome: 'compliant',
            classification,
            statement: `[${classification}] ${body?.statement || ''}`.trim(),
            evidence_refs: Array.isArray(body?.evidence_refs) ? body.evidence_refs : [],
            attested_by: 'u_farah',
            attested_at: at,
            expires_at: new Date(now() + days(365)).toISOString(),
            superseded_at: null,
        };
        state.custom = { ...state.custom, attestations: [attestation, ...state.custom.attestations] };
        return attestation;
    },

    // The static catalogue: every check definition, the framework catalogue
    // and the Annex A controls, with NO org state — the "satisfied by a
    // built-in check" picker on an own framework reads it.
    'GET /api/compliance/registry': () => ({
        checks: CHECK_DEFS.map(d => ({
            id: d.check_id,
            regulation: d.regulation,
            article: d.article,
            framework_id: d.framework_id,
            frameworks: d.frameworks,
            in_force_since: d.in_force_since,
            severity: d.severity,
            scope: d.scope,
            verification: d.verification,
            titleKey: d.titleKey,
            descriptionKey: d.descriptionKey,
            remediationKey: d.remediationKey,
            remediationLink: d.remediationLink,
            autoFixId: d.autoFixId,
        })),
        frameworks: FRAMEWORKS,
        controls: ISO_CONTROLS,
        themes: ISO_THEMES,
    }),

    ...ACCESS_LOG_ROUTES,
};

// Policy bodies are one short, real-sounding paragraph each rather than lorem:
// a visitor who opens a policy should see something an ISMS would actually
// contain, and something obviously specific to this fictional company.
function DOC_BODY(doc) {
    return [
        `# ${doc.title}`,
        '',
        `**Owner:** ${(ORG_USERS().find(u => u.id === doc.owner_user_id) || {}).displayName || 'unassigned'}  `,
        `**Status:** ${doc.status === 'published' ? `published, version ${doc.current_version}` : 'draft'}`,
        '',
        '## Scope',
        '',
        'This document applies to Van Dael Assurantiën B.V. and to every system used to advise on, sell or administer insurance for our clients, including the AI workspace.',
        '',
        '## Policy',
        '',
        'Requirements are stated here in full in the real document. This copy is shortened for the public demo.',
        '',
        '## Review',
        '',
        'Reviewed at least annually by the owner named above, and after any incident classed as high risk.',
    ].join('\n');
}
