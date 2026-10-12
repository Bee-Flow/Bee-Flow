/**
 * Compliance — chat signals: the settings card, its summary table and the
 * "Delete collected counts" button.
 *
 * Chat signals check whether the Privacy Shield works on chat messages
 * (GDPR Art. 32(1)(d)): per chat type, the outcome the Shield already decided
 * on each counted message becomes a counter. This router owns the
 * `chat_monitoring_*` columns of compliance_settings (SETTINGS_REQUEST_DENY
 * keeps them out of PUT /settings) and is the only emitter of
 * CHAT_MONITORING_CHANGED, together with its DPIA middleware.
 *
 *   GET    /chat-monitoring          settings, effective state, catalogue, DPIA, bands
 *   PUT    /chat-monitoring          a full replacement of the configuration
 *   GET    /chat-monitoring/summary  the suppressed figures (every read is in the access log)
 *   DELETE /chat-monitoring/counts   every collected count of the org
 *
 * Who may do what. Every handler needs `admin_compliance` (a DPO can hold it).
 * A change that WIDENS (switching on, counting more, a longer retention, a
 * different legal basis or works-council scope) also needs an admin of the
 * organisation; for the 'default' bucket, a super admin. Narrowing, switching
 * off and maintaining (notice, DPIA fields, dates) stay open to the DPO.
 *
 * Preconditions are evaluated by stores/lib/chatMonitoringRules.js, the same
 * evaluation the resolver pauses on at runtime and C3 fails on afterwards. A
 * refusal is a 422 whose `details.missing` lists field CODES, never values.
 * Evidence and access-audit snapshots come from one explicit allow-list:
 * enums, dates, booleans and numbers that are not about people; no ids, no
 * URL text, no DPIA reference text, no actor.
 */

const express = require('express');
const { z } = require('zod');
const router = express.Router();

const complianceStore = require('../../stores/complianceStore');
const dpiaStore = require('../../stores/dpiaStore');
const userStore = require('../../stores/userStore');
const chatSignalStore = require('../../stores/chatSignalStore');
const V = require('../../stores/lib/chatMonitoringVocab');
const rules = require('../../stores/lib/chatMonitoringRules');
const sup = require('../../stores/lib/chatSignalSuppression');
const chatMonitoringFlag = require('../../core/entitlements/chatMonitoringFlag');
const { requireAuth, requirePermission, isOrgAdminForOrg, isSuperAdmin } = require('../../auth/permissions');
const { resolveOrgId } = require('./shared');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { onEvidenceWriteFailed } = require('../../compliance/evidence/writeFailures');
const { publicBaseUrl, publicDsrPath } = require('../../utils/appPaths');
const log = require('../../telemetry/log');

const CHECK_ID = 'GDPR-Art35-chat-monitoring-safeguards';
/** The shorter of the summary's two views (30 and 90 days). */
const SHORT_DAYS = 30;
const DAY_MS = 86_400_000;
/** Shown disabled in the card. Voice waits for a transcript input gate (phase 3). */
const CATALOGUE_FUTURE_SURFACES = Object.freeze(['notebook']);
/** What a configuration that is on needs whatever the change: something to count. */
const STRUCTURAL_CODES = Object.freeze(['surfaces_required', 'surface_not_available', 'outcomes_required', 'signal_not_available', 'retention_days']);

// ── What a caller may send ──────────────────────────────────────────────

const oneOf = (name, values) => z.enum(/** @type {[string, ...string[]]} */ ([...values]), {
    errorMap: () => ({ message: `${name} is one of: ${values.join(', ')}.` }),
});
const flag = (name) => z.boolean({ required_error: `${name} is true or false.`, invalid_type_error: `${name} is true or false.` });
const uniqueList = (name, values, max) => z.array(oneOf(name, values), {
    required_error: `${name} is a list.`, invalid_type_error: `${name} is a list.`,
})
    .max(max, `${name} has at most ${max} entries.`)
    .refine(a => new Set(a).size === a.length, `${name} lists each value once.`);
const date = (name) => z.string({ required_error: `${name} is a date (YYYY-MM-DD) or null.`, invalid_type_error: `${name} is a date (YYYY-MM-DD) or null.` })
    .refine(v => rules.dayString(v) === v, `${name} is a date (YYYY-MM-DD) or null.`)
    .nullable();
