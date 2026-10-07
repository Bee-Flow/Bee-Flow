/**
 * ISO 27001 A.5.9 — Inventory of information and associated assets.
 *
 * The workspace enumerates its own information assets from live configuration
 * and data: AI providers, published agents and the models they reference,
 * knowledge bases, integration connections and enabled MCP servers. The
 * evidence payload IS the inventory (same approach as
 * aia/art53-model-inventory.js). Asset classes whose table does not exist yet
 * (fresh install) are reported as null — never dressed up as a verified zero.
 * Any other read error is a failed read, and the check warns that the
 * inventory is incomplete instead of passing.
 *
 * Scoping: published agents belong to an org through organization_id, and the
 * 'default' bucket holds the org-less ones (projects/projectData.orgMatch).
 * A knowledge base with organization_id NULL is a PERSONAL one: it belongs to
 * the org of its owner (tenant_id is the user id), so the bucket gets the
 * personal KBs of org-less accounts. AI providers and MCP servers are
 * install-wide (no org column) and are counted for every org.
 */

const { getOne, getAll } = require('../../../db');
const configStore = require('../../../stores/configStore');
const { LOCAL_PROVIDER_TYPES } = require('../../../core/providers/localModels');
const pd = require('../../projects/projectData');

// Self-hosted runtimes are not an external processor. Read from the one list
// the provider factory uses (CLAUDE.md: adding a runtime is one LOCAL_RUNTIMES
// entry); the hand copy here missed llama.cpp, SGLang, TGI, Jan, KoboldCpp and
// openai-compatible and called them external providers. 'local' is the legacy
// type name older configs still carry.
const INTERNAL_TYPES = new Set(['local', ...LOCAL_PROVIDER_TYPES]);

/**
 * One asset-class count, named after its key in `counts`. Not provisioned
 * (42P01/42703) is null, "not enumerable yet"; any other error is recorded
 * in `failed` (the SQLSTATE only) and is null too, so it never counts as zero.
 */
async function _count(asset, sql, params, failed) {
    try {
        const row = await getOne(sql, params);
        return row?.c ?? 0;
    } catch (e) {
        if (!pd.isNotProvisioned(e)) failed.push({ asset, error_code: e?.code || null });
        return null;
    }
}

module.exports = {
    id: 'ISO27001-A.5.9-asset-inventory',
    regulation: 'ISO27001',
    article: 'A.5.9',
    controls: ['A.5.9'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(i)' }],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_asset_inventory.title',
    descriptionKey: 'compliance.checks.iso_asset_inventory.desc',
    remediationKey: 'compliance.checks.iso_asset_inventory.fix',
    remediationLink: 'admin/compliance/ropa',
    async evaluate(orgId) {
        const ai = (await configStore.getConfig('ai')) || {};
        const providers = (Array.isArray(ai.providers) ? ai.providers : []).map(p => ({
            id: p.id || null,
            type: String(p.type || '').toLowerCase(),
            external: !INTERNAL_TYPES.has(String(p.type || '').toLowerCase()),
        }));

        const scope = orgId || pd.NO_ORG_ORG_ID;
        const failed = [];
        let agents = [];
        try {
            agents = await getAll(
                `SELECT id, model, organization_id FROM agents WHERE is_published = TRUE AND ${pd.orgMatch('organization_id')}`,
                [scope]) || [];
        } catch (e) {
            if (!pd.isNotProvisioned(e)) failed.push({ asset: 'published_agents', error_code: e?.code || null });
        }
        // Mirrors orgMatch: an org-less agent is the bucket's, never every org's.
        agents = agents.filter(a => (a.organization_id || pd.NO_ORG_ORG_ID) === scope);

        const models = new Map(); // modelString -> { model, provider_prefix, agents }
        for (const a of agents) {
            const model = String(a.model || '').trim();
            if (!model) continue;
            const entry = models.get(model) || {
                model, provider_prefix: model.split(/[\/:]/)[0].toLowerCase(), agents: 0,
            };
            entry.agents += 1;
            models.set(model, entry);
        }

        const knowledgeBases = await _count('knowledge_bases', `
            SELECT COUNT(*)::int AS c
            FROM knowledge_bases kb
            LEFT JOIN users u ON u.id = kb.tenant_id
            WHERE kb.organization_id = $1
               OR (kb.organization_id IS NULL AND COALESCE(NULLIF(u."organizationId", ''), '${pd.NO_ORG_ORG_ID}') = $1)
        `, [scope], failed);
        const connections = await _count('integration_connections',
            `SELECT COUNT(*)::int AS c FROM integration_connections WHERE org_id = $1 AND status <> 'revoked'`,
            [orgId], failed);
        // mcp_servers is workspace-global (admin-defined, no org column).
        const mcpServers = await _count('mcp_servers_enabled',
            `SELECT COUNT(*)::int AS c FROM mcp_servers WHERE enabled = TRUE`, [], failed);

        const counts = {
            ai_providers: providers.length,
            published_agents: agents.length,
            models_referenced: models.size,
            knowledge_bases: knowledgeBases,
            integration_connections: connections,
            mcp_servers_enabled: mcpServers,
        };
        const failedAssets = new Set(failed.map(f => f.asset));
        const notEnumerable = Object.entries(counts)
            .filter(([k, v]) => v == null && !failedAssets.has(k)).map(([k]) => k);
        const total = Object.values(counts).reduce((sum, v) => sum + (v || 0), 0);

        const evidence = {
            ...counts,
            providers,
            models: Array.from(models.values()),
            not_enumerable: notEnumerable,
        };
        if (failed.length) {
            evidence.unreadable = failed;
            return {
                status: 'warn',
                evidence,
                details: `The asset inventory is incomplete: ${failed.map(f => `${f.asset}${f.error_code ? ` (SQL state ${f.error_code})` : ''}`).join(', ')} could not be read this run.`,
            };
        }

        if (total === 0) {
            return {
                status: 'not_applicable',
                evidence,
                details: 'No information assets found yet — no AI providers, agents, knowledge bases, integration connections or MCP servers are configured.',
            };
        }
        if (agents.length > 0 && providers.length === 0) {
            return {
                status: 'warn',
                evidence,
                details: `${agents.length} published agent(s) reference models, but no AI provider is registered in the workspace configuration — the asset inventory looks incomplete.`,
            };
        }
        const summary = Object.entries(counts)
            .filter(([, v]) => v != null)
            .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
            .join(', ');
        return {
            status: 'pass',
            evidence,
            details: `Asset inventory enumerated from live configuration — ${summary}.`
                + (notEnumerable.length ? ` Not enumerable yet: ${notEnumerable.join(', ')}.` : ''),
        };
    },
};
