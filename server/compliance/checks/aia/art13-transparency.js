/**
 * EU AI Act Art. 13 — Transparency / information to users.
 * Ensures each published agent has a meaningful description so users can
 * understand the purpose and limitations of the AI system they interact with.
 *
 * Org scoping (same convention as art50-ai-disclosure): an agent without an
 * organisation is a platform agent that only org-less users see, so it belongs
 * to the 'default' bucket, never to every tenant — counting it for every org
 * put its id and name into every tenant's evidence. The JS filter mirrors the
 * SQL predicate so a store or stub that ignores parameters cannot widen it.
 */

const { getAll } = require('../../../db');
const pd = require('../../projects/projectData');

const MIN_DESCRIPTION_CHARS = 30;

// undefined_table / undefined_column: the register is not provisioned yet.
// Any other SQLSTATE is a FAILED read, never "nothing to assess".
const NOT_PROVISIONED = new Set(['42P01', '42703']);

module.exports = {
    id: 'AIA-Art13-transparency',
    regulation: 'AIA',
    article: '13',
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.aia_art13.title',
    descriptionKey: 'compliance.checks.aia_art13.desc',
    remediationKey: 'compliance.checks.aia_art13.fix',
    remediationLink: 'admin/agents',
    async evaluate(orgId) {
        const scope = orgId || pd.NO_ORG_ORG_ID;
        let agents = [];
        try {
            agents = await getAll(`
                SELECT id, name, description, organization_id
                FROM agents WHERE is_published = TRUE AND ${pd.orgMatch('organization_id')}
            `, [scope]);
        } catch (e) {
            if (NOT_PROVISIONED.has(e?.code)) {
                return { status: 'not_applicable', evidence: { agents_table: false }, details: 'No agents table yet.' };
            }
            // Only the SQLSTATE goes into the evidence: a driver message can
            // echo query values.
            const code = e?.code || null;
            return {
                status: 'warn',
                evidence: { agents_readable: false, error_code: code },
                details: `The agent register could not be read${code ? ` (SQL state ${code})` : ''}, so agent descriptions were not assessed this run.`,
            };
        }
        if (!Array.isArray(agents) || agents.length === 0) {
            return { status: 'not_applicable', evidence: {}, details: 'No published agents to assess.' };
        }

        const missing = [];
        let applicable = 0;
        for (const a of agents) {
            if ((a.organization_id || pd.NO_ORG_ORG_ID) !== scope) continue;
            applicable++;
            const desc = a.description == null ? '' : String(a.description).trim();
            if (desc.length < MIN_DESCRIPTION_CHARS) {
                missing.push({ id: a.id, name: a.name, length: desc.length });
            }
        }

        if (applicable === 0) {
            return { status: 'not_applicable', evidence: {}, details: 'No agents in this organization.' };
        }

        let status;
        if (missing.length === 0) status = 'pass';
        else if (missing.length < applicable) status = 'warn';
        else status = 'fail';

        return {
            status,
            evidence: {
                total: applicable,
                missing_count: missing.length,
                min_chars: MIN_DESCRIPTION_CHARS,
                missing_descriptions: missing.slice(0, 10),
            },
            details: status === 'pass'
                ? `Every published agent (${applicable}) has a meaningful description of ≥${MIN_DESCRIPTION_CHARS} characters.`
                : `${missing.length} of ${applicable} agents have no description or fewer than ${MIN_DESCRIPTION_CHARS} characters. Add a short explanation of what the agent does and its limits.`,
        };
    },
};