const retention = (name) => z.number({ required_error: `${name} is a number of days.`, invalid_type_error: `${name} is a number of days.` })
    .int(`${name} is a whole number of days.`)
    .min(V.RETENTION.min, `${name} is at least ${V.RETENTION.min} days.`)
    .max(V.RETENTION.max, `${name} is at most ${V.RETENTION.max} days.`);

const Scope = z.object({
    surfaces: uniqueList('works_council_scope.surfaces', V.SURFACES, V.SURFACES.length),
    signals: uniqueList('works_council_scope.signals', V.SIGNALS, V.SIGNALS.length),
    max_retention_days: retention('works_council_scope.max_retention_days'),
}, { required_error: 'works_council_scope is an object or null.', invalid_type_error: 'works_council_scope is an object or null.' })
    .strict('works_council_scope takes surfaces, signals and max_retention_days only.')
    .nullable();

const PutBody = z.object({
    enabled: flag('enabled'),
    surfaces: uniqueList('surfaces', V.SURFACES, V.SURFACES.length),
    signals: uniqueList('signals', V.SIGNALS, V.SIGNALS.length),
    effective_from: z.string({ invalid_type_error: 'effective_from is a moment (ISO 8601) or null.' })
        .max(40, 'effective_from is a moment (ISO 8601) or null.').nullish(),
    retention_days: retention('retention_days'),
    legal_basis: oneOf('legal_basis', V.LEGAL_BASES).nullable(),
    works_council: oneOf('works_council', V.WORKS_COUNCIL).nullable(),
    works_council_reason: oneOf('works_council_reason', V.WORKS_COUNCIL_REASONS).nullable(),
    works_council_at: date('works_council_at'),
    works_council_scope: Scope,
    dpia_ref: z.string({ required_error: 'dpia_ref is text or null.', invalid_type_error: 'dpia_ref is text or null.' })
        .trim().min(1, 'dpia_ref is text or null.').max(200, 'dpia_ref is at most 200 characters.').nullable(),
    dpia_at: date('dpia_at'),
    dpia_risk_level: oneOf('dpia_risk_level', V.DPIA_RISK_LEVELS).nullable(),
    dpo_advice_at: date('dpo_advice_at'),
    prior_consultation_at: date('prior_consultation_at'),
    notice_url: z.string({ required_error: 'notice_url is an https link or null.', invalid_type_error: 'notice_url is an https link or null.' })
        .max(500, 'notice_url is at most 500 characters.')
        .refine(v => rules.httpsUrl(v) !== null, 'notice_url is an https link or null.')
        .nullable(),
    notice_published_at: date('notice_published_at'),
    acknowledgements: z.object({
        notice_published: flag('acknowledgements.notice_published').optional(),
        ropa_reviewed: flag('acknowledgements.ropa_reviewed').optional(),
        informed_before_start: flag('acknowledgements.informed_before_start').optional(),
        lia_documented: flag('acknowledgements.lia_documented').optional(),
    }, { invalid_type_error: 'acknowledgements is an object.' })
        .strict('acknowledgements takes notice_published, ropa_reviewed, informed_before_start and lia_documented only.')
        .default({}),
}, { invalid_type_error: 'The body is a JSON object.' }).strict('The body has a field chat signals do not know.');

const SummaryQuery = z.object({
    days: z.enum(['30', '90'], { errorMap: () => ({ message: 'days is 30 or 90.' }) }).optional(),
}).strict('The summary takes days only.');
const NoQuery = z.object({}).strict('This takes no query parameters.');

// ── Helpers ─────────────────────────────────────────────────────────────

const actorOf = (req) => req.session?.user?.id || null;
const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : rules.dayString(v));
const inVocab = (list, v) => (list.includes(v) ? v : null);
const vocabList = (list, v) => (Array.isArray(v) ? v.filter(x => list.includes(x)) : []);

/** May this request widen chat signals for the org? */
async function canWiden(req, orgId) {
    if (orgId === 'default') return isSuperAdmin(req);
    try { return await isOrgAdminForOrg(req, orgId); } catch { return false; }
}

