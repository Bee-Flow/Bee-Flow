/**
 * GDPR Art. 32(1)(d) — "regularly testing, assessing and evaluating the
 * effectiveness" of security measures.
 *
 * Automated misconfiguration signal: DLP is switched ON and the workspace has
 * real AI traffic, yet the guardrail event log is silent — which usually means
 * the shield is not actually in the request path (wrong scope, dead service,
 * allow-listed everything). Complements art32-dlp-enabled, which only checks
 * the configuration flags.
 *
 * Both counts are per-organisation and derived on the SAME basis (see
 * _countInWindow) — including the scope that is NOT a tenant: 'default', the
 * bucket the platform files org-less traffic under and which every install
 * sweeps. There, traffic that resolves to no organisation is the scope's own
 * traffic, not a hole to set aside; scoping it like a tenant is what made this
 * check answer `not_applicable` (and so leave the score entirely) on the
 * single-tenant install it matters most on.
 *
 * The check answers `pass` only when effectiveness was actually observed:
 *
 *   counts could not be read                → warn  (names the SQL state)
 *   a ledger does not exist on this install → not_applicable
 *   traffic that belongs to no identifiable
 *   organisation is itself a judgeable
 *   population                              → warn  (attribution is broken;
 *                                             the verdict is unassessed, not
 *                                             fine)
 *   traffic below MIN_TRAFFIC               → not_applicable (nothing shown
 *                                             yet — this used to be a `pass`,
 *                                             i.e. a green for "could not judge")
 *   traffic, but zero guardrail events      → warn
 *   traffic and guardrail events            → pass
 */

const { getOne } = require('../../../db');
const configStore = require('../../../stores/configStore');

const WINDOW_DAYS = 30;
const MIN_TRAFFIC = 25; // below this, silence is expected, not suspicious
// undefined_table / undefined_column: this install has no such ledger yet.
// Every other SQLSTATE (a timeout, a dropped connection, a permission error)
// means the ledger exists and the count FAILED — which is not zero.
const NOT_PROVISIONED = new Set(['42P01', '42703']);

/**
 * The org id under which the platform files everything that belongs to NO
 * organisation. It is not a tenant: it is the bucket.
 *
 *   - routes/compliance/shared.js `resolveOrgId()` answers it for a session
 *     whose `users."organizationId"` is '' — which is what stores/user/schema.js
 *     writes for migrated and bootstrapped accounts, so the admin of a
 *     single-tenant install lands here;
 *   - compliance/scheduler.js always sweeps it ("Always include 'default' so
 *     single-tenant installs are covered");
 *   - the sibling checks spell the same thing as `orgId || 'default'`
 *     (gdpr/art32-dlp-enabled.js, iso27001/a8-12-dlp.js, a5-28-evidence-integrity.js).
 *
 * There is no shared constant to import (routes/compliance/shared.js inlines
 * the literal and is not this module's to change), so it is named here — the
 * name is the point: without it the string below reads like a tenant id and
 * the bucket gets scoped like a tenant, which is exactly the bug this check
 * shipped with.
 *
 * Consequence, deliberately accepted: an organisation whose id is literally
 * 'default' is the same population as the bucket here. It already is for
 * resolveOrgId (see the warning in routes/compliance/accessAudit.js), so
 * splitting them in this one check would only disagree with the screen the
 * result is shown on.
 */
const NO_ORG_ORG_ID = 'default';

// Written into the evidence so a reader (and an auditor) knows which population
// the numbers below describe. Static text — the evidence carries counts only,
// never a row, an id or anything from a user (BFSF-441).
const ATTRIBUTION_BASIS = "organization_id on the row, else the organisation of the row's user";
const ATTRIBUTION_BASIS_NO_ORG =
    "organization_id on the row, else the organisation of the row's user; a row that resolves to no organisation belongs to this bucket";

// "the row itself names no organisation". organization_id is NULLABLE on both
// ledgers and '' is the other spelling of empty; written as a bare column
// comparison (not NULLIF(...) IS NULL) so the planner can still use
// idx_usage_org_timestamp / idx_guardrail_org_timestamp.
const NO_ORG_ON_ROW = `(t.organization_id IS NULL OR t.organization_id = '')`;
// The organisation of the user the row was written for; '' is "no organisation"
// (users."organizationId" DEFAULT '').
const USER_ORG = `NULLIF(u."organizationId", '')`;

