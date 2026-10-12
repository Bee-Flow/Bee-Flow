// @typecheck
'use strict';

/**
 * Chat signals: the preconditions, evaluated once for three callers.
 *
 *   routes/compliance/chatMonitoring.js   refuses a save with 422 (on the way in)
 *   core/entitlements/chatMonitoringFlag  pauses a surface (at runtime)
 *   GDPR-Art35-chat-monitoring-safeguards fails (afterwards)
 *
 * One list of codes serves the 422 `details.missing`, the resolver's
 * `paused[].missing`, the check and the card labels
 * (`chat_monitoring.missing.<code>`). The resolver and the check never see
 * acknowledgements; only the PUT does (putCodes, planEffectiveFrom, planLiaAt).
 *
 * Inputs are the stored settings row shape (`chat_monitoring_*` columns of
 * compliance_settings), the latest `dpia_assessments` row for the key
 * 'chat_monitoring', and `now`. Pure: requires only the vocabulary.
 */

const V = require('./chatMonitoringVocab');

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_URL = 500;
/** How far in the past a requested start may lie before it reads as "in the past". */
const PAST_TOLERANCE_MS = 60_000;

/** Every code, in the order the card lists them. */
const CODES = Object.freeze([
    'surfaces_required', 'surface_not_available', 'outcomes_required', 'signal_not_available',
    'legal_basis', 'lia_documented', 'retention_days',
    'notice_published', 'ropa_reviewed', 'effective_from', 'informed_before_start',
    'objection_unavailable', 'default_bucket_has_orgs',
    'dpia', 'dpia_risk_level', 'prior_consultation_at', 'dpo_advice_at',
    'works_council', 'works_council_reason', 'works_council_at', 'works_council_scope',
    'notice_url', 'notice_published_at', 'agent_public_notice',
]);

const arr = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);

/**
 * A DATE column as 'YYYY-MM-DD'. node-postgres builds a DATE as local
 * midnight, a TIMESTAMPTZ as an instant; strings pass through.
 * @param {any} v
 * @returns {string|null}
 */
function dayString(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string') {
        const head = v.trim().slice(0, 10);
        if (DAY_RE.test(head) && v.trim().length === 10) {
            // JS rolls 2026-02-31 over into March; a date that does not exist is no date.
            const t = Date.parse(`${head}T00:00:00Z`);
            return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === head ? head : null;
        }
        const t = Date.parse(v);
        return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
    }
    if (v instanceof Date) {
        if (!Number.isFinite(v.getTime())) return null;
        const localMidnight = v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0 && v.getMilliseconds() === 0;
        if (localMidnight) {
            const p = (n) => String(n).padStart(2, '0');
            return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
        }
        return v.toISOString().slice(0, 10);
    }
    return null;
}

/**
 * A TIMESTAMPTZ as its exact ISO string (the notice version), or null.
 * @param {any} v
 * @returns {string|null}
 */
function isoInstant(v) {
    if (v === null || v === undefined || v === '') return null;
    const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const todayOf = (now) => new Date(now instanceof Date ? now.getTime() : Number(now)).toISOString().slice(0, 10);

/** A date that is set and not after today. */
function setAndNotFuture(v, now) {
    const d = dayString(v);
    return !!d && d <= todayOf(now);
}

/**
 * An https URL of at most 500 characters, else null.
 * @param {any} v
 * @returns {string|null}
 */
function httpsUrl(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s || s.length > MAX_URL) return null;
    try {
        return new URL(s).protocol === 'https:' ? s : null;
    } catch {
        return null;
    }
}

/**
 * The stored retention, null read as the default. A stored value outside the
 * range is returned as is, so evaluate() can name it.
 * @param {any} settings
 */
function retentionOf(settings) {
    const v = settings?.chat_monitoring_retention_days;
    if (v === null || v === undefined || v === '') return V.RETENTION.default;
    const n = Number(v);
    return Number.isInteger(n) ? n : NaN;
}

/** The retention clamped into range, for readers that must not fail. @param {any} settings */
function clampedRetention(settings) {
    const n = retentionOf(settings);
    if (!Number.isFinite(n)) return V.RETENTION.default;
    return Math.min(V.RETENTION.max, Math.max(V.RETENTION.min, n));
}

