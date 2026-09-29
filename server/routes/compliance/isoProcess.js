/**
 * Compliance — the ISO 27001 ISMS process layer: risk register, internal
 * audits and findings, management reviews, nonconformities, objectives,
 * training/competence and the obligations due-date engine.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Every body schema below is `.strict()`, and on this router that is the
 * whole point. The ISMS stores under it are built to never throw: each one
 * answers an unrecognised enum value by keeping what was already there
 * (`VALID_STATUSES.has(patch.status) ? patch.status : existing.status`) or by
 * substituting the mildest member of the set. The row then comes back 200,
 * and the register reads as though the decision was recorded.
 *
 * Four of those fall-backs changed an auditor-facing fact:
 *   · `option:'avoid '` on a treatment was filed as **mitigate** — the
 *     register said the org would reduce a risk it had decided to walk away
 *     from;
 *   · `severity:'critical'` on an audit finding was filed as
 *     **observation**, the one severity that raises no nonconformity;
 *   · `status:'acepted'` on a risk left the status untouched AND skipped the
 *     acceptance stamp and the evidence row — a risk acceptance that never
 *     happened, answered with the unchanged row;
 *   · `likelihood:'hoog'` was stored as **3**, a score nobody chose.
 *
 * A zod enum answers each of those with a 400 that names the field and lists
 * the values. Nothing here is coerced into a decision on the caller's behalf.
 */

const express = require('express');
const router = express.Router();

const crypto = require('crypto');
const complianceStore = require('../../stores/complianceStore');
const soaStore = require('../../stores/soaStore');
const ismsDocStore = require('../../stores/ismsDocStore');
const incidentStore = require('../../stores/incidentStore');
const configStore = require('../../stores/configStore');
const { getAll } = require('../../db');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { resolveOrgId, _riskStore, _auditStore, _obligationStore } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── The vocabulary, kept next to the routes that speak it ───────────
//
// Each list is the store's own VALID_* set. Duplicated deliberately: the
// store may not reach up into the HTTP layer (layering.test.js), and a value
// added there without a thought for the API is exactly the drift a failing
// test should catch.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

/** One of a fixed set, named in the refusal so the caller can correct it. */
const oneOf = (name, values) => z.enum(values, {
    errorMap: () => ({ message: `${name} is one of: ${values.join(', ')}.` }),
});

const need = (name, max) => worded(`${name} is required.`)
    .trim().min(1, `${name} is required.`).max(max, `${name} is at most ${max} characters.`);
const text = (name, max) => worded(`${name} must be text.`)
    .trim().max(max, `${name} is at most ${max} characters.`).nullish();
/** A user the picker chose, or nothing — the pickers clear to '' or null. */
const userRef = (name) => worded(`${name} must be a user id.`).trim().max(120, `${name} is at most 120 characters.`).nullish();
/** A date the picker sends ('2026-09-22'), or nothing. An unreadable one is refused, never read as "no date". */
const dateish = (name) => worded(`${name} must be a date.`).trim()
    .refine((v) => v === '' || !Number.isNaN(Date.parse(v)), `${name} must be a date.`).nullish();
/** 1–5, the only scale the register has. Out of range is a refusal, not a clamp. */
const scale = (name) => z.number({ required_error: `${name} is 1 to 5.`, invalid_type_error: `${name} is 1 to 5.` })
    .int(`${name} is 1 to 5.`).min(1, `${name} is 1 to 5.`).max(5, `${name} is 1 to 5.`);

const RISK_STATUSES = ['open', 'treating', 'accepted', 'closed'];
const RISK_SOURCES = ['manual', 'seed', 'playbook'];
const TREATMENT_OPTIONS = ['mitigate', 'transfer', 'avoid', 'accept'];
const AUDIT_STATUSES = ['planned', 'in_progress', 'closed'];
const FINDING_SEVERITIES = ['observation', 'minor', 'major'];
const NC_SOURCES = ['internal_audit', 'management_review', 'incident', 'check', 'manual'];
const NC_SEVERITIES = ['minor', 'major'];
const NC_STATUSES = ['open', 'corrective_action', 'effectiveness_review', 'closed'];
const OBJECTIVE_STATUSES = ['active', 'achieved', 'dropped'];
const OBLIGATION_KINDS = [
    'policy_review', 'soa_review', 'internal_audit', 'management_review',
    'training', 'access_review', 'supplier_review', 'pentest', 'custom',
];