/**
 * Count rows in the window, attributed to the organisation.
 *
 * `organization_id` is NULLABLE on BOTH ledgers and routinely NULL: an App
 * Studio run writes the owner's row with `organization_id` NULL (see the note
 * at stores/usageStore.js `getStudioAppRunCounts`, and the `entry.organization_id
 * || null` bind in `logUsage`), and `guardrailEventStore.logGuardrailEvent`
 * binds the same way. A bare `organization_id = $1` therefore undercounts —
 * badly enough that a busy workspace fell under MIN_TRAFFIC and this check
 * answered `not_applicable` forever, or (when only one of the two ledgers was
 * org-tagged) warned "zero guardrail events" at a shield that was working.
 *
 * So a row belongs to the org when its own column says so OR when the user on
 * the row belongs to the org — the same expression for both ledgers, so the
 * numerator (guardrail events) and the denominator (AI requests) are always
 * the same population.
 *
 * THE NO-ORGANISATION BUCKET. `orgId === NO_ORG_ORG_ID` is not a tenant id; it
 * is where the platform files traffic that resolves to no organisation at all.
 * Scoping it like a tenant is what made this check vanish on precisely the
 * install that has one org: every row of the single-tenant admin resolves to
 * '' (users."organizationId" DEFAULT ''), `= 'default'` matched none of them,
 * both counts came back 0, and "too little traffic to judge" is not_applicable
 * — which compliance/score.js drops from the denominator. Art. 32 effectiveness
 * silently left the score of the install that needed it most. So when the
 * bucket is the scope, a row that resolves to NO organisation IS this scope's
 * row. The two directions stay closed:
 *   - a row that resolves to a different, non-empty org never counts here (the
 *     predicate demands no org on the row AND no org on its user);
 *   - the bucket's rows never count toward a real org (`= $1` cannot match a
 *     NULL), which is the cross-tenant hole the scoping was added to close.
 *
 * What CANNOT be attributed is counted separately: a row with no organisation
 * and no user row to resolve one through (user_id NULL, or a user that no
 * longer exists) belongs to nobody we can name. For a real org that is neither
 * its traffic nor another org's — it is a hole in the attribution, and the
 * caller turns a big enough hole into a non-pass instead of a silent verdict.
 * A row whose user exists but has no organisation is NOT a hole for a real org:
 * it is determinately "not this organisation" — it is the BUCKET's. And for the
 * bucket there is no hole at all: unnameable traffic is what the bucket holds,
 * so it is counted, not set aside. Across one sweep (scheduler: every org plus
 * the bucket) every row therefore lands in exactly one scope.
 *
 * (`users` is a core table; if it were somehow absent the 42P01 would be
 * reported against the ledger instead — a distinction without a difference,
 * since an install without users has no traffic to judge.)
 *
 * Cost note. Attributing through the user cost this check its index: a
 * predicate wrapped in COALESCE(NULLIF(...)) can match no index at all, so
 * every sweep read the whole 30-day slice — under compliance/runner.js's 30 s
 * CHECK_TIMEOUT_MS that is a timeout waiting for a big install. Hence the
 * WHERE also narrows to the rows a FILTER could possibly count (this scope's
 * own rows, plus the rows that name no organisation). It is redundant for the
 * result — every FILTER above already demands one of those two — and not for
 * the plan: bare column comparisons are sargable, so `(organization_id,
 * timestamp DESC)` becomes usable again. Measured on the dev database
 * (1124 rows in the window, so the planner still prefers a seq scan there):
 * forced to use an index it answers with a BitmapOr over the organization_id
 * index at 72 estimated rows, against 1131 for the unrestricted window. The
 * planner now HAS that choice, which is what changes on an install where the
 * window holds millions of rows and one tenant holds few of them.
 *
 * When the sweep runs without an org at all (platform scope) the count stays
 * install-wide, which is then the same population and leaves nothing
 * unattributed.
 *
 * Returns `count: null` when the number could not be established, with
 * `missing` telling the caller which kind of "unknown" it is. `null` is never
 * collapsed to 0 by the caller.
 */