/** The body as the settings columns it replaces (the derived ones come later). */
function columnsFromBody(b) {
    return {
        chat_monitoring_enabled: b.enabled === true,
        chat_monitoring_surfaces: b.surfaces,
        chat_monitoring_signals: b.signals,
        chat_monitoring_retention_days: b.retention_days,
        chat_monitoring_legal_basis: b.legal_basis,
        chat_monitoring_works_council: b.works_council,
        chat_monitoring_works_council_reason: b.works_council_reason,
        chat_monitoring_works_council_at: b.works_council_at,
        chat_monitoring_works_council_scope: b.works_council_scope || {},
        chat_monitoring_dpia_ref: b.dpia_ref,
        chat_monitoring_dpia_at: b.dpia_at,
        chat_monitoring_dpia_risk_level: b.dpia_risk_level,
        chat_monitoring_dpo_advice_at: b.dpo_advice_at,
        chat_monitoring_prior_consultation_at: b.prior_consultation_at,
        chat_monitoring_notice_url: b.notice_url,
        chat_monitoring_notice_published_at: b.notice_published_at,
    };
}

/**
 * The allow-list behind every evidence payload and access-audit snapshot of a
 * save (amendment 10: compliance_evidence is hash-chained and never purged).
 */
function snapshot(s, dpia, { change = null, earlyStartAttested = false, now = new Date() } = {}) {
    const scope = rules.normScope(s.chat_monitoring_works_council_scope);
    const out = {
        enabled: s.chat_monitoring_enabled === true,
        surfaces: vocabList(V.SURFACES, s.chat_monitoring_surfaces),
        signals: vocabList(V.SIGNALS, s.chat_monitoring_signals),
        effective_from: rules.isoInstant(s.chat_monitoring_effective_from)?.slice(0, 10) || null,
        early_start_attested: earlyStartAttested === true,
        legal_basis: inVocab(V.LEGAL_BASES, s.chat_monitoring_legal_basis),
        lia_documented: !!rules.isoInstant(s.chat_monitoring_lia_at),
        works_council: inVocab(V.WORKS_COUNCIL, s.chat_monitoring_works_council),
        works_council_reason: inVocab(V.WORKS_COUNCIL_REASONS, s.chat_monitoring_works_council_reason),
        works_council_at: rules.dayString(s.chat_monitoring_works_council_at),
        works_council_scope: {
            surfaces: vocabList(V.SURFACES, scope.surfaces),
            signals: vocabList(V.SIGNALS, scope.signals),
            max_retention_days: scope.max_retention_days,
        },
        dpia: dpia.kind,
        dpia_expires_at: dpia.expiresAt ? dayOf(dpia.expiresAt) : null,
        dpia_risk_level: dpia.riskLevel,
        prior_consultation_at: rules.dayString(s.chat_monitoring_prior_consultation_at),
        dpo_advice_at: rules.dayString(s.chat_monitoring_dpo_advice_at),
        notice_url_set: !!rules.httpsUrl(s.chat_monitoring_notice_url),
        notice_published_at: rules.dayString(s.chat_monitoring_notice_published_at),
        retention_days: rules.clampedRetention(s),
        at: dayOf(now),
    };
    return change ? { action: 'chat_monitoring_changed', change, ...out } : out;
}

function addEvidence(orgId, payload) {
    const row = { organization_id: orgId, check_id: CHECK_ID, subject_type: 'setting', subject_id: 'chat_monitoring', payload };
    return complianceStore.addEvidence(row).catch(onEvidenceWriteFailed(row));
}

function emitChanged(orgId) {
    try {
        const { emit, EVENTS } = require('../../compliance/events');
        emit(EVENTS.CHAT_MONITORING_CHANGED, { orgId });
    } catch { /* the bus is optional in tests */ }
}

function displayName(user) {
    if (!user) return null;
    const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    return user.displayName || full || user.username || null;
}

