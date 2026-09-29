/**
 * ISO 27001 A.5.9 — Inventory of information and associated assets.
 *
 * The workspace enumerates its own information assets from live configuration
 * and data: AI providers, published agents and the models they reference,
 * knowledge bases, integration connections and enabled MCP servers. The
 * evidence payload IS the inventory (same approach as
 * aia/art53-model-inventory.js). Asset classes whose table does not exist yet
 * (fresh install) are reported as null — never dressed up as a verified zero.
 */

const { getOne, getAll } = require('../../../db');
const configStore = require('../../../stores/configStore');

const INTERNAL_TYPES = new Set(['ollama', 'vllm', 'local', 'localai', 'lmstudio']);

async function _count(sql, params) {
    try {
        const row = await getOne(sql, params);
        return row?.c ?? 0;
    } catch {
        return null; // table absent on fresh installs
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

        let agents = [];
        try {
            agents = await getAll(`SELECT id, name, model, organization_id FROM agents WHERE is_published = TRUE`);
        } catch { /* fresh install */ }
        agents = agents.filter(a => !a.organization_id || a.organization_id === orgId);

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

        const knowledgeBases = await _count(
            `SELECT COUNT(*)::int AS c FROM knowledge_bases WHERE organization_id = $1 OR organization_id IS NULL`,
            [orgId]);
        const connections = await _count(
            `SELECT COUNT(*)::int AS c FROM integration_connections WHERE org_id = $1 AND status <> 'revoked'`,
            [orgId]);
        // mcp_servers is workspace-global (admin-defined, no org column).
        const mcpServers = await _count(
            `SELECT COUNT(*)::int AS c FROM mcp_servers WHERE enabled = TRUE`, []);

        const counts = {
            ai_providers: providers.length,
            published_agents: agents.length,
            models_referenced: models.size,
            knowledge_bases: knowledgeBases,
            integration_connections: connections,
            mcp_servers_enabled: mcpServers,
        };
        const notEnumerable = Object.entries(counts).filter(([, v]) => v == null).map(([k]) => k);
        const total = Object.values(counts).reduce((sum, v) => sum + (v || 0), 0);

        const evidence = {
            ...counts,
            providers,
            models: Array.from(models.values()),
            not_enumerable: notEnumerable,
        };

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