/**
 * The works-council scope in one shape.
 * @param {any} scope
 * @returns {{ surfaces: string[], signals: string[], max_retention_days: number|null }}
 */
function normScope(scope) {
    const s = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {};
    const max = Number(s.max_retention_days);
    return {
        surfaces: [...new Set(arr(s.surfaces))].sort(),
        signals: [...new Set(arr(s.signals))].sort(),
        max_retention_days: Number.isInteger(max) ? max : null,
    };
}

/**
 * Does the consent's scope cover what is (or would be) counted?
 * @param {any} scope
 * @param {{ surfaces: string[], signals: string[], retentionDays: number }} wanted
 */
function scopeCovers(scope, { surfaces, signals, retentionDays }) {
    const sc = normScope(scope);
    if (!(surfaces || []).every(x => sc.surfaces.includes(x))) return false;
    if (!(signals || []).every(x => sc.signals.includes(x))) return false;
    return sc.max_retention_days !== null && Number(retentionDays) <= sc.max_retention_days;
}

/** Is `next` wider than `prev` in any direction? */
function scopeWider(next, prev) {
    const n = normScope(next);
    const p = normScope(prev);
    if (n.surfaces.some(x => !p.surfaces.includes(x))) return true;
    if (n.signals.some(x => !p.signals.includes(x))) return true;
    if (n.max_retention_days !== null && (p.max_retention_days === null || n.max_retention_days > p.max_retention_days)) return true;
    return false;
}

function sameScope(a, b) {
    return JSON.stringify(normScope(a)) === JSON.stringify(normScope(b));
}

/**
 * The DPIA that covers chat signals for employee surfaces.
 *
 *   internal  the latest dpia_assessments row for 'chat_monitoring' (wins
 *             when both exist). A null expires_at counts as approved_at + 365
 *             days (amendment 14).
 *   external  chat_monitoring_dpia_ref + chat_monitoring_dpia_at (+ risk
 *             level): current for 365 days from its date, never from a date
 *             in the future.
 *
 * @param {any} settings
 * @param {any} dpiaRow
 * @param {Date} [now]
 * @returns {{ kind: 'internal'|'external'|'none', current: boolean, expiresAt: Date|null, riskLevel: 'low'|'medium'|'high'|null, approvedAt: Date|null }}
 */
function dpiaStatus(settings, dpiaRow, now = new Date()) {
    const t = now.getTime();
    const risk = (v) => (V.DPIA_RISK_LEVELS.includes(v) ? v : null);
    if (dpiaRow) {
        const approvedMs = dpiaRow.approved_at ? new Date(dpiaRow.approved_at).getTime() : NaN;
        const approvedAt = Number.isFinite(approvedMs) ? new Date(approvedMs) : null;
        let expiresAt = null;
        if (dpiaRow.expires_at) {
            const e = new Date(dpiaRow.expires_at).getTime();
            expiresAt = Number.isFinite(e) ? new Date(e) : null;
        } else if (approvedAt) {
            expiresAt = new Date(approvedMs + V.DPIA_DEFAULT_VALIDITY_DAYS * DAY_MS);
        }
        const current = !!approvedAt && approvedMs <= t && !!expiresAt && t < expiresAt.getTime();
        return { kind: 'internal', current, expiresAt, riskLevel: risk(dpiaRow.risk_level), approvedAt };
    }
    const ref = typeof settings?.chat_monitoring_dpia_ref === 'string' ? settings.chat_monitoring_dpia_ref.trim() : '';
    const at = dayString(settings?.chat_monitoring_dpia_at);
    if (ref && at) {
        const atMs = Date.parse(`${at}T00:00:00.000Z`);
        const expiresAt = new Date(atMs + V.DPIA_DEFAULT_VALIDITY_DAYS * DAY_MS);
        const current = at <= todayOf(now) && t < expiresAt.getTime();
        return { kind: 'external', current, expiresAt, riskLevel: risk(settings.chat_monitoring_dpia_risk_level), approvedAt: new Date(atMs) };
    }
    return { kind: 'none', current: false, expiresAt: null, riskLevel: null, approvedAt: null };
}