/** The GET shape. Reads everything fresh; the resolver after any invalidate. */
async function buildView(req, orgId) {
    const now = new Date();
    const [s, dpiaRow, installHasOrganisations, effective, widen] = await Promise.all([
        complianceStore.getSettings(orgId),
        dpiaStore.getLatestForAgent(orgId, V.CHAT_MONITORING_DPIA_KEY),
        userStore.hasAnyOrganization(),
        chatMonitoringFlag.resolveChatMonitoring(orgId),
        canWiden(req, orgId),
    ]);
    const d = rules.dpiaStatus(s, dpiaRow, now);
    let enabledByName = null;
    if (s.chat_monitoring_enabled_by) {
        try { enabledByName = displayName(await userStore.getUser(s.chat_monitoring_enabled_by)); } catch { enabledByName = null; }
    }
    // Distinct active people over the last 4 completed weeks, as a band only (amendment 19).
    const w = sup.lastFourWeeks(now);
    const contributors = {};
    for (const surface of V.SURFACES.filter(x => V.isEmployeeSurface(x))) {
        let n = null;
        try { n = await chatSignalStore.contributorCount(orgId, surface, { from: w.from, toExclusive: w.toExclusive }); } catch { n = null; }
        contributors[surface] = sup.contributorBand(n);
    }
    const scope = rules.normScope(s.chat_monitoring_works_council_scope);
    let shieldLogRetentionDays = null;
    try { shieldLogRetentionDays = require('../../jobs/monitoringRetention').RETENTION_DAYS; } catch { shieldLogRetentionDays = null; }
    return {
        settings: {
            enabled: s.chat_monitoring_enabled === true,
            surfaces: vocabList(V.SURFACES, s.chat_monitoring_surfaces),
            signals: vocabList(V.SIGNALS, s.chat_monitoring_signals),
            effective_from: rules.isoInstant(s.chat_monitoring_effective_from),
            retention_days: rules.clampedRetention(s),
            legal_basis: inVocab(V.LEGAL_BASES, s.chat_monitoring_legal_basis),
            lia_at: rules.isoInstant(s.chat_monitoring_lia_at),
            works_council: inVocab(V.WORKS_COUNCIL, s.chat_monitoring_works_council),
            works_council_reason: inVocab(V.WORKS_COUNCIL_REASONS, s.chat_monitoring_works_council_reason),
            works_council_at: rules.dayString(s.chat_monitoring_works_council_at),
            works_council_scope: { surfaces: scope.surfaces, signals: scope.signals, max_retention_days: scope.max_retention_days },
            dpia_ref: s.chat_monitoring_dpia_ref || null,
            dpia_at: rules.dayString(s.chat_monitoring_dpia_at),
            dpia_risk_level: inVocab(V.DPIA_RISK_LEVELS, s.chat_monitoring_dpia_risk_level),
            dpo_advice_at: rules.dayString(s.chat_monitoring_dpo_advice_at),
            prior_consultation_at: rules.dayString(s.chat_monitoring_prior_consultation_at),
            notice_url: s.chat_monitoring_notice_url || null,
            notice_published_at: rules.dayString(s.chat_monitoring_notice_published_at),
            enabled_at: rules.isoInstant(s.chat_monitoring_enabled_at),
            enabled_by_name: enabledByName,
        },
        effective,
        catalogue: {
            surfaces: [
                ...V.SURFACES.map(id => ({ id, population: V.isVisitorSurface(id) ? 'visitors' : 'employees', available: true })),
                ...CATALOGUE_FUTURE_SURFACES.map(id => ({ id, population: 'employees', available: false })),
            ],
            signals: V.SIGNALS.map(id => ({ id, required: id === 'outcomes', available: true })),
            legal_bases: [...V.LEGAL_BASES],
            works_council: [...V.WORKS_COUNCIL],
            works_council_reasons: [...V.WORKS_COUNCIL_REASONS],
            dpia_risk_levels: [...V.DPIA_RISK_LEVELS],
            retention: { ...V.RETENTION },
            k: { outcomes: V.K.outcomes, kinds: V.K.kinds },
        },
        dpia: {
            kind: d.kind,
            current: d.current,
            expires_at: d.expiresAt ? dayOf(d.expiresAt) : null,
            risk_level: d.riskLevel,
            approved_at: d.approvedAt ? dayOf(d.approvedAt) : null,
        },
        dpo_recorded: !!(s.dpo_name || s.dpo_email),
        contributors,
        install_has_organisations: !!installHasOrganisations,
        privacy_notice_url_set: !!rules.httpsUrl(s.privacy_notice_url),
        template: {
            dpo_contact: s.dpo_email || null,
            dsr_url: `${publicBaseUrl(s.public_base_url || null)}${publicDsrPath()}`,
            shield_log_retention_days: shieldLogRetentionDays,
        },
        can_widen: !!widen,
    };
}

// ── Routes ──────────────────────────────────────────────────────────────

