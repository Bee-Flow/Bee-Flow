// @typecheck
/**
 * Incident clocks — the statutory reporting windows of the incident register,
 * as pure functions (no I/O). stores/incidentStore.js persists what these
 * compute; the deadline feed, the notifier and the routes re-use them through
 * the store's exports to explain a row.
 *
 *   GDPR  Art. 33      notification                detected + 72 h
 *   NIS2  Art. 23      early warning / notification detected + 24 h / 72 h
 *                      final report                detected + 1 month
 *   CRA   Art. 14      early warning               detected + 24 h
 *                      vulnerability notification  detected + 72 h
 *                      final report, vulnerability detected + 14 d
 *                      final report, severe        notification + 1 month
 *                      incident (Art. 14(4)(c))    (detected + 72 h + 1 month until notified)
 *   DORA  Art. 19      customer notice             detected + `dora_customer_notice_hours` (default 4)
 */

'use strict';

const { addCalendarMonths } = require('../utils/calendarMonths');

const VALID_REGIMES = new Set(['GDPR', 'NIS2', 'CRA', 'DORA']);
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** GDPR Art. 33(1) — kept as the exported legacy constant. */
const DEADLINE_HOURS = 72;
const DEFAULT_CUSTOMER_NOTICE_HOURS = 4;

/**
 * The statutory windows per regime, from detected_at. `final` is either
 * {days} or {months}; a month is a calendar month, clamped to the end of a
 * short month (31 Jan + 1 month = 28/29 Feb, utils/calendarMonths). The JS
 * Date overflow (31 Jan + 1 month = 3 Mar) would run past the deadline.
 *
 * CRA `final` is the vulnerability clock, Art. 14(2)(c). A severe incident
 * (any other kind under CRA) has its final report one month after the
 * incident notification, Art. 14(4)(c): `incidentFinal`, counted from
 * `authority_notified_at`, or from the latest lawful notification
 * (detected + 72 h) while none is recorded.
 */
const REGIME_CLOCKS = Object.freeze({
    GDPR: { notificationHours: 72 },
    NIS2: { earlyWarningHours: 24, notificationHours: 72, final: { months: 1 } },
    CRA: { earlyWarningHours: 24, notificationHours: 72, final: { days: 14 }, incidentFinal: { months: 1 } },
    DORA: { customerNotice: true },
});

function _addMonths(date, months) {
    return addCalendarMonths(date, months);
}

/** A CRA row that is not a vulnerability is a severe incident (Art. 14(3)/(4)). */
function _isCraSevereIncident(kind, regimes) {
    return !!kind && kind !== 'vulnerability' && regimes.includes('CRA');
}

function _earliest(dates) {
    const ts = dates.filter(Boolean).map(d => d.getTime());
    return ts.length ? new Date(Math.min(...ts)) : null;
}

/**
 * Normalise the caller's regimes: upper-cased, known, deduped. Without any,
 * a vulnerability is a CRA matter and everything else a GDPR one — the same
 * default the column carries.
 */
function normalizeRegimes(input, kind) {
    const list = Array.isArray(input) ? input : (typeof input === 'string' && input ? [input] : []);
    const out = [];
    for (const r of list) {
        const code = String(r || '').trim().toUpperCase();
        if (!code) continue;
        if (!VALID_REGIMES.has(code)) throw new Error(`invalid regime "${r}"`);
        if (!out.includes(code)) out.push(code);
    }
    if (out.length) return out;
    return kind === 'vulnerability' ? ['CRA'] : ['GDPR'];
}

/**
 * Compute every clock from detected_at for the given regimes. Pure — the
 * deadline notifier and the route re-use it to explain a row.
 *
 * `kind` splits the CRA final report: a vulnerability's runs 14 days
 * (Art. 14(2)(c)), a severe incident's one month after the notification
 * (Art. 14(4)(c)) — from `notifiedAt` when recorded, else from the latest
 * lawful notification (detected + 72 h). Without a kind the vulnerability
 * clock applies.
 *
 * @returns {{ early_warning_due_at: Date|null, notification_due_at: Date|null,
 *             final_report_due_at: Date|null, customer_notice_due_at: Date|null, deadline_at: Date }}
 * @param detectedAt
 * @param {{ regimes?: string[], customerNoticeHours?: number, kind?: string, notifiedAt?: string|Date|null }} [opts]
 */
