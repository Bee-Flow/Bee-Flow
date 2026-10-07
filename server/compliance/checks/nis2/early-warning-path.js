/**
 * NIS2 Art. 23(4) — the significant-incident reporting path: early warning
 * within 24 h, incident notification within 72 h, final report within one
 * month.
 *
 * The incident register (compliance_incidents) carries one clock per stage
 * once the NIS2 columns land: `early_warning_due_at/_sent_at` (24 h),
 * `authority_notified_at` (72 h), `final_report_due_at/_sent_at` (+1 month).
 * The 72 h due date has no column of its own: `deadline_at` is the EARLIEST
 * open clock across every regime on the row (the 24 h early warning, a DORA
 * 4 h customer notice, …), so reading it as "the notification" failed an
 * incident at hour 4 or 24 for a 72 h duty. The notification clock is
 * therefore computed from `detected_at` with the store's own NIS2 clock.
 * Incidents count for NIS2 when `regimes` contains 'NIS2'.
 *
 *   any NIS2 incident past a clock without the matching stamp → fail
 *   a clock within 6 h, or no authority channel / CSIRT contact configured → warn
 *   a clock with no due date (NULL column — the clock columns land without a
 *     backfill, so pre-existing incidents have none) → warn, counted: such a
 *     deadline was never computed and must never be reported as met
 *   otherwise (recipients + channel configured, clocks green)       → pass
 *
 * Incident rows come from incidentStore.listOpenClocks(orgId) when the store
 * provides it (guarded), else from our own SELECT. Missing columns/tables →
 * warn "not provisioned yet" — a fresh install must never crash the sweep.
 *
 * The platform never files with the CSIRT/authority itself: every "sent"
 * stamp is an attestation, the clocks are automated (same stance as the GDPR
 * Art. 33 check). Evidence names incident ids and timestamps only — never the
 * incident text, never the contact address.
 */

const { getAll } = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');
const incidentStore = require('../../../stores/incidentStore');

const HOUR = 3600 * 1000;
const URGENT_HOURS = 6;
// NIS2 Art. 23(4)(b): incident notification within 72 h of becoming aware.
const NOTIFICATION_HOURS = 72;
const NOT_PROVISIONED = new Set(['42P01', '42703']);

function _notRelevant(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return !!rel && rel.nis2 === 'not_relevant';
}

function _regimes(row) {
    let r = row && row.regimes;
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = null; } }
    return Array.isArray(r) ? r : null;
}

function _isNis2(row) {
    const regimes = _regimes(row);
    // A helper that already filtered on regime may omit the column — keep those rows.
    return regimes === null ? true : regimes.includes('NIS2');
}

async function _openNis2Incidents(orgId) {
    const fn = incidentStore.listOpenClocks;
    if (typeof fn === 'function') {
        try {
            const rows = await fn.call(incidentStore, orgId);
            if (Array.isArray(rows)) {
                return { rows: rows.filter(r => r && r.status !== 'closed' && _isNis2(r)), source: 'incidentStore.listOpenClocks' };
            }
        } catch (e) {
            if (!NOT_PROVISIONED.has(e?.code)) throw e;
            return { rows: null, source: 'incidentStore.listOpenClocks', missing: e.code };
        }
    }
    try {
        const rows = await getAll(`
            SELECT id, kind, status, severity, detected_at, deadline_at, authority_notified_at,
                   early_warning_due_at, early_warning_sent_at,
                   final_report_due_at, final_report_sent_at, reported_via
            FROM compliance_incidents
            WHERE organization_id = $1
              AND status <> 'closed'
              AND COALESCE(regimes, '[]'::jsonb) @> '["NIS2"]'::jsonb
            ORDER BY detected_at DESC
            LIMIT 50
        `, [orgId]);
        return { rows, source: 'query' };
    } catch (e) {
        if (NOT_PROVISIONED.has(e?.code)) return { rows: null, source: 'query', missing: e.code };
        throw e;
    }
}

/**
 * The NIS2 72 h notification due date, from detected_at — never `deadline_at`
 * (see the header). No detected_at → no clock: unknown, not met.
 */
function _notificationDue(row) {
    const detected = row && row.detected_at ? new Date(row.detected_at).getTime() : NaN;
    if (!Number.isFinite(detected)) return null;
    const hours = incidentStore.REGIME_CLOCKS?.NIS2?.notificationHours || NOTIFICATION_HOURS;
    return new Date(detected + hours * HOUR);
}

function _clock(dueAt, sentAt, now) {
    const due = dueAt ? new Date(dueAt).getTime() : NaN;
    const sent = sentAt ? new Date(sentAt).toISOString() : null;
    if (!Number.isFinite(due)) return { due_at: null, sent_at: sent, state: sent ? 'sent' : 'no_clock' };
    const dueIso = new Date(due).toISOString();
    if (sent) return { due_at: dueIso, sent_at: sent, state: 'sent' };
    if (due < now) return { due_at: dueIso, sent_at: null, state: 'overdue' };
    if (due - now <= URGENT_HOURS * HOUR) return { due_at: dueIso, sent_at: null, state: 'urgent' };
    return { due_at: dueIso, sent_at: null, state: 'running' };
}