router.get('/chat-monitoring', requireAuth, requirePermission('admin_compliance'), validate({ query: NoQuery }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    res.set('Cache-Control', 'no-store');
    res.json(await buildView(req, orgId));
});

router.put('/chat-monitoring', requireAuth, requirePermission('admin_compliance'), validate({ body: PutBody }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = actorOf(req);
    const body = req.body;
    const ack = body.acknowledgements || {};
    const now = new Date();
    const [before, dpiaRow, installHasOrganisations] = await Promise.all([
        complianceStore.getSettings(orgId),
        dpiaStore.getLatestForAgent(orgId, V.CHAT_MONITORING_DPIA_KEY),
        userStore.hasAnyOrganization(),
    ]);
    const draft = { ...before, ...columnsFromBody(body) };
    const change = rules.classifyChange(before, draft);

    if (change.widen && !(await canWiden(req, orgId))) {
        throw new HttpError(403, 'chat_monitoring_widen_forbidden',
            'Only an organisation admin can switch chat signals on or count more. You can switch it off or count less.');
    }

    const ef = rules.planEffectiveFrom({ change, before, requested: body.effective_from, acknowledgements: ack, now });
    const liaAt = rules.planLiaAt({ before, basis: body.legal_basis, acknowledgements: ack, now });
    const wasOn = before.chat_monitoring_enabled === true;
    const stamps = change.off
        ? { chat_monitoring_enabled_at: null, chat_monitoring_enabled_by: null }
        : (change.widen && !wasOn)
            ? { chat_monitoring_enabled_at: now.toISOString(), chat_monitoring_enabled_by: actorId }
            : { chat_monitoring_enabled_at: rules.isoInstant(before.chat_monitoring_enabled_at), chat_monitoring_enabled_by: before.chat_monitoring_enabled_by || null };
    const patch = { ...columnsFromBody(body), chat_monitoring_effective_from: ef.value, chat_monitoring_lia_at: liaAt, ...stamps };
    const after = { ...before, ...patch };

    if (!change.off) {
        const ev = rules.evaluate(after, { dpiaRow, now, installHasOrganisations, orgKey: orgId, privacyNoticeUrl: before.privacy_notice_url });
        // A save that purely narrows skips the attestation preconditions, but
        // a configuration that is on must still name a chat type and count
        // outcomes: "on with nothing selected" is switching off, said plainly.
        const missing = change.widen || change.maintain
            ? rules.allCodes(ev, [...rules.putCodes({ change, before, after, acknowledgements: ack }), ...ef.codes])
            : ev.global.filter(c => STRUCTURAL_CODES.includes(c));
        if (missing.length) {
            throw new HttpError(422, 'chat_monitoring_preconditions', 'Chat signals cannot be saved yet: something is missing.', { missing });
        }
    }

    const saved = await complianceStore.saveSettings(orgId, patch);
    const d = rules.dpiaStatus(saved || after, dpiaRow, now);
    const earlyStartAttested = change.employeeWidened && ack.informed_before_start === true && !!ef.value
        && ef.value.slice(0, 10) < new Date(now.getTime() + V.NOTICE_LEAD_DAYS * DAY_MS).toISOString().slice(0, 10);
    const word = rules.changeWord(change);
    const newSnapshot = snapshot(saved || after, d, { change: word, earlyStartAttested, now });
    await addEvidence(orgId, newSnapshot);
    const oldSnapshot = snapshot(before, rules.dpiaStatus(before, dpiaRow, now), { change: word, now });
    await userStore.logAccessAudit('compliance_chat_monitoring_changed', 'compliance_setting', 'chat_monitoring', actorId, oldSnapshot, newSnapshot, orgId);
    log.info(`[ChatMonitoring] ${word} for org ${orgId}`);

    chatMonitoringFlag.invalidate(orgId);
    emitChanged(orgId);
    res.set('Cache-Control', 'no-store');
    res.json(await buildView(req, orgId));
});