function computeClocks(detectedAt, { regimes, customerNoticeHours, kind, notifiedAt } = {}) {
    const detected = detectedAt instanceof Date ? detectedAt : new Date(detectedAt);
    if (Number.isNaN(detected.getTime())) throw new Error('detected_at is not a date');
    const set = normalizeRegimes(regimes);
    const at = (ms) => new Date(detected.getTime() + ms);
    const notified = notifiedAt ? new Date(notifiedAt) : null;
    const severeCra = _isCraSevereIncident(kind, set);

    const early = [];
    const notification = [];
    const finals = [];
    let customer = null;
    for (const code of set) {
        const c = REGIME_CLOCKS[code];
        if (c.earlyWarningHours) early.push(at(c.earlyWarningHours * HOUR_MS));
        if (c.notificationHours) notification.push(at(c.notificationHours * HOUR_MS));
        if (code === 'CRA' && severeCra) {
            const from = notified && !Number.isNaN(notified.getTime()) ? notified : at(c.notificationHours * HOUR_MS);
            finals.push(_addMonths(from, c.incidentFinal.months));
        } else if (c.final?.days) {
            finals.push(at(c.final.days * DAY_MS));
        } else if (c.final?.months) {
            finals.push(_addMonths(detected, c.final.months));
        }
        if (c.customerNotice) {
            const hours = Number.isFinite(Number(customerNoticeHours)) && Number(customerNoticeHours) > 0
                ? Number(customerNoticeHours)
                : DEFAULT_CUSTOMER_NOTICE_HOURS;
            customer = at(hours * HOUR_MS);
        }
    }
    const early_warning_due_at = _earliest(early);
    const notification_due_at = _earliest(notification);
    const final_report_due_at = _earliest(finals);
    // The next thing due to somebody outside the organisation.
    const deadline_at = _earliest([early_warning_due_at, notification_due_at, customer, final_report_due_at])
        || at(DEADLINE_HOURS * HOUR_MS);
    return { early_warning_due_at, notification_due_at, final_report_due_at, customer_notice_due_at: customer, deadline_at };
}

/**
 * The earliest clock that is still OPEN for a stored row — what `deadline_at`
 * must hold after any stage stamp. Pure, so the notifier and the route can
 * re-use it to explain a row.
 *
 * A clock counts as open when its satisfying stamp is absent:
 *   early warning (NIS2/CRA 24 h)          → early_warning_sent_at
 *   notification  (GDPR 72 h · NIS2 · CRA)  → authority_notified_at
 *   customer notice (DORA)                  → customer_notified_at
 *   final report  (NIS2 +1 month · CRA 14 d / severe incident notification + 1 month) → final_report_sent_at
 *
 * The stored `*_due_at` columns win over a recomputation — `customer_notice_due_at`
 * is the only record of the org's `dora_customer_notice_hours` — and the
 * notification clock, which has no column of its own, is derived from
 * detected_at + regimes.
 *
 * @returns {Date|null} null when the incident is closed or every clock is met.
 */
function nextOpenDeadline(row) {
    if (!row) return null;
    if (row.status === 'closed') return null;
    const detected = row.detected_at ? new Date(row.detected_at) : null;
    if (!detected || Number.isNaN(detected.getTime())) return null;
    const toDate = (v) => {
        if (!v) return null;
        const d = v instanceof Date ? v : new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
    };
    let clocks;
    try {
        // Normalise WITH the kind so an absent regime list on a vulnerability
        // is CRA, not GDPR — computeClocks alone cannot see the kind.
        clocks = computeClocks(detected, {
            regimes: normalizeRegimes(_jsonArray(row.regimes), row.kind),
            kind: row.kind,
            notifiedAt: row.authority_notified_at,
        });
    } catch {
        return toDate(row.deadline_at);
    }
    const open = [];
    if (!row.early_warning_sent_at) open.push(toDate(row.early_warning_due_at) || clocks.early_warning_due_at);
    if (!row.authority_notified_at) open.push(clocks.notification_due_at);
    if (!row.customer_notified_at) open.push(toDate(row.customer_notice_due_at) || clocks.customer_notice_due_at);
    if (!row.final_report_sent_at) open.push(toDate(row.final_report_due_at) || clocks.final_report_due_at);
    return _earliest(open);
}

const _ms = (v) => {
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
};

/**
 * The final-report due date a CRA severe incident should carry now.
 * Art. 14(4)(c) counts from the incident notification, which is stamped
 * AFTER creation, so unlike every other clock this one moves with the row.
 * Null for any other row (its final clock is fixed at creation), once the
 * final report is filed, and for a row whose clocks cannot be computed.
 */
function _severeIncidentFinalDue(row) {
    if (!row || row.final_report_sent_at || row.status === 'closed' || !row.detected_at) return null;
    try {
        const regimes = normalizeRegimes(_jsonArray(row.regimes), row.kind);
        if (!_isCraSevereIncident(row.kind, regimes)) return null;
        return computeClocks(row.detected_at, { regimes, kind: row.kind, notifiedAt: row.authority_notified_at }).final_report_due_at;
    } catch {
        return null;
    }
}

function _jsonArray(v) {
    if (v == null) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
    return [];
}

module.exports = {
    HOUR_MS,
    DAY_MS,
    VALID_REGIMES,
    DEADLINE_HOURS,
    DEFAULT_CUSTOMER_NOTICE_HOURS,
    REGIME_CLOCKS,
    normalizeRegimes,
    computeClocks,
    nextOpenDeadline,
    _jsonArray,
    _ms,
    _severeIncidentFinalDue,
};