async function _countInWindow(table, orgId) {
    const scoped = !!orgId;
    const noOrgBucket = orgId === NO_ORG_ORG_ID;
    const window = `t.timestamp >= NOW() - INTERVAL '${WINDOW_DAYS} days'`;
    // "this row belongs to $1": its own column says so, or it names no org and
    // its user answers for it.
    const resolvesToOrg = `(t.organization_id = $1 OR (${NO_ORG_ON_ROW} AND ${USER_ORG} = $1))`;
    // ...and the bucket additionally holds every row that resolves to NO
    // organisation — no org on the row and no org on its user (or no user).
    const resolvesToNobody = `(${NO_ORG_ON_ROW} AND ${USER_ORG} IS NULL)`;
    const belongs = noOrgBucket ? `(${resolvesToOrg} OR ${resolvesToNobody})` : resolvesToOrg;
    // A hole only exists for a real org; the bucket is where the holes live.
    const unattributed = noOrgBucket
        ? `0`
        : `COUNT(*) FILTER (WHERE ${NO_ORG_ON_ROW} AND u.id IS NULL)::int`;
    // The attributed count keeps the column name `c` this check has always
    // returned: compliance/__tests__/smoke/gdpr-data-lifecycle.js answers this
    // query with `{ c: N }`, and that double is this module's other contract —
    // it lives in a file this module does not own, so renaming the column here
    // silently turned two smoke scenarios red (traffic read back as 0). Rename
    // both together or neither.
    const sql = scoped
        ? `
        SELECT
            COUNT(*) FILTER (WHERE ${belongs})::int AS c,
            ${unattributed} AS unattributed
        FROM ${table} t
        LEFT JOIN users u ON u.id = t.user_id
        WHERE ${window}
          AND (t.organization_id = $1 OR ${NO_ORG_ON_ROW})
    `
        : `
        SELECT COUNT(*)::int AS c, 0 AS unattributed
        FROM ${table} t
        WHERE ${window}
    `;
    try {
        const row = await getOne(sql, scoped ? [orgId] : []);
        return { count: row?.c ?? 0, unattributed: row?.unattributed ?? 0, missing: false, error_code: null };
    } catch (e) {
        if (NOT_PROVISIONED.has(e?.code)) {
            return { count: null, unattributed: null, missing: true, error_code: e.code };
        }
        // Only the SQLSTATE — a driver message can echo query values into the
        // evidence chain.
        return { count: null, unattributed: null, missing: false, error_code: e?.code || 'unknown' };
    }
}

async function _dlpEnabled(orgId) {
    const shield = (await configStore.getConfig(`org_privacy_shield_${orgId}`)) || {};
    if (shield.enabled) return true;
    const ai = (await configStore.getConfig('ai')) || {};
    return !!(
        (Array.isArray(ai.regexGuardrails) && ai.regexGuardrails.length) ||
        (Array.isArray(ai.piiDetectionCategories) && ai.piiDetectionCategories.length) ||
        ai.moderationEnabled
    );
}