/**
 * Every missing code for a configuration, judged as if it were switched on.
 *
 * @param {any} settings the settings row (or the row a save would write)
 * @param {{ dpiaRow?: any, now?: Date, installHasOrganisations?: boolean, orgKey?: string, privacyNoticeUrl?: string|null }} [ctx]
 * @returns {{ global: string[], bySurface: Record<string, string[]> }}
 */
function evaluate(settings, { dpiaRow = null, now = new Date(), installHasOrganisations = false, orgKey = 'default', privacyNoticeUrl } = {}) {
    const s = settings || {};
    const surfaces = [...new Set(arr(s.chat_monitoring_surfaces))];
    const signals = [...new Set(arr(s.chat_monitoring_signals))];
    const global = [];

    if (!surfaces.length) global.push('surfaces_required');
    if (surfaces.some(x => !V.PHASE.surfaces.includes(x) || V.HUMAN_TO_HUMAN.includes(x))) global.push('surface_not_available');
    if (!signals.includes('outcomes')) global.push('outcomes_required');
    if (signals.some(x => !V.PHASE.signals.includes(x))) global.push('signal_not_available');
    const basis = s.chat_monitoring_legal_basis;
    if (!V.LEGAL_BASES.includes(basis)) global.push('legal_basis');
    else if (basis === 'art6_1_f' && !isoInstant(s.chat_monitoring_lia_at)) global.push('lia_documented');
    const retention = retentionOf(s);
    if (!(retention >= V.RETENTION.min && retention <= V.RETENTION.max)) global.push('retention_days');

    const employeeSelected = surfaces.filter(x => V.SURFACES.includes(x) && V.isEmployeeSurface(x));
    const employee = () => {
        const codes = [];
        if (V.PHASE.objection !== true) codes.push('objection_unavailable');
        if (orgKey === 'default' && installHasOrganisations) codes.push('default_bucket_has_orgs');
        const d = dpiaStatus(s, dpiaRow, now);
        if (d.kind === 'none' || !d.current) codes.push('dpia');
        if (d.kind === 'external' && !d.riskLevel) codes.push('dpia_risk_level');
        if (d.riskLevel === 'high' && !setAndNotFuture(s.chat_monitoring_prior_consultation_at, now)) codes.push('prior_consultation_at');
        if ((s.dpo_name || s.dpo_email) && !setAndNotFuture(s.chat_monitoring_dpo_advice_at, now)) codes.push('dpo_advice_at');
        const wc = s.chat_monitoring_works_council;
        if (!V.WORKS_COUNCIL.includes(wc) || wc === 'pending') {
            codes.push('works_council');
        } else if (wc === 'not_applicable') {
            if (!V.WORKS_COUNCIL_REASONS.includes(s.chat_monitoring_works_council_reason)) codes.push('works_council_reason');
        } else {
            if (!setAndNotFuture(s.chat_monitoring_works_council_at, now)) codes.push('works_council_at');
            if (!scopeCovers(s.chat_monitoring_works_council_scope, { surfaces: employeeSelected, signals, retentionDays: retention })) {
                codes.push('works_council_scope');
            }
        }
        if (!httpsUrl(s.chat_monitoring_notice_url)) codes.push('notice_url');
        const published = dayString(s.chat_monitoring_notice_published_at);
        const start = isoInstant(s.chat_monitoring_effective_from);
        if (!published || published > todayOf(now) || (start && published > start.slice(0, 10))) codes.push('notice_published_at');
        return codes;
    };
    const visitor = () => {
        const fallback = privacyNoticeUrl === undefined ? s.privacy_notice_url : privacyNoticeUrl;
        return httpsUrl(s.chat_monitoring_notice_url) || httpsUrl(fallback) ? [] : ['agent_public_notice'];
    };

    /** @type {Record<string, string[]>} */
    const bySurface = {};
    let employeeCodes = null;
    for (const surface of surfaces) {
        if (!V.SURFACES.includes(surface)) continue;
        if (V.isVisitorSurface(surface)) bySurface[surface] = visitor();
        else bySurface[surface] = [...(employeeCodes || (employeeCodes = employee()))];
    }
    return { global, bySurface };
}