/** The two seed buttons and the complete button post an empty object. */
const EmptyBody = bodyOf({});

// ── 6.1 risk register ───────────────────────────────────────────────

const RISK_FIELDS = {
    description: text('description', 4000),
    category: text('category', 120),
    owner_user_id: userRef('owner_user_id'),
    review_due_at: dateish('review_due_at'),
};
const CreateRisk = bodyOf({
    ...RISK_FIELDS,
    title: need('title', 300),
    likelihood: scale('likelihood').optional(),
    impact: scale('impact').optional(),
    // `status` and `source` are accepted on create because an importer sets
    // them; the page never does.
    status: oneOf('status', RISK_STATUSES).optional(),
    source: oneOf('source', RISK_SOURCES).optional(),
    seed_key: text('seed_key', 200),
});
const RiskPatch = bodyOf({
    ...RISK_FIELDS,
    title: need('title', 300).optional(),
    likelihood: scale('likelihood').optional(),
    impact: scale('impact').optional(),
    // 'accepted' stamps who accepted it and writes an evidence row; a value
    // outside this list used to leave the status alone and skip both.
    status: oneOf('status', RISK_STATUSES).optional(),
});
const TreatmentBody = bodyOf({
    option: oneOf('option', TREATMENT_OPTIONS),
    description: text('description', 4000),
    due_at: dateish('due_at'),
    owner_user_id: userRef('owner_user_id'),
});

// ── 9.2 audits and findings ─────────────────────────────────────────

const AUDIT_FIELDS = {
    scope_note: text('scope_note', 4000),
    auditor_user_id: userRef('auditor_user_id'),
    planned_at: dateish('planned_at'),
};
const CreateAudit = bodyOf({ ...AUDIT_FIELDS, title: need('title', 300) });
const AuditPatch = bodyOf({
    ...AUDIT_FIELDS,
    title: need('title', 300).optional(),
    status: oneOf('status', AUDIT_STATUSES).optional(),
});
const FindingBody = bodyOf({
    description: need('description', 4000),
    // The severity decides whether this finding can be raised as a
    // nonconformity at all — an unrecognised one used to land as
    // 'observation', which cannot.
    severity: oneOf('severity', FINDING_SEVERITIES).optional(),
    control_ref: text('control_ref', 120),
    clause: text('clause', 120),
    evidence_ref: text('evidence_ref', 500),
    nonconformity_id: z.union([z.number().int(), worded('nonconformity_id must be an id.').trim().max(120)]).nullish(),
});

// ── 9.3 management reviews ──────────────────────────────────────────

const ReviewBody = bodyOf({
    held_at: worded('held_at is required — the date the review was held.').trim()
        .min(1, 'held_at is required — the date the review was held.')
        .refine((v) => !Number.isNaN(Date.parse(v)), 'held_at must be a date.'),
    // The attendee list the picker built, and the 9.3.2 agenda snapshot the
    // route handed the page. Both are stored as jsonb verbatim, so neither
    // is narrowed here.
    attendees: z.array(z.unknown(), { invalid_type_error: 'attendees is a list.' }).optional(),
    inputs: z.record(z.unknown(), { invalid_type_error: 'inputs is an object.' }).optional(),
    decisions: text('decisions', 20000),
    minutes_evidence_ref: text('minutes_evidence_ref', 500),
});

// ── 10 nonconformities ──────────────────────────────────────────────

