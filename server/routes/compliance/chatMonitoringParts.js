// @typecheck strict
const { z, onUnknownKeys, typeError } = require('../../utils/zod');
const complianceStore = require('../../stores/complianceStore');
const V = require('../../stores/lib/chatMonitoringVocab');
const rules = require('../../stores/lib/chatMonitoringRules');
const { isOrgAdminForOrg, isSuperAdmin } = require('../../auth/permissions');
const { onEvidenceWriteFailed } = require('../../compliance/evidence/writeFailures');


const CHECK_ID = 'GDPR-Art35-chat-monitoring-safeguards';

/** The shorter of the summary's two views (30 and 90 days). */
const SHORT_DAYS = 30;

const DAY_MS = 86_400_000;

/** Shown disabled in the card. Voice waits for a transcript input gate (phase 3). */
const CATALOGUE_FUTURE_SURFACES = Object.freeze(['notebook']);

/** What a configuration that is on needs whatever the change: something to count. */
const STRUCTURAL_CODES = Object.freeze(['surfaces_required', 'surface_not_available', 'outcomes_required', 'signal_not_available', 'retention_days']);

const oneOf = (/** @type {string} */ name, /** @type {readonly string[]} */ values) => z.enum(/** @type {[string, ...string[]]} */ ([...values]), { error: () => `${name} is one of: ${values.join(', ')}.` });

const flag = (/** @type {string} */ name) => z.boolean({ error: `${name} is true or false.` });

const uniqueList = (/** @type {string} */ name, /** @type {readonly string[]} */ values, /** @type {number} */ max) => z.array(oneOf(name, values), { error: `${name} is a list.` })
    .max(max, `${name} has at most ${max} entries.`)
    .refine(a => new Set(a).size === a.length, `${name} lists each value once.`);

const date = (/** @type {string} */ name) => z.string({ error: `${name} is a date (YYYY-MM-DD) or null.` })
    .refine(v => rules.dayString(v) === v, `${name} is a date (YYYY-MM-DD) or null.`)
    .nullable();

const retention = (/** @type {string} */ name) => z.number({ error: `${name} is a number of days.` })
    .int(`${name} is a whole number of days.`)
    .min(V.RETENTION.min, `${name} is at least ${V.RETENTION.min} days.`)
    .max(V.RETENTION.max, `${name} is at most ${V.RETENTION.max} days.`);

const Scope = z.object({
    surfaces: uniqueList('works_council_scope.surfaces', V.SURFACES, V.SURFACES.length),
    signals: uniqueList('works_council_scope.signals', V.SIGNALS, V.SIGNALS.length),
    max_retention_days: retention('works_council_scope.max_retention_days'),
}, { error: onUnknownKeys('works_council_scope takes surfaces, signals and max_retention_days only.', typeError({ required: 'works_council_scope is an object or null.', invalid: 'works_council_scope is an object or null.' })) })
    .strict()
    .nullable();

const PutBody = z.object({
    enabled: flag('enabled'),
    surfaces: uniqueList('surfaces', V.SURFACES, V.SURFACES.length),
    signals: uniqueList('signals', V.SIGNALS, V.SIGNALS.length),
    effective_from: z.string({ error: typeError({ invalid: 'effective_from is a moment (ISO 8601) or null.' }) })
        .max(40, 'effective_from is a moment (ISO 8601) or null.').nullish(),
    retention_days: retention('retention_days'),
    legal_basis: oneOf('legal_basis', V.LEGAL_BASES).nullable(),
    works_council: oneOf('works_council', V.WORKS_COUNCIL).nullable(),
    works_council_reason: oneOf('works_council_reason', V.WORKS_COUNCIL_REASONS).nullable(),
    works_council_at: date('works_council_at'),
    works_council_scope: Scope,
    dpia_ref: z.string({ error: 'dpia_ref is text or null.' })
        .trim().min(1, 'dpia_ref is text or null.').max(200, 'dpia_ref is at most 200 characters.').nullable(),
    dpia_at: date('dpia_at'),
    dpia_risk_level: oneOf('dpia_risk_level', V.DPIA_RISK_LEVELS).nullable(),
    dpo_advice_at: date('dpo_advice_at'),
    prior_consultation_at: date('prior_consultation_at'),
    notice_url: z.string({ error: 'notice_url is an https link or null.' })
        .max(500, 'notice_url is at most 500 characters.')
        .refine(v => rules.httpsUrl(v) !== null, 'notice_url is an https link or null.')
        .nullable(),
    notice_published_at: date('notice_published_at'),
    acknowledgements: z.object({
        notice_published: flag('acknowledgements.notice_published').optional(),
        ropa_reviewed: flag('acknowledgements.ropa_reviewed').optional(),
        informed_before_start: flag('acknowledgements.informed_before_start').optional(),
        lia_documented: flag('acknowledgements.lia_documented').optional(),
    }, { error: onUnknownKeys('acknowledgements takes notice_published, ropa_reviewed, informed_before_start and lia_documented only.', typeError({ invalid: 'acknowledgements is an object.' })) })
        .strict()
        .prefault({}),
}, { error: onUnknownKeys('The body has a field chat signals do not know.', typeError({ invalid: 'The body is a JSON object.' })) }).strict();

const SummaryQuery = z.object({
    days: z.enum(['30', '90'], { error: () => 'days is 30 or 90.' }).optional(),
}, { error: onUnknownKeys('The summary takes days only.') }).strict();

const NoQuery = z.object({}, { error: onUnknownKeys('This takes no query parameters.') }).strict();

const actorOf = (/** @type {import('express').Request} */ req) => req.session?.user?.id || null;

const dayOf = (/** @type {unknown} */ v) => (v instanceof Date ? v.toISOString().slice(0, 10) : rules.dayString(v));

const inVocab = (/** @type {readonly string[]} */ list, /** @type {string | null | undefined} */ v) => (typeof v === 'string' && list.includes(v) ? v : null);

const vocabList = (/** @type {readonly string[]} */ list, /** @type {unknown} */ v) => (Array.isArray(v) ? v.filter((/** @type {string} */ x) => list.includes(x)) : []);

/**
 * May this request widen chat signals for the org?
 * @param {import('express').Request} req
 * @param {string} orgId
 */
async function canWiden(req, orgId) {
    if (orgId === 'default') return isSuperAdmin(req);
    try { return await isOrgAdminForOrg(req, orgId); } catch { return false; }
}

/**
 * The body as the settings columns it replaces (the derived ones come later).
 * @param {import('zod').z.infer<typeof PutBody>} b
 */
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
 * @param {string} orgId
 * @param {Record<string, unknown>} payload
 */
function addEvidence(orgId, payload) {
    const row = { organization_id: orgId, check_id: CHECK_ID, subject_type: 'setting', subject_id: 'chat_monitoring', payload };
    return complianceStore.addEvidence(row).catch(onEvidenceWriteFailed(row));
}

module.exports = { SHORT_DAYS, DAY_MS, CATALOGUE_FUTURE_SURFACES, STRUCTURAL_CODES, PutBody, SummaryQuery, NoQuery, actorOf, dayOf, inVocab, vocabList, canWiden, columnsFromBody, addEvidence };