/** Every code of an evaluation, de-duplicated, in CODES order. @param {{global: string[], bySurface: Record<string, string[]>}} ev */
function allCodes(ev, extra = []) {
    const set = new Set([...(ev?.global || []), ...Object.values(ev?.bySurface || {}).flat(), ...extra]);
    return CODES.filter(c => set.has(c));
}

/** The parts of a settings row a change classification looks at. */
function _shape(row) {
    const r = row || {};
    return {
        enabled: r.chat_monitoring_enabled === true,
        surfaces: [...new Set(arr(r.chat_monitoring_surfaces))],
        signals: [...new Set(arr(r.chat_monitoring_signals))],
        retention: retentionOf(r),
        basis: r.chat_monitoring_legal_basis || null,
        scope: r.chat_monitoring_works_council_scope,
        consent: V.WORKS_COUNCIL_CONSENT.includes(r.chat_monitoring_works_council),
        attested: JSON.stringify([
            r.chat_monitoring_works_council || null, r.chat_monitoring_works_council_reason || null,
            dayString(r.chat_monitoring_works_council_at), r.chat_monitoring_dpia_ref || null,
            dayString(r.chat_monitoring_dpia_at), r.chat_monitoring_dpia_risk_level || null,
            dayString(r.chat_monitoring_dpo_advice_at), dayString(r.chat_monitoring_prior_consultation_at),
            r.chat_monitoring_notice_url || null, dayString(r.chat_monitoring_notice_published_at),
        ]),
    };
}

/**
 * What a save changes.
 *
 *   widen     switched on; a surface or signal added; retention increased
 *             (amendment 9); the legal basis changed; the works-council scope
 *             changed while the works council consented (the scope means
 *             nothing for 'not_applicable' or 'pending'). Only a result that
 *             is on can widen.
 *   narrow    switched off; a surface or signal removed; retention decreased.
 *   maintain  on before and after, not a widen, and either not a narrow or a
 *             narrow that also edits an attestation (notice, DPIA,
 *             works-council status/reason/date, DPO advice, prior
 *             consultation): only a save that purely narrows skips the
 *             preconditions.
 *   off       the result is off.
 *   employeeWidened  a widen that touches an employee surface or signal.
 *   visitorOnly      a widen that touches website visitors only.
 *
 * @param {any} before settings row
 * @param {any} after settings row a save would write
 */
function classifyChange(before, after) {
    const b = _shape(before);
    const a = _shape(after);
    const added = (x, y) => y.some(v => !x.includes(v));
    const surfacesAdded = added(b.surfaces, a.surfaces);
    const signalsAdded = added(b.signals, a.signals);
    const retentionUp = Number.isFinite(a.retention) && Number.isFinite(b.retention) && a.retention > b.retention;
    const retentionDown = Number.isFinite(a.retention) && Number.isFinite(b.retention) && a.retention < b.retention;
    const basisChanged = a.basis !== b.basis;
    const scopeChanged = a.consent && !sameScope(b.scope, a.scope);

    const off = !a.enabled;
    const widen = a.enabled && (!b.enabled || surfacesAdded || signalsAdded || retentionUp || basisChanged || scopeChanged);
    const narrow = b.enabled && (!a.enabled || added(a.surfaces, b.surfaces) || added(a.signals, b.signals) || retentionDown);
    const maintain = a.enabled && b.enabled && !widen && (!narrow || a.attested !== b.attested);

    const empAfter = a.surfaces.filter(x => V.isEmployeeSurface(x));
    const empBefore = b.surfaces.filter(x => V.isEmployeeSurface(x));
    const employeeWidened = widen && empAfter.length > 0
        && (!b.enabled || added(empBefore, empAfter) || signalsAdded || retentionUp || basisChanged || scopeChanged);
    return { widen, narrow, maintain, off, employeeWidened, visitorOnly: widen && !employeeWidened };
}

/** The single word for evidence: widen wins over narrow. @param {ReturnType<typeof classifyChange>} change */
function changeWord(change) {
    if (change.off) return 'off';
    if (change.widen) return 'widen';
    if (change.narrow) return 'narrow';
    return 'maintain';
}