const CreateNc = bodyOf({
    title: need('title', 300),
    description: text('description', 8000),
    source: oneOf('source', NC_SOURCES).optional(),
    severity: oneOf('severity', NC_SEVERITIES).optional(),
    corrective_action: text('corrective_action', 8000),
    due_at: dateish('due_at'),
    owner_user_id: userRef('owner_user_id'),
    // The audits tab raises an NC straight from a finding and sends the
    // finding's id along. The store does not read it (the link lives on the
    // finding row), but refusing it would break that button — so it is named
    // here rather than dropped by `.strict()`.
    finding_id: z.union([z.number().int(), worded('finding_id must be an id.').trim().max(120)]).nullish(),
});
const NcPatch = bodyOf({
    title: need('title', 300).optional(),
    description: text('description', 8000),
    severity: oneOf('severity', NC_SEVERITIES).optional(),
    status: oneOf('status', NC_STATUSES).optional(),
    corrective_action: text('corrective_action', 8000),
    due_at: dateish('due_at'),
    effectiveness_review_due_at: dateish('effectiveness_review_due_at'),
    owner_user_id: userRef('owner_user_id'),
    // Closing records who confirmed the corrective action worked, so this is
    // a boolean and nothing else — 'true' as a string is not a confirmation.
    confirm_effectiveness: z.boolean({ invalid_type_error: 'confirm_effectiveness is true or false.' }).optional(),
});

// ── 6.2 objectives ──────────────────────────────────────────────────

const OBJECTIVE_FIELDS = {
    measure: text('measure', 2000),
    target: text('target', 500),
    review_due_at: dateish('review_due_at'),
    owner_user_id: userRef('owner_user_id'),
};
const CreateObjective = bodyOf({ ...OBJECTIVE_FIELDS, title: need('title', 300) });
const ObjectivePatch = bodyOf({
    ...OBJECTIVE_FIELDS,
    title: need('title', 300).optional(),
    status: oneOf('status', OBJECTIVE_STATUSES).optional(),
});

// ── 7.2 training + the obligations engine ───────────────────────────

const TrainingAttestBody = bodyOf({ note: text('note', 300) });

const OBLIGATION_FIELDS = {
    subject: text('subject', 200),
    owner_user_id: userRef('owner_user_id'),
    // Null is evergreen; a number is a repeat every N months. 'twaalf' used
    // to become null, which is "never again" rather than "every year".
    recur_months: z.number({ invalid_type_error: 'recur_months is a number of months, 1 to 120.' })
        .int('recur_months is a number of months, 1 to 120.')
        .min(1, 'recur_months is a number of months, 1 to 120.')
        .max(120, 'recur_months is a number of months, 1 to 120.').nullish(),
    // Days before the due date to remind. An unusable list used to be
    // replaced by the default tiers without a word.
    notify_offsets: z.array(
        z.number({ invalid_type_error: 'notify_offsets is a list of whole days, 0 to 365.' })
            .int('notify_offsets is a list of whole days, 0 to 365.')
            .min(0, 'notify_offsets is a list of whole days, 0 to 365.')
            .max(365, 'notify_offsets is a list of whole days, 0 to 365.'),
        { invalid_type_error: 'notify_offsets is a list of whole days, 0 to 365.' },
    ).optional(),
};
const DUE_TEXT = 'due_at is required — when this obligation falls due.';
const CreateObligation = bodyOf({
    ...OBLIGATION_FIELDS,
    title: need('title', 300),
    due_at: worded(DUE_TEXT).trim().min(1, DUE_TEXT).refine((v) => !Number.isNaN(Date.parse(v)), 'due_at must be a date.'),
    kind: oneOf('kind', OBLIGATION_KINDS).optional(),
});
const ObligationPatch = bodyOf({
    ...OBLIGATION_FIELDS,
    title: need('title', 300).optional(),
    // An unreadable date used to reach `new Date(...)` and take the row's
    // reminder tiers with it.
    due_at: worded('due_at must be a date.').trim().refine((v) => !Number.isNaN(Date.parse(v)), 'due_at must be a date.').optional(),
});

// ───────────────── ISO 27001 — ISMS process layer ─────────────────
//
// Risk register (6.1.2/6.1.3), internal audits (9.2), management reviews
// (9.3), NC/CAPA (10), objectives (6.2), training/competence (7.2/7.3) and
// the single obligations due-date engine. Human judgment stays human: the
// tool records who decided what and when — it never decides.

router.get('/iso/risks', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const store = _riskStore();
    const [risks, treatments, stats] = await Promise.all([
        store.listRisks(orgId),
        store.listTreatments(orgId),
        store.getStats(orgId),
    ]);
    res.json({ risks, treatments, stats });
});

