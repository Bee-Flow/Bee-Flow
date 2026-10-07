/**
 * EU AI Act Art. 19 / 26(6) — automatically generated logs of high-risk AI
 * systems must be kept for at least six months.
 *
 * Automated signal: the age span of the activity ledgers
 * (integration_activity_log + guardrail_events). A span of at least six
 * calendar months proves the retention window is honoured; a shorter span
 * cannot distinguish "young install" from "purged logs", so it warns (never
 * fails) with the observed span.
 *
 * Six months are calendar months, counted back from now (31 Aug → 28 Feb, the
 * same clamp as Postgres `NOW() - INTERVAL '6 months'`): between 181 and 184
 * days depending on the date. A fixed 180 days is shorter than six months on
 * every date, so it called the window "demonstrated" when it was not.
 */

const { getOne } = require('../../../db');
const { addCalendarMonths } = require('../../../utils/calendarMonths');
const { LEDGER_ORG_SQL } = require('../../../stores/integrationLocationSql');

const REQUIRED_MONTHS = 6;
const DAY_MS = 86400 * 1000;

/** The six calendar months before `nowMs`, in whole days (181–184). */
function requiredDays(nowMs) {
    return Math.round((nowMs - addCalendarMonths(new Date(nowMs), -REQUIRED_MONTHS).getTime()) / DAY_MS);
}

// undefined_table / undefined_column: the ledger is not provisioned on this
// install. Any other SQLSTATE is a FAILED read, and "could not read the logs"
// must never be reported as "no logs recorded yet".
const NOT_PROVISIONED = new Set(['42P01', '42703']);

/**
 * `{ age }` in whole days (null: no rows or not provisioned), plus `failed`
 * (the SQLSTATE) on a failed read. An org-scoped read is the integration
 * ledger's, filtered with LEDGER_ORG_SQL so the 'default' bucket also counts
 * the org-less rows logToolEgress writes for users without an organisation.
 */
async function _oldestAgeDays(table, orgScoped, orgId) {
    try {
        const row = orgScoped
            ? await getOne(`SELECT EXTRACT(EPOCH FROM (NOW() - MIN(timestamp))) / 86400 AS age FROM ${table} WHERE ${LEDGER_ORG_SQL}`, [orgId])
            : await getOne(`SELECT EXTRACT(EPOCH FROM (NOW() - MIN(timestamp))) / 86400 AS age FROM ${table}`);
        return { age: row?.age == null ? null : Math.floor(Number(row.age)) };
    } catch (e) {
        return NOT_PROVISIONED.has(e?.code) ? { age: null } : { age: null, failed: e?.code || 'unknown' };
    }
}

module.exports = {
    id: 'AIA-Art26-6-log-retention',
    regulation: 'AIA',
    article: '26(6)',
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.aia_art26_6.title',
    descriptionKey: 'compliance.checks.aia_art26_6.desc',
    remediationKey: 'compliance.checks.aia_art26_6.fix',
    remediationLink: 'admin/monitoring/activity',
    async evaluate(orgId) {
        // Whole days, so the floored ages below compare exactly: a ledger
        // passes once it is at least six calendar months old.
        const minDays = requiredDays(Date.now());
        const integration = await _oldestAgeDays('integration_activity_log', true, orgId);
        const guardrail = await _oldestAgeDays('guardrail_events', false, orgId);
        const integrationAge = integration.age;
        const guardrailAge = guardrail.age;
        const spans = [integrationAge, guardrailAge].filter(v => v != null);
        const evidence = {
            required_months: REQUIRED_MONTHS,
            required_days: minDays,
            integration_log_span_days: integrationAge,
            guardrail_log_span_days: guardrailAge,
        };
        // A ledger that could not be read leaves the span unknown: "no logs"
        // would be false, and the other ledger alone can understate it. Only
        // a readable ledger that already spans six months settles the run on
        // its own. Only the SQLSTATE goes into the evidence, never the driver
        // message.
        const errorCodes = [integration.failed, guardrail.failed].filter(Boolean);
        const maxSpan = spans.length ? Math.max(...spans) : null;
        const unread = errorCodes.length ? { logs_readable: false, error_codes: errorCodes } : {};
        if (errorCodes.length && !(maxSpan >= minDays)) {
            return {
                status: 'warn',
                evidence: { ...evidence, ...unread },
                details: `The activity logs could not be read (SQL state ${errorCodes.join(', ')}), so the retention span is unknown for this run.`,
            };
        }
        if (!spans.length) {
            return {
                status: 'not_applicable',
                evidence,
                details: 'No activity logs recorded yet — nothing to retain.',
            };
        }
        if (maxSpan >= minDays) {
            return {
                status: 'pass',
                evidence: { ...evidence, ...unread, observed_span_days: maxSpan },
                details: `Activity logs span ${maxSpan} days — the six-month Art. 26(6) retention window is demonstrated.`,
            };
        }
        return {
            status: 'warn',
            evidence: { ...evidence, observed_span_days: maxSpan },
            details: `Activity logs span only ${maxSpan} days. If this install is older than that, logs are being purged early — Art. 19/26(6) requires keeping them at least six months (for high-risk systems from 2 Dec 2027; good practice before then).`,
        };
    },
};

module.exports._test = { requiredDays };
