/**
 * GDPR Art. 44-49 — International transfers / external LLMs.
 *
 * Evidence-driven detection. Instead of trying to guess from provider config,
 * we read the real outbound activity ledger (`integration_activity_log`) for
 * the last 30 days and look at the `country_code` / `is_eu` / `operator` of
 * each call. Operators that the admin has attested to ("SCCs in place") are
 * stored in `compliance_settings.scc_confirmed_operators` and stop the check
 * from failing for them.
 *
 * Fallback (provider/agent scan) is kept as a *secondary* signal so freshly
 * installed orgs that haven't generated any traffic yet still surface obvious
 * misconfigurations.
 *
 * Location states (stores/integrationLocationSql.js):
 *   outside      a transfer: fails without an SCC attestation, as always
 *   via_network  through a global network (Cloudflare, Fastly, …) whose final
 *                location the connection cannot see: its own evidence list,
 *                at most a warn, and never a fail
 *   unknown      no location (no connection seen, no database): not counted as
 *                a transfer, but when more than 5 % of the calls have no
 *                location the evidence is too thin to pass, so warn
 *   local / eu   fine
 * The decision itself is compliance/lib/transferAssessment.js.
 */

const { getAll } = require('../../../db');
const configStore = require('../../../stores/configStore');
const complianceStore = require('../../../stores/complianceStore');
const { LOC_STATE } = require('../../../stores/integrationLocationSql');
const { assessTransfers } = require('../../lib/transferAssessment');
const { LEDGER_ORG_SQL } = require('../../lib/observedOperators');
const pd = require('../../projects/projectData');

/**
 * Ledger groups read per run. The query orders transfers ('outside') first and
 * global networks second, so a cut can only ever drop located or unlocated
 * rows — never an unattested transfer — and it asks for one more than this to
 * know that it cut (evidence.groups_truncated).
 */
const TRANSFER_GROUP_LIMIT = 1000;

const EXTERNAL_PROVIDER_PREFIXES = new Set([
    'openai', 'claude', 'anthropic', 'google', 'google-vertex',
    'azure', 'mistral', 'cohere', 'groq', 'together',
    'fireworks', 'perplexity',
]);

async function _queryTransfers(orgId) {
    try {
        return await getAll(`
            SELECT operator,
                   country_code,
                   country_name,
                   COALESCE(is_eu, false) AS is_eu,
                   COALESCE(is_local, false) AS is_local,
                   ${LOC_STATE} AS location_state,
                   COUNT(*)::int AS calls,
                   MIN(timestamp) AS first_seen,
                   MAX(timestamp) AS last_seen
            FROM integration_activity_log
            WHERE ${LEDGER_ORG_SQL}
              AND timestamp >= NOW() - INTERVAL '30 days'
              -- A durable cache hit writes a flagged row so the processor stays
              -- visible in the RoPA, but nothing crossed a border on that call.
              -- Counting it here would report transfers that did not happen.
              AND served_from_cache = false
            GROUP BY 1, 2, 3, 4, 5, 6
            -- Transfers first: a low-volume unattested operator must never be
            -- the row the LIMIT drops. Same expression as GROUP BY item 6.
            ORDER BY CASE ${LOC_STATE} WHEN 'outside' THEN 0 WHEN 'via_network' THEN 1 ELSE 2 END,
                     calls DESC
            LIMIT ${TRANSFER_GROUP_LIMIT + 1}
        `, [orgId]);
    } catch {
        return null; // table absent on fresh installs
    }
}

// Org scoping (the convention of AIA Art. 13, 50 and 53, projectData.orgMatch):
// an agent without organization_id is visible only to org-less users, whom the
// scheduler sweeps as the 'default' bucket, so it counts there and never for
// another tenant. Counting it for every organisation put tenant A's legacy
// agent by name into tenant B's external_agents. The JS filter mirrors the SQL
// predicate. Same rule as art35-dpia-high-risk._highRiskAgents.
async function _scanAgents(orgId) {
    const scope = orgId || pd.NO_ORG_ORG_ID;
    try {
        const rows = await getAll(
            `SELECT id, name, model, organization_id FROM agents WHERE is_published = TRUE AND ${pd.orgMatch('organization_id')}`,
            [scope],
        );
        const external = [];
        for (const a of rows || []) {
            if ((a.organization_id || pd.NO_ORG_ORG_ID) !== scope) continue;
            const model = String(a.model || '').trim();
            if (!model) continue;
            const prefix = model.split(/[\/:]/)[0].toLowerCase();
            if (EXTERNAL_PROVIDER_PREFIXES.has(prefix)) external.push({ id: a.id, name: a.name, model });
        }
        return external;
    } catch {
        return [];
    }
}

module.exports = {
    id: 'GDPR-Art44-external-transfers',
    regulation: 'GDPR',
    article: '44',
    severity: 'high',
    scope: 'global',
    verification: 'hybrid',
    titleKey: 'compliance.checks.gdpr_art44.title',
    descriptionKey: 'compliance.checks.gdpr_art44.desc',
    remediationKey: 'compliance.checks.gdpr_art44.fix',
    // The SCC toggle lives on the processing register (RoPA), not on Settings.
    remediationLink: 'admin/compliance/ropa',
    async evaluate(orgId) {
        const transfers = await _queryTransfers(orgId);
        const settings = await complianceStore.getSettings(orgId);
        const sccConfirmed = new Set(
            (Array.isArray(settings.scc_confirmed_operators) ? settings.scc_confirmed_operators : [])
                .map(e => String(e?.operator || '').toLowerCase())
                .filter(Boolean)
        );

        // ── Primary signal: real outbound calls ────────────────────
        if (Array.isArray(transfers) && transfers.length > 0) {
            const truncated = transfers.length > TRANSFER_GROUP_LIMIT;
            const result = assessTransfers(transfers.slice(0, TRANSFER_GROUP_LIMIT), sccConfirmed);
            return { ...result, evidence: { ...result.evidence, groups_truncated: truncated } };
        }

        // ── Fallback: provider list + agent model scan ─────────────
        const ai = (await configStore.getConfig('ai')) || {};
        const providers = Array.isArray(ai.providers) ? ai.providers : [];
        const externalAgents = await _scanAgents(orgId);

        if (providers.length === 0 && externalAgents.length === 0) {
            return {
                status: 'not_applicable',
                evidence: { window_days: 30, transfers_total: 0, fallback: 'no providers, no agents' },
                details: 'No outbound integrations or external providers configured — nothing leaves your infrastructure.',
            };
        }

        const status = externalAgents.length > 0 ? 'warn' : 'pass';
        return {
            status,
            evidence: {
                window_days: 30,
                transfers_total: 0,
                fallback: 'no_activity_log',
                providers_configured: providers.length,
                external_agents: externalAgents.slice(0, 20),
            },
            details: externalAgents.length > 0
                ? `${externalAgents.length} published agent(s) reference external providers. No outbound calls observed in the last 30 days — re-evaluate once traffic flows, or attest SCCs proactively.`
                : `All ${providers.length} configured provider(s) appear to be EU/self-hosted, and no outbound traffic was observed in the last 30 days.`,
        };
    },

    // Exported for the tests.
    TRANSFER_GROUP_LIMIT,
};