module.exports = {
    id: 'GDPR-Art32-dlp-efficacy',
    regulation: 'GDPR',
    article: '32',
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.gdpr_art32_eff.title',
    descriptionKey: 'compliance.checks.gdpr_art32_eff.desc',
    remediationKey: 'compliance.checks.gdpr_art32_eff.fix',
    remediationLink: 'admin/security/guardrails',
    async evaluate(orgId) {
        const enabled = await _dlpEnabled(orgId);
        if (!enabled) {
            return {
                status: 'not_applicable',
                evidence: { dlp_enabled: false },
                details: 'DLP is not enabled — effectiveness cannot be assessed (see the "Data Loss Prevention active" check).',
            };
        }
        const noOrgBucket = orgId === NO_ORG_ORG_ID;
        // What the population is called in the sentences below. The bucket is
        // not "this organisation" — saying so to a single-tenant admin would
        // describe the wrong thing and hide why the numbers are what they are.
        const scopeSuffix = !orgId ? '' : noOrgBucket ? ' for traffic that belongs to no organisation' : ' for this organisation';
        const population = noOrgBucket ? 'traffic that belongs to no organisation' : 'this organisation';

        const trafficRead = await _countInWindow('ai_usage_log', orgId);
        const eventsRead = await _countInWindow('guardrail_events', orgId);
        const traffic = trafficRead.count;
        const events = eventsRead.count;
        const strayTraffic = trafficRead.unattributed;
        const strayEvents = eventsRead.unattributed;

        // Allow-list: counts, flags and one static string. No row, id, name or
        // free text from either ledger reaches the evidence chain (BFSF-441).
        const evidence = {
            window_days: WINDOW_DAYS,
            dlp_enabled: true,
            org_scoped: !!orgId,
            no_org_bucket: noOrgBucket,
            min_traffic: MIN_TRAFFIC,
            ai_requests: traffic,
            guardrail_events: events,
            unattributable_ai_requests: strayTraffic,
            unattributable_guardrail_events: strayEvents,
            attribution: noOrgBucket ? ATTRIBUTION_BASIS_NO_ORG : ATTRIBUTION_BASIS,
        };

        // A count that failed is not a count of zero. Nothing below may run on
        // a null.
        const failed = [
            trafficRead.count === null && !trafficRead.missing ? `ai_usage_log (SQL state ${trafficRead.error_code})` : null,
            eventsRead.count === null && !eventsRead.missing ? `guardrail_events (SQL state ${eventsRead.error_code})` : null,
        ].filter(Boolean);
        if (failed.length) {
            return {
                status: 'warn',
                evidence: { ...evidence, counts_readable: false },
                details: `DLP is enabled, but effectiveness could not be assessed: ${failed.join(' and ')} could not be counted. Re-run the check once the database is reachable — a failed read is not evidence that the shield is working.`,
            };
        }
        const absent = [
            trafficRead.missing ? 'ai_usage_log' : null,
            eventsRead.missing ? 'guardrail_events' : null,
        ].filter(Boolean);
        if (absent.length) {
            return {
                status: 'not_applicable',
                evidence: { ...evidence, ledgers_missing: absent },
                details: `DLP is enabled, but ${absent.join(' and ')} does not exist on this install, so Art. 32(1)(d) effectiveness cannot be measured.`,
            };
        }

        // Traffic nobody can be named for. MIN_TRAFFIC is this check's own
        // definition of "enough requests that the answer means something", so a
        // hole of that size is a population that could have carried the
        // evidence and was never judged. Saying not_applicable or pass on top
        // of it would be exactly the silence this check exists to break.
        // (In the bucket there is no such hole — that traffic is counted above.)
        const attributionBroken = strayTraffic >= MIN_TRAFFIC;
        if (attributionBroken && traffic < MIN_TRAFFIC) {
            return {
                status: 'warn',
                evidence: { ...evidence, attribution_complete: false },
                details: `DLP is enabled, but the AI traffic of the last ${WINDOW_DAYS} days cannot be attributed: ${strayTraffic} request(s) carry no organisation and no user to resolve one through, against ${traffic} request(s) that do belong to this organisation. Effectiveness is unassessed, not fine — record organization_id (or a user) on the usage log before reading this check as a verdict.`,
            };
        }

        const strayNote = strayTraffic
            ? ` A further ${strayTraffic} request(s) in the window carry no organisation and no resolvable user, so they belong to no organisation this check can name.`
            : '';

        if (traffic < MIN_TRAFFIC) {
            return {
                // Not a pass: the subject of this check is whether the shield
                // demonstrably works, and below this volume that has not been
                // shown either way.
                status: 'not_applicable',
                evidence,
                details: `DLP is enabled, but with ${traffic} AI request(s) in ${WINDOW_DAYS} days${scopeSuffix} there is too little traffic to judge effectiveness — silence is expected at this volume, so nothing is demonstrated yet (at least ${MIN_TRAFFIC} requests are needed).${strayNote}`,
            };
        }
        if (events === 0) {
            const eventNote = strayEvents
                ? ` ${strayEvents} guardrail event(s) in the window carry no organisation and no resolvable user — the shield may be firing without attributing, which has to be fixed before this warning can be read either way.`
                : '';
            return {
                status: 'warn',
                evidence,
                details: `DLP is enabled and ${traffic} AI request(s) flowed in the last ${WINDOW_DAYS} days, but the guardrail log recorded zero events for ${population}. Verify the shield is actually in the request path (Art. 32(1)(d) requires testing effectiveness, not just switching features on).${eventNote}${strayNote}`,
            };
        }
        if (attributionBroken) {
            return {
                status: 'warn',
                evidence: { ...evidence, attribution_complete: false },
                details: `DLP is demonstrably active on the traffic that could be attributed (${events} guardrail event(s) across ${traffic} AI request(s) in the last ${WINDOW_DAYS} days), but ${strayTraffic} further request(s) carry no organisation and no resolvable user. That is a population large enough to judge on its own and it was not judged, so this is not yet a clean Art. 32(1)(d) result.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `DLP is demonstrably active: ${events} guardrail event(s) across ${traffic} AI request(s) in the last ${WINDOW_DAYS} days.${strayNote}`,
        };
    },
};