/**
 * The start of counting (and the notice version) a save writes.
 *
 *   off                    cleared
 *   employee widen         the requested moment, or now + 7 days; earlier than
 *                          7 days only with informed_before_start, never in
 *                          the past (60 s tolerance; a moment within it is
 *                          read as now)
 *   visitor-only widen     now: it takes effect at once
 *   narrow / maintain      unchanged, so the old notice still announces at
 *                          least what is counted
 *
 * The 7 days are compared by UTC date: a start on the date seven days from
 * today needs no acknowledgement, whatever its hour.
 *
 * @param {{ change: ReturnType<typeof classifyChange>, before: any, requested?: any, acknowledgements?: any, now?: Date }} p
 * @returns {{ value: string|null, codes: string[] }}
 */
function planEffectiveFrom({ change, before, requested, acknowledgements = {}, now = new Date() }) {
    if (change.off) return { value: null, codes: [] };
    const t = now.getTime();
    if (change.employeeWidened) {
        const lead = new Date(t + V.NOTICE_LEAD_DAYS * DAY_MS);
        if (requested === null || requested === undefined || requested === '') return { value: lead.toISOString(), codes: [] };
        const r = typeof requested === 'string' || requested instanceof Date ? new Date(requested).getTime() : NaN;
        if (!Number.isFinite(r) || r < t - PAST_TOLERANCE_MS) return { value: null, codes: ['effective_from'] };
        const value = new Date(Math.max(r, t)).toISOString();
        if (value.slice(0, 10) < lead.toISOString().slice(0, 10) && acknowledgements?.informed_before_start !== true) {
            return { value, codes: ['informed_before_start'] };
        }
        return { value, codes: [] };
    }
    if (change.widen) return { value: new Date(t).toISOString(), codes: [] };
    return { value: isoInstant(before?.chat_monitoring_effective_from), codes: [] };
}

/**
 * The legitimate-interest attestation stamp a save writes: now when the basis
 * is 6(1)(f) and it was attested in this request; kept while the basis stays
 * 6(1)(f); cleared when the basis is anything else.
 * @param {{ before: any, basis: any, acknowledgements?: any, now?: Date }} p
 * @returns {string|null}
 */
function planLiaAt({ before, basis, acknowledgements = {}, now = new Date() }) {
    if (basis !== 'art6_1_f') return null;
    if (acknowledgements?.lia_documented === true) return now.toISOString();
    if (before?.chat_monitoring_legal_basis === 'art6_1_f') return isoInstant(before?.chat_monitoring_lia_at);
    return null;
}

/**
 * The codes only a save can miss: the acknowledgements of a widen
 * (amendment 15: for website visitors too) and the re-attestation of a wider
 * works-council scope with a newer date (amendment 13).
 * @param {{ change: ReturnType<typeof classifyChange>, before: any, after: any, acknowledgements?: any }} p
 * @returns {string[]}
 */
function putCodes({ change, before, after, acknowledgements = {} }) {
    const codes = [];
    if (change.widen) {
        if (acknowledgements?.notice_published !== true) codes.push('notice_published');
        if (acknowledgements?.ropa_reviewed !== true) codes.push('ropa_reviewed');
    }
    const employee = arr(after?.chat_monitoring_surfaces).some(x => V.SURFACES.includes(x) && V.isEmployeeSurface(x));
    if (employee && V.WORKS_COUNCIL_CONSENT.includes(after?.chat_monitoring_works_council)
        && scopeWider(after?.chat_monitoring_works_council_scope, before?.chat_monitoring_works_council_scope)) {
        const prevAt = dayString(before?.chat_monitoring_works_council_at);
        const nextAt = dayString(after?.chat_monitoring_works_council_at);
        if (prevAt && !(nextAt && nextAt > prevAt)) codes.push('works_council_scope');
    }
    return codes;
}

module.exports = {
    CODES,
    dpiaStatus,
    evaluate,
    allCodes,
    classifyChange,
    changeWord,
    scopeCovers,
    scopeWider,
    normScope,
    planEffectiveFrom,
    planLiaAt,
    putCodes,
    httpsUrl,
    dayString,
    isoInstant,
    retentionOf,
    clampedRetention,
};
