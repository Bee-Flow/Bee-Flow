/**
 * ISO 27001 A.8.15 / A.8.16 — Event logging and monitoring.
 *
 * Three ledgers must be alive: the outbound integration activity log
 * (integration_activity_log), the guardrail event log (guardrail_events), and
 * the authentication log (access_audit_log). For each we measure recent
 * activity (rows in the last 30 days) plus the total age span as supporting
 * evidence. A quiet or empty ledger cannot be distinguished from a young
 * install, so it degrades to warn — never fail — with the observed numbers.
 *
 * The authentication ledger was the missing third. A.8.15 names "successful
 * and rejected system access attempts" first among the events a log shall
 * record, and this check reported a clean pass while the product recorded none
 * of them: sign-ins existed only as an anonymous counter in the metrics
 * pipeline, which cannot answer who signed in, or from where. See
 * auth/loginAudit.js. It uses created_at where the other two use timestamp,
 * hence the column argument on the helpers below.
 *
 * The span query is a parallel implementation of aia/art26-6-log-retention.js
 * (same table scoping: integration log per-org, guardrail log install-wide);
 * kept separate on purpose so the AIA retention check stays self-contained.
 *
 * The org-scoped ledgers (integration and authentication) write a NULL or ''
 * organization_id for rows that belong to no organisation: auth/loginAudit.js
 * does so for org-less accounts, unknown identifiers and throttled attempts.
 * Those rows are the 'default' bucket's, the scope a single-tenant install is
 * filed under, so for that scope _orgWhere includes them. The guardrail log
 * stays install-wide on purpose: rows are only written when a violation
 * happens, so per tenant a clean tenant would read as a dead ledger.
 */

const { getOne } = require('../../../db');

const ACTIVITY_WINDOW_DAYS = 30;

/** SQL: the row belongs to the org in $1; the 'default' bucket also owns the org-less rows. */
function _orgWhere(orgId) {
    return orgId === 'default'
        ? "(organization_id = $1 OR organization_id IS NULL OR organization_id = '')"
        : 'organization_id = $1';
}

async function _oldestAgeDays(table, orgScoped, orgId, timeCol = 'timestamp') {
    try {
        const row = orgScoped
            ? await getOne(`SELECT EXTRACT(EPOCH FROM (NOW() - MIN(${timeCol}))) / 86400 AS age FROM ${table} WHERE ${_orgWhere(orgId)}`, [orgId])
            : await getOne(`SELECT EXTRACT(EPOCH FROM (NOW() - MIN(${timeCol}))) / 86400 AS age FROM ${table}`);
        return row?.age == null ? null : Math.floor(Number(row.age));
    } catch {
        return null; // table absent on fresh installs
    }
}

async function _recentCount(table, orgScoped, orgId, timeCol = 'timestamp', where = '') {
    try {
        const clause = `${timeCol} >= NOW() - INTERVAL '${ACTIVITY_WINDOW_DAYS} days'${where}`;
        const row = orgScoped
            ? await getOne(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${clause} AND ${_orgWhere(orgId)}`, [orgId])
            : await getOne(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${clause}`);
        return row?.c ?? 0;
    } catch {
        return null; // table absent on fresh installs
    }
}

// The actions auth/loginAudit.js writes. Counted by name rather than by table,
// because access_audit_log also carries role and membership changes — a busy
// admin week would otherwise read as "authentication is being logged" while no
// sign-in had been recorded at all.
const LOGIN_ACTIONS_SQL = "AND action IN ('login_succeeded', 'login_failed', 'login_blocked')";

module.exports = {
    id: 'ISO27001-A.8.15-logging',
    regulation: 'ISO27001',
    article: 'A.8.15',
    controls: ['A.8.15', 'A.8.16'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(b)' }],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_logging.title',
    descriptionKey: 'compliance.checks.iso_logging.desc',
    remediationKey: 'compliance.checks.iso_logging.fix',
    remediationLink: 'admin/monitoring/activity',
    async evaluate(orgId) {
        const integrationRecent = await _recentCount('integration_activity_log', true, orgId);
        const guardrailRecent = await _recentCount('guardrail_events', false, orgId);
        const authRecent = await _recentCount('access_audit_log', true, orgId, 'created_at', ` ${LOGIN_ACTIONS_SQL}`);
        const integrationSpan = await _oldestAgeDays('integration_activity_log', true, orgId);
        const guardrailSpan = await _oldestAgeDays('guardrail_events', false, orgId);
        const authSpan = await _oldestAgeDays('access_audit_log', true, orgId, 'created_at');

        const evidence = {
            window_days: ACTIVITY_WINDOW_DAYS,
            integration_recent_events: integrationRecent,
            guardrail_recent_events: guardrailRecent,
            authentication_recent_events: authRecent,
            integration_log_span_days: integrationSpan,
            guardrail_log_span_days: guardrailSpan,
            access_audit_log_span_days: authSpan,
        };

        const integrationActive = (integrationRecent || 0) > 0;
        const guardrailActive = (guardrailRecent || 0) > 0;
        const authActive = (authRecent || 0) > 0;

        if (integrationActive && guardrailActive && authActive) {
            return {
                status: 'pass',
                evidence,
                details: `All three security ledgers are live: ${integrationRecent} integration event(s), ${guardrailRecent} guardrail event(s) and ${authRecent} authentication event(s) in the last ${ACTIVITY_WINDOW_DAYS} days (log spans: ${integrationSpan} / ${guardrailSpan} / ${authSpan} days).`,
            };
        }

        const quiet = [];
        if (!integrationActive) quiet.push('integration activity log');
        if (!guardrailActive) quiet.push('guardrail event log');
        if (!authActive) quiet.push('authentication log');
        const everLogged = integrationSpan != null || guardrailSpan != null || authSpan != null;
        return {
            status: 'warn',
            evidence,
            details: everLogged
                ? `The ${quiet.join(' and the ')} recorded nothing in the last ${ACTIVITY_WINDOW_DAYS} days. On a quiet workspace this may be normal, but on an active one it means security events are going unrecorded — verify the ledgers still receive rows.`
                : 'None of the three security ledgers has recorded any events yet. Expected on a young install; on an active workspace it means event logging is not wired up.',
        };
    },
};