module.exports = {
    id: 'NIS2-Art23-early-warning-path',
    regulation: 'NIS2',
    article: 'Art. 23',
    frameworks: [
        { regulation: 'CRA', ref: 'Art. 14' },
        { regulation: 'GDPR', ref: 'Art. 33' },
    ],
    severity: 'critical',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.check_nis2_early_warning_title',
    descriptionKey: 'compliance.check_nis2_early_warning_desc',
    remediationKey: 'compliance.check_nis2_early_warning_fix',
    remediationLink: 'admin/compliance/incidents',
    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        if (_notRelevant(settings)) {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'NIS2 is marked as not relevant for this organisation (Compliance → Frameworks).',
            };
        }

        const recipients = Array.isArray(settings.breach_recipients) ? settings.breach_recipients : [];
        const recipientsCount = recipients.filter(r => typeof r === 'string' && /@/.test(r)).length;
        const channel = typeof settings.nis2_authority_channel === 'string' && settings.nis2_authority_channel.trim()
            ? settings.nis2_authority_channel.trim().slice(0, 200) : null;
        const csirtConfigured = typeof settings.nis2_csirt_contact === 'string' && settings.nis2_csirt_contact.trim().length > 0;

        // The channel is free text (portal name / URL). Should an admin type an
        // e-mail address there, the evidence records only that a channel exists.
        const readiness = {
            recipients_count: recipientsCount,
            authority_channel_configured: !!channel,
            authority_channel: channel && !/@/.test(channel) ? channel : (channel ? 'email' : null),
            csirt_contact_configured: csirtConfigured,
        };

        const { rows, source, missing } = await _openNis2Incidents(orgId);
        if (rows === null) {
            return {
                status: 'warn',
                evidence: { ...readiness, register_provisioned: false, missing, source },
                details: 'The incident register is not provisioned for NIS2 reporting clocks yet — the 24 h / 72 h / 1-month clocks cannot be tracked.',
            };
        }

        const now = Date.now();
        const incidents = rows.map(r => ({
            id: r.id,
            kind: r.kind || null,
            status: r.status,
            detected_at: r.detected_at ? new Date(r.detected_at).toISOString() : null,
            reported_via: r.reported_via || null,
            clocks: {
                early_warning: _clock(r.early_warning_due_at, r.early_warning_sent_at, now),
                notification: _clock(_notificationDue(r), r.authority_notified_at, now),
                final_report: _clock(r.final_report_due_at, r.final_report_sent_at, now),
            },
        }));
        const states = incidents.flatMap(i => Object.values(i.clocks).map(c => c.state));
        const overdue = incidents.filter(i => Object.values(i.clocks).some(c => c.state === 'overdue'));
        const urgent = incidents.filter(i => Object.values(i.clocks).some(c => c.state === 'urgent'));
        // A clock with no due date was never evaluated — it is neither met nor
        // missed. The NIS2 due-date columns are added with ADD COLUMN IF NOT
        // EXISTS and no backfill, so every incident opened before that release
        // lands here. Counting these as compliant is how a check reports "all
        // inside their clocks" about deadlines it never computed.
        const unknownClocks = incidents.filter(i => Object.values(i.clocks).some(c => c.state === 'no_clock'));

        const evidence = {
            ...readiness,
            register_provisioned: true,
            source,
            open_nis2_incidents: incidents.length,
            overdue_count: overdue.length,
            urgent_count: urgent.length,
            unknown_clock_count: unknownClocks.length,
            clocks_overdue: states.filter(s => s === 'overdue').length,
            clocks_unknown: states.filter(s => s === 'no_clock').length,
            incidents: incidents.slice(0, 10),
            urgent_window_hours: URGENT_HOURS,
        };

        if (overdue.length) {
            return {
                status: 'fail',
                evidence,
                details: `${overdue.length} open NIS2 incident(s) have passed a reporting deadline without the matching notification recorded (early warning 24 h, notification 72 h or final report 1 month). Record the report on the incident, or close it with an assessment.`,
            };
        }
        const warnings = [];
        if (!channel) warnings.push('No authority/CSIRT reporting channel is configured (Compliance → Settings).');
        if (!csirtConfigured) warnings.push('No CSIRT contact is recorded (Compliance → Settings).');
        if (recipientsCount === 0) warnings.push('No internal incident-notification recipients are configured, so nobody is alerted when a clock starts.');
        if (urgent.length) warnings.push(`${urgent.length} open incident(s) reach a reporting deadline within ${URGENT_HOURS} hours.`);
        if (unknownClocks.length) {
            warnings.push(`${unknownClocks.length} open incident(s) carry ${evidence.clocks_unknown} reporting clock(s) with no due date, so those deadlines could not be computed — incidents opened before the NIS2 clock columns shipped are not backfilled. Re-open and save each incident (or run the backfill) so its 24 h / 72 h / 1-month clocks are set; until then their compliance is unknown, not met.`);
        }
        if (warnings.length) {
            return { status: 'warn', evidence, details: warnings.join(' ') };
        }
        return {
            status: 'pass',
            evidence,
            details: incidents.length
                ? `Reporting path operational: channel and CSIRT contact configured, ${recipientsCount} recipient(s), ${incidents.length} open NIS2 incident(s) all inside their clocks.`
                : `Reporting path ready: channel and CSIRT contact configured, ${recipientsCount} recipient(s), no open NIS2 incident.`,
        };
    },
};