router.post('/iso/risks', requireAuth, requirePermission('admin_compliance'), validate({ body: CreateRisk }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    res.json(await _riskStore().createRisk(orgId, req.body || {}, actorId));
});

router.put('/iso/risks/:id', requireAuth, requirePermission('admin_compliance'), validate({ body: RiskPatch }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const saved = await _riskStore().updateRisk(orgId, req.params.id, req.body || {}, actorId);
    // Risk acceptance is an auditor-relevant decision — chain it.
    if (req.body?.status === 'accepted') {
        await complianceStore.addEvidence({
            organization_id: orgId, check_id: null,
            subject_type: 'risk', subject_id: String(req.params.id),
            hash: crypto.createHash('sha256').update(JSON.stringify(saved || {})).digest('hex'),
            payload: { action: 'risk_accepted', risk_id: req.params.id, by: actorId, at: new Date().toISOString() },
        });
    }
    res.json(saved);
});

router.post('/iso/risks/:id/treatments', requireAuth, requirePermission('admin_compliance'), validate({ body: TreatmentBody }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    res.json(await _riskStore().addTreatment(orgId, req.params.id, req.body || {}, actorId));
});

// Seed risk scenarios from LIVE facts — failing checks and unattested non-EU
// operators — plus three universal AI-workspace scenarios. seed_key dedupes,
// so re-seeding never duplicates and never touches edited rows.
router.post('/iso/risks/seed', requireAuth, requirePermission('admin_compliance'), validate({ body: EmptyBody }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const seeds = [];
    try {
        const latest = await complianceStore.getLatestPerCheck(orgId);
        for (const r of latest.filter(x => x.status === 'fail').slice(0, 15)) {
            seeds.push({
                seed_key: `check:${r.check_id}`,
                title: `Failing control: ${r.check_id}`,
                description: r.details || 'A compliance check is failing — assess the underlying risk and treat it.',
                category: 'compliance', likelihood: 3, impact: 3, source: 'seed',
            });
        }
    } catch { /* best-effort */ }
    try {
        const settings = await complianceStore.getSettings(orgId);
        const attested = new Set((settings.scc_confirmed_operators || [])
            .map(o => String(o?.operator || o || '').toLowerCase()));
        const ops = await getAll(`
                SELECT DISTINCT operator FROM integration_activity_log
                WHERE organization_id = $1 AND is_eu = FALSE AND operator IS NOT NULL
                  AND COALESCE(is_local, false) = false
                  AND timestamp >= NOW() - INTERVAL '30 days'
                LIMIT 10
            `, [orgId]);
        for (const o of ops || []) {
            if (attested.has(String(o.operator).toLowerCase())) continue;
            seeds.push({
                seed_key: `operator:${String(o.operator).toLowerCase()}`,
                title: `Unattested non-EU processor: ${o.operator}`,
                description: 'Data flows to a non-EU operator without an SCC attestation on record.',
                category: 'confidentiality', likelihood: 3, impact: 4, source: 'seed',
            });
        }
    } catch { /* table absent on fresh installs */ }
    seeds.push(
        { seed_key: 'universal:prompt-leak', title: 'Sensitive data leaves via AI prompts', description: 'Users paste customer or personal data into prompts that reach external model providers.', category: 'confidentiality', likelihood: 4, impact: 4, source: 'seed' },
        { seed_key: 'universal:account-takeover', title: 'Admin account takeover', description: 'A compromised administrator credential exposes every workspace and its data.', category: 'confidentiality', likelihood: 2, impact: 5, source: 'seed' },
        { seed_key: 'universal:provider-outage', title: 'Critical provider outage', description: 'An AI or infrastructure provider outage stops primary business workflows.', category: 'availability', likelihood: 3, impact: 3, source: 'seed' },
    );
    const inserted = await _riskStore().seedMissing(orgId, seeds);
    res.json({ inserted, offered: seeds.length });
});

