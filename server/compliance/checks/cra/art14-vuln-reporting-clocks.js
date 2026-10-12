/**
 * CRA Art. 14(1)(3)(4) — vulnerability reporting clocks operational.
 *
 * Since 2026-09-11 a manufacturer must report an actively exploited
 * vulnerability (and a severe incident affecting a product's security) to the
 * CSIRT / ENISA single reporting platform in three steps:
 *   • early warning        within 24 h of becoming aware,
 *   • vulnerability notice within 72 h,
 *   • final report         within 14 days after a corrective measure is
 *                          available (vulnerability, Art. 14(2)(c)), or one
 *                          month after the incident notification (severe
 *                          incident, Art. 14(4)(c)).
 *
 * The incident register (compliance_incidents) is the working proof: CRA-regime
 * rows (`kind='vulnerability'` or 'CRA' ∈ `regimes`) carry `early_warning_*` and
 * `final_report_*` clocks next to the GDPR 72-hour `authority_notified_at`
 * stamp. Signals:
 *   1. RESPONSE (automated) — an open CRA row past a clock without its stamp
 *      is a live Art. 14 breach → fail; a clock due within 6 h → warn.
 *   2. PREPARATION (cheap procedure signals) — reporting channel and PSIRT
 *      contact configured, and the published incident-response policy
 *      mentions vulnerability handling → otherwise warn.
 *
 * Like incidentStore, the platform never files with a CSIRT itself — the
 * stamps are attested by an admin; only the clocks are automated.
 *
 * Also counts for NIS2 Art. 23 (incident notification) and ISO A.5.24.
 */

const db = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');
const incidentStore = require('../../../stores/incidentStore');
const { addCalendarMonths } = require('../../../utils/calendarMonths');

const EARLY_WARNING_HOURS = 24;
const NOTIFICATION_HOURS = 72;
const FINAL_REPORT_DAYS = 14;
// Art. 14(4)(c): a severe incident's final report, one month after the notification.
const INCIDENT_FINAL_REPORT_MONTHS = 1;
const DUE_SOON_HOURS = 6;
const SAMPLE_LIMIT = 10;
const ROW_LIMIT = 200;
const VULN_PROCEDURE_RE = /vulnerab|kwetsbaar/i;

function _isNotProvisioned(e) {
    return e && (e.code === '42703' || e.code === '42P01');
}

function _hasCraRegime(row) {
    if (!row) return false;
    if (row.kind === 'vulnerability') return true;
    let regimes = row.regimes;
    if (typeof regimes === 'string') { try { regimes = JSON.parse(regimes); } catch { regimes = []; } }
    return Array.isArray(regimes) && regimes.some(r => String(r).toUpperCase() === 'CRA');
}

function _ts(value) {
    if (!value) return null;
    const t = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(t) ? t : null;
}

/**
 * Open CRA-regime incidents. Prefers incidentStore.listOpenClocks (added by
 * the incident-register workstream) and falls back to a direct SELECT so
 * this check works against either version of the store.
 */
async function _openCraIncidents(orgId) {
    const fn = incidentStore.listOpenClocks;
    if (typeof fn === 'function') {
        const rows = await fn.call(incidentStore, orgId);
        if (Array.isArray(rows)) return rows.filter(r => r && r.status !== 'closed' && _hasCraRegime(r)).slice(0, ROW_LIMIT);
    }
    return db.getAll(`
        SELECT id, kind, regimes, status, severity, detected_at, deadline_at,
               early_warning_due_at, early_warning_sent_at,
               final_report_due_at, final_report_sent_at,
               authority_notified_at, exploited_in_wild
        FROM compliance_incidents
        WHERE organization_id = $1
          AND status <> 'closed'
          AND (kind = 'vulnerability' OR COALESCE(regimes, '[]'::jsonb) ? 'CRA')
        ORDER BY detected_at DESC
        LIMIT ${ROW_LIMIT}
    `, [orgId]);
}

/**
 * The final-report fallback when the register has no due column: 14 days for
 * a vulnerability; for a severe incident (any other kind) one month after the
 * notification, or after the latest lawful notification (detected + 72 h)
 * while none is recorded.
 */