router.get('/chat-monitoring/summary', requireAuth, requirePermission('admin_compliance'), validate({ query: SummaryQuery }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const days = Number(req.query.days || '30');
    const s = await complianceStore.getSettings(orgId);
    const selected = vocabList(V.SURFACES, s.chat_monitoring_surfaces);
    const kindsActive = vocabList(V.SIGNALS, s.chat_monitoring_signals).includes('kinds');
    const effectiveFrom = rules.isoInstant(s.chat_monitoring_effective_from);
    const today = new Date();
    const employee = selected.some(x => V.isEmployeeSurface(x)) ? sup.windowFor('direct', { days, effectiveFrom, today }) : null;
    const visitor = selected.some(x => V.isVisitorSurface(x)) ? sup.windowFor('agent_public', { days, effectiveFrom, today }) : null;
    // The 90-day view minus the 30-day view is the weeks only the long view
    // holds. Those weeks must pass the people gate on their own, or the
    // difference between the two views would show what a small group did.
    const short = days > SHORT_DAYS && employee ? sup.windowFor('direct', { days: SHORT_DAYS, effectiveFrom, today }) : null;
    const surfaces = {};
    for (const surface of selected) {
        const w = V.isVisitorSurface(surface) ? visitor : employee;
        if (!w) { surfaces[surface] = { status: 'no_full_period' }; continue; }
        const range = { from: w.from, to: w.to, surfaces: [surface], granularity: w.granularity };
        const employeeSurface = V.isEmployeeSurface(surface);
        const restOnly = employeeSurface && short && short.from > w.from ? { from: w.from, toExclusive: short.from } : null;
        const [outcomeRows, kindRows, contributors, restContributors] = await Promise.all([
            chatSignalStore.outcomeTotals(orgId, range),
            kindsActive ? chatSignalStore.kindTotals(orgId, range) : [],
            employeeSurface ? chatSignalStore.contributorCount(orgId, surface, { from: w.from, toExclusive: w.toExclusive }) : null,
            restOnly ? chatSignalStore.contributorCount(orgId, surface, restOnly) : null,
        ]);
        const gate = restOnly ? Math.min(Number(contributors) || 0, Number(restContributors) || 0) : contributors;
        const fig = sup.surfaceFigures({ outcomeRows, kindRows, contributors: gate, surface, kindsActive });
        // The band shown is still the people of the whole window.
        if (fig.contributors !== undefined) fig.contributors = sup.contributorBand(contributors);
        surfaces[surface] = fig;
    }
    await userStore.logAccessAudit('compliance_chat_monitoring_viewed', 'compliance_setting', 'chat_monitoring', actorOf(req), null, { days }, orgId);
    const shape = (w) => (w ? { granularity: w.granularity, from: w.from, to: w.to } : null);
    res.set('Cache-Control', 'no-store');
    res.json({ window: { days, employee: shape(employee), visitor: shape(visitor) }, surfaces });
});

router.delete('/chat-monitoring/counts', requireAuth, requirePermission('admin_compliance'), validate({ query: NoQuery }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    // Counts still waiting in this process would otherwise be written back by
    // the next flush, after the rows are gone.
    require('../../core/privacy/chatSignals').discardOrg(orgId);
    const deleted = await chatSignalStore.deleteAll(orgId);
    const at = new Date().toISOString().slice(0, 10);
    await addEvidence(orgId, { action: 'chat_signals_deleted', rows: deleted, at });
    await userStore.logAccessAudit('compliance_chat_monitoring_counts_deleted', 'compliance_setting', 'chat_monitoring', actorOf(req), null, { rows: deleted, at }, orgId);
    log.info(`[ChatMonitoring] deleted ${deleted} count rows for org ${orgId}`);
    emitChanged(orgId);
    res.json({ deleted });
});

/**
 * Chain middleware for POST /dpia/:agentId (routes/compliance/dpia.js): after
 * a successful save of the org-wide 'chat_monitoring' DPIA, the resolver memo
 * is dropped and both checks re-run. Calls next() at once; the handler body
 * is untouched.
 */
function chatMonitoringDpiaHook(req, res, next) {
    if (req.params?.agentId === V.CHAT_MONITORING_DPIA_KEY) {
        res.on('finish', () => {
            if (res.statusCode >= 300) return;
            resolveOrgId(req).then((orgId) => {
                chatMonitoringFlag.invalidate(orgId);
                emitChanged(orgId);
            }).catch(() => { /* best-effort: the memo expires within 30 s anyway */ });
        });
    }
    next();
}

module.exports = router;
module.exports.chatMonitoringDpiaHook = chatMonitoringDpiaHook;
module.exports.snapshot = snapshot;
module.exports.PutBody = PutBody;