// The audit & review bundle. mr_inputs is the auto-built 9.3.2 agenda; the
// minutes and decisions stay human.
router.get('/iso/audit', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const store = _auditStore();
    const [audits, findings, reviews, ncs, objectives] = await Promise.all([
        store.listAudits(orgId),
        store.listFindings(orgId, null),
        store.listReviews(orgId),
        store.listNonconformities(orgId),
        store.listObjectives(orgId),
    ]);
    let mrInputs = null;
    try {
        const [history, latest, riskStats, soaStats, incidents] = await Promise.all([
            complianceStore.getScoreHistory(orgId, 90),
            complianceStore.getLatestPerCheck(orgId),
            _riskStore().getStats(orgId).catch(() => null),
            soaStore.getStats(orgId).catch(() => null),
            incidentStore.getDeadlineStats(orgId).catch(() => null),
        ]);
        mrInputs = {
            score_now: history.length ? history[history.length - 1].overall_score : null,
            score_90d_ago: history.length ? history[0].overall_score : null,
            failing_checks: latest.filter(r => r.status === 'fail').length,
            open_nonconformities: ncs.filter(n => n.status !== 'closed').length,
            open_incidents: incidents?.open ?? null,
            risks_open: riskStats?.open ?? null,
            risks_high: riskStats?.high ?? null,
            soa_approved: soaStats ? `${soaStats.approved}/${soaStats.total}` : null,
            last_internal_audit: audits.filter(a => a.status === 'closed').map(a => a.closed_at).sort().pop() || null,
        };
    } catch { /* agenda best-effort */ }
    res.json({ audits, findings, reviews, ncs, objectives, mr_inputs: mrInputs });
});

// Independence probe (clause 9.2.2) — does this prospective auditor OWN any of
// the things they would audit? The server records the conflict; choosing to
// proceed anyway stays a human decision, visible in the audit row.
router.get('/iso/audit/independence/:userId', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const userId = String(req.params.userId);
    const conflicts = [];
    try {
        const soaOwned = (await soaStore.listEntries(orgId)).filter(e => e.owner_user_id === userId).length;
        if (soaOwned) conflicts.push(`owns ${soaOwned} SoA control row(s)`);
    } catch { /* best-effort */ }
    try {
        const docsOwned = (await ismsDocStore.listDocs(orgId)).filter(d => d.owner_user_id === userId).length;
        if (docsOwned) conflicts.push(`owns ${docsOwned} policy document(s)`);
    } catch { /* best-effort */ }
    try {
        const risksOwned = (await _riskStore().listRisks(orgId)).filter(r => r.owner_user_id === userId).length;
        if (risksOwned) conflicts.push(`owns ${risksOwned} risk(s)`);
    } catch { /* store may not exist yet */ }
    res.json({ user_id: userId, independent: conflicts.length === 0, conflicts });
});

router.post('/iso/audits', requireAuth, requirePermission('admin_compliance'), validate({ body: CreateAudit }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    res.json(await _auditStore().createAudit(orgId, req.body || {}, actorId));
});

router.put('/iso/audits/:id', requireAuth, requirePermission('admin_compliance'), validate({ body: AuditPatch }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    res.json(await _auditStore().updateAudit(orgId, req.params.id, req.body || {}));
});

router.post('/iso/audits/:id/findings', requireAuth, requirePermission('admin_compliance'), validate({ body: FindingBody }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    res.json(await _auditStore().addFinding(orgId, req.params.id, req.body || {}));
});

router.post('/iso/reviews', requireAuth, requirePermission('admin_compliance'), validate({ body: ReviewBody }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const review = await _auditStore().createReview(orgId, req.body || {}, actorId);
    await complianceStore.addEvidence({
        organization_id: orgId, check_id: null,
        subject_type: 'management_review', subject_id: String(review?.id || ''),
        hash: crypto.createHash('sha256').update(JSON.stringify(review || {})).digest('hex'),
        payload: { action: 'management_review_recorded', by: actorId, at: new Date().toISOString() },
    });
    res.json(review);
});

router.post('/iso/ncs', requireAuth, requirePermission('admin_compliance'), validate({ body: CreateNc }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    res.json(await _auditStore().createNonconformity(orgId, req.body || {}, actorId));
});

router.put('/iso/ncs/:id', requireAuth, requirePermission('admin_compliance'), validate({ body: NcPatch }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    res.json(await _auditStore().updateNonconformity(orgId, req.params.id, req.body || {}, actorId));
});