function _fallbackFinalDue(row, detected) {
    if (!row.kind || row.kind === 'vulnerability') return detected + FINAL_REPORT_DAYS * 86400e3;
    const from = _ts(row.authority_notified_at) ?? detected + NOTIFICATION_HOURS * 3600e3;
    return addCalendarMonths(new Date(from), INCIDENT_FINAL_REPORT_MONTHS).getTime();
}

/**
 * Per-row clock state. Due timestamps fall back to detected_at + the legal
 * window when the register has no explicit due column filled in.
 */
function _clocksFor(row, now) {
    const detected = _ts(row.detected_at) ?? now;
    const clocks = [
        {
            clock: 'early_warning',
            due_at: _ts(row.early_warning_due_at) ?? detected + EARLY_WARNING_HOURS * 3600e3,
            sent_at: _ts(row.early_warning_sent_at),
        },
        {
            clock: 'notification',
            due_at: detected + NOTIFICATION_HOURS * 3600e3,
            sent_at: _ts(row.authority_notified_at),
        },
        {
            clock: 'final_report',
            due_at: _ts(row.final_report_due_at) ?? _fallbackFinalDue(row, detected),
            sent_at: _ts(row.final_report_sent_at),
        },
    ];
    return clocks.map(c => ({
        ...c,
        overdue: !c.sent_at && c.due_at < now,
        due_soon: !c.sent_at && c.due_at >= now && c.due_at - now <= DUE_SOON_HOURS * 3600e3,
    }));
}