router.post('/iso/objectives', requireAuth, requirePermission('admin_compliance'), validate({ body: CreateObjective }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    res.json(await _auditStore().createObjective(orgId, req.body || {}, actorId));
});

router.put('/iso/objectives/:id', requireAuth, requirePermission('admin_compliance'), validate({ body: ObjectivePatch }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    res.json(await _auditStore().updateObjective(orgId, req.params.id, req.body || {}));
});

// Training & competence (7.2/7.3) — policy-ack coverage + platform learning
// progress + an attest for external training. Attests live in the evidence
// chain (subject_type 'training_attest'), not a separate table.
router.get('/iso/training', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const [members, publishedDocs, obligations] = await Promise.all([
        getAll(`
                SELECT id, username, "displayName", email FROM users
                WHERE "organizationId" = $1 AND email IS NOT NULL AND email <> '' AND id <> 'admin'
                ORDER BY LOWER(COALESCE(NULLIF("displayName", ''), username))
            `, [orgId]).catch(() => []),
        ismsDocStore.listDocs(orgId).then(d => d.filter(x => x.status === 'published')).catch(() => []),
        _obligationStore().listObligations(orgId, { openOnly: true }).catch(() => []),
    ]);
    const ackRows = await getAll(`
            SELECT a.user_id, COUNT(*)::int AS n
            FROM isms_acknowledgements a
            JOIN isms_documents d ON d.organization_id = a.organization_id
                AND d.slug = a.slug AND d.current_version = a.version
            WHERE a.organization_id = $1 AND d.status = 'published'
            GROUP BY a.user_id
        `, [orgId]).catch(() => []);
    const acksByUser = Object.fromEntries((ackRows || []).map(r => [r.user_id, r.n]));
    const attestRows = await getAll(`
            SELECT DISTINCT ON (subject_id) subject_id, captured_at, payload
            FROM compliance_evidence
            WHERE organization_id = $1 AND subject_type = 'training_attest'
            ORDER BY subject_id, captured_at DESC
        `, [orgId]).catch(() => []);
    const attestByUser = Object.fromEntries((attestRows || []).map(r => [r.subject_id, r]));
    const personnel = [];
    for (const m of members) {
        let learningDone = null;
        try {
            const lp = await configStore.getConfig(`learning_progress_user_${m.id}`);
            if (lp && typeof lp === 'object') {
                learningDone = Object.values(lp).filter(v => v === true || v?.completed).length;
            }
        } catch { /* stays null */ }
        const attest = attestByUser[m.id] || null;
        personnel.push({
            user_id: m.id,
            displayName: m.displayName || m.username,
            email: m.email,
            policy_acks: acksByUser[m.id] || 0,
            policy_total: publishedDocs.length,
            learning_done: learningDone,
            attested_at: attest?.captured_at || null,
            attested_note: attest?.payload?.note || null,
        });
    }
    res.json({ personnel, obligations });
});

router.post('/iso/training/:userId/attest', requireAuth, requirePermission('admin_compliance'), validate({ body: TrainingAttestBody }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const payload = {
        action: 'training_attested', user_id: String(req.params.userId),
        note: req.body?.note ? String(req.body.note).slice(0, 300) : null,
        by: actorId, at: new Date().toISOString(),
    };
    await complianceStore.addEvidence({
        organization_id: orgId, check_id: null,
        subject_type: 'training_attest', subject_id: String(req.params.userId),
        hash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        payload,
    });
    res.json({ attested: true });
});

router.post('/iso/obligations', requireAuth, requirePermission('admin_compliance'), validate({ body: CreateObligation }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    res.json(await _obligationStore().createObligation(orgId, req.body || {}, actorId));
});

router.put('/iso/obligations/:id', requireAuth, requirePermission('admin_compliance'), validate({ body: ObligationPatch }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    res.json(await _obligationStore().updateObligation(orgId, req.params.id, req.body || {}));
});

router.post('/iso/obligations/:id/complete', requireAuth, requirePermission('admin_compliance'), validate({ body: EmptyBody }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    res.json(await _obligationStore().completeObligation(orgId, req.params.id, actorId));
});

module.exports = router;