module.exports = {
    id: 'CRA-Art14-vuln-reporting-clocks',
    regulation: 'CRA',
    article: 'Art. 14',
    frameworks: [
        { regulation: 'NIS2', ref: 'Art. 23' },
        { regulation: 'ISO27001', ref: 'A.5.24' },
    ],
    severity: 'critical',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.check_cra_vuln_clocks_title',
    descriptionKey: 'compliance.check_cra_vuln_clocks_desc',
    remediationKey: 'compliance.check_cra_vuln_clocks_fix',
    remediationLink: 'admin/compliance/vulnerabilities',

    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId) || {};
        if (settings.framework_relevance?.cra === 'not_relevant') {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'The CRA was marked not relevant for this organisation.',
            };
        }
        const craRole = settings.cra_role || null;
        // Art. 14 binds manufacturers. An importer or distributor informs the
        // manufacturer (and, on a significant risk, the market surveillance
        // authority) under Art. 19 and 20 — it runs no CSIRT/ENISA clocks. An
        // undeclared role keeps the clocks: the conservative reading.
        if (craRole === 'user_only' || craRole === 'distributor') {
            return {
                status: 'not_applicable',
                evidence: { cra_role: craRole },
                details: craRole === 'distributor'
                    ? 'This organisation imports or distributes products with digital elements: the Art. 14 reporting clocks bind the manufacturer. Importers and distributors inform the manufacturer of a vulnerability without undue delay, and the market surveillance authority when there is a significant cybersecurity risk (CRA Art. 19 and 20). One that places a product under its own name or trademark, or substantially modifies it, is a manufacturer (Art. 21): declare that role instead.'
                    : 'This organisation only uses products with digital elements and does not manufacture or distribute them — Art. 14 reporting duties fall on the manufacturer.',
            };
        }

        let rows;
        try {
            rows = await _openCraIncidents(orgId);
        } catch (e) {
            if (_isNotProvisioned(e)) {
                return {
                    status: 'warn',
                    evidence: { cra_role: craRole, registry_provisioned: false },
                    details: 'not provisioned yet — the incident register has no CRA clock columns yet, so reporting deadlines cannot be tracked. Restart the server after the update or run the pending migrations.',
                };
            }
            throw e;
        }

        const now = Date.now();
        const summary = {
            early_warning: { overdue: 0, due_soon: 0, sent: 0 },
            notification: { overdue: 0, due_soon: 0, sent: 0 },
            final_report: { overdue: 0, due_soon: 0, sent: 0 },
        };
        const overdueSample = [];
        let exploited = 0;
        for (const row of rows) {
            if (row.exploited_in_wild) exploited += 1;
            for (const c of _clocksFor(row, now)) {
                if (c.sent_at) summary[c.clock].sent += 1;
                if (c.overdue) {
                    summary[c.clock].overdue += 1;
                    if (overdueSample.length < SAMPLE_LIMIT) {
                        overdueSample.push({ id: row.id, kind: row.kind || null, clock: c.clock, due_at: new Date(c.due_at).toISOString() });
                    }
                }
                if (c.due_soon) summary[c.clock].due_soon += 1;
            }
        }
        const overdueTotal = Object.values(summary).reduce((n, s) => n + s.overdue, 0);
        const dueSoonTotal = Object.values(summary).reduce((n, s) => n + s.due_soon, 0);

        // Preparation signals — booleans only; the PSIRT address itself never
        // enters the evidence row.
        const channelSet = typeof settings.cra_reporting_channel === 'string' && settings.cra_reporting_channel.trim().length > 0;
        const psirtSet = typeof settings.psirt_contact_email === 'string' && /@/.test(settings.psirt_contact_email);
        let procedureMentionsVulns = null; // null = no published policy to inspect
        try {
            const ismsDocStore = require('../../../stores/ismsDocStore');
            const published = await ismsDocStore.getPublishedBody(orgId, 'incident-response');
            if (published && typeof published.body === 'string') {
                procedureMentionsVulns = VULN_PROCEDURE_RE.test(published.body);
            }
        } catch { /* ISMS documents not provisioned — signal stays unknown */ }

        const evidence = {
            cra_role: craRole,
            registry_provisioned: true,
            open_cra_incidents: rows.length,
            actively_exploited: exploited,
            clocks: summary,
            windows: {
                early_warning_hours: EARLY_WARNING_HOURS,
                notification_hours: NOTIFICATION_HOURS,
                final_report_days: FINAL_REPORT_DAYS,
                incident_final_report_months: INCIDENT_FINAL_REPORT_MONTHS,
            },
            overdue_sample: overdueSample,
            reporting_channel_set: channelSet,
            psirt_contact_set: psirtSet,
            procedure_mentions_vulns: procedureMentionsVulns,
        };

        if (overdueTotal > 0) {
            const parts = [];
            if (summary.early_warning.overdue) parts.push(`${summary.early_warning.overdue} past the 24-hour early warning`);
            if (summary.notification.overdue) parts.push(`${summary.notification.overdue} past the 72-hour notification`);
            if (summary.final_report.overdue) parts.push(`${summary.final_report.overdue} past the final report (14 days for a vulnerability, one month after the notification for a severe incident)`);
            return {
                status: 'fail',
                evidence,
                details: `${overdueTotal} CRA reporting clock(s) have run out without a recorded report: ${parts.join(', ')}. Art. 14 requires the report via the single reporting platform — file it and stamp the vulnerability record now.`,
            };
        }

        const warnings = [];
        if (dueSoonTotal > 0) warnings.push(`${dueSoonTotal} reporting clock(s) run out within ${DUE_SOON_HOURS} hours.`);
        if (!channelSet) warnings.push('No CRA reporting channel (MijnNCSC / ENISA platform) is recorded.');
        if (!psirtSet) warnings.push('No PSIRT contact is configured, so incoming vulnerability reports have no owner.');
        if (procedureMentionsVulns === false) warnings.push('The published incident-response policy does not mention vulnerability handling.');
        else if (procedureMentionsVulns === null) warnings.push('No published incident-response policy to describe the vulnerability handling procedure.');
        if (warnings.length) {
            return { status: 'warn', evidence, details: warnings.join(' ') };
        }

        return {
            status: 'pass',
            evidence,
            details: rows.length > 0
                ? `Reporting process operational: ${rows.length} open CRA-regime incident(s), all inside their 24 h / 72 h / final-report windows; channel, PSIRT contact and procedure in place.`
                : 'Reporting process ready: channel, PSIRT contact and vulnerability procedure in place; no CRA-regime incident is open.',
        };
    },
};

module.exports._test = { _clocksFor, _hasCraRegime, EARLY_WARNING_HOURS, NOTIFICATION_HOURS, FINAL_REPORT_DAYS, INCIDENT_FINAL_REPORT_MONTHS, DUE_SOON_HOURS };
