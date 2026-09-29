/**
 * EU AI Act Art. 53 — GPAI transparency (in force since Aug 2025).
 *
 * Deployers should know WHICH general-purpose models their workspace routes
 * data to. Hybrid: the inventory itself is automated (providers configured +
 * models referenced by published agents); the downstream-safeguard signal is
 * the per-operator SCC/DPA attestation from compliance_settings.
 *
 * The evidence payload IS the model inventory — that alone is the Art. 53
 * transparency value for an auditor.
 */

const { getAll } = require('../../../db');
const configStore = require('../../../stores/configStore');
const complianceStore = require('../../../stores/complianceStore');

/**
 * The AI-Act classification register (stores/aiActAssessmentStore) rides
 * along in the evidence: how many targets carry a current attestation, how
 * many have lapsed, and which published agents have never been assessed.
 * Evidence only — the status logic below is unchanged this release. Tolerant
 * of the table not existing yet (fresh install: the store's DDL runs on first
 * use) and of the store being unavailable.
 */
async function _aiActAssessments(orgId, agents) {
    const out = { attested: null, expired: null, missing_targets: [] };
    let store;
    try { store = require('../../../stores/aiActAssessmentStore'); } catch { return out; }
    try {
        const stats = await store.stats(orgId);
        out.attested = Number.isFinite(Number(stats?.attested)) ? Number(stats.attested) : 0;
        out.expired = Number.isFinite(Number(stats?.expired)) ? Number(stats.expired) : 0;
        const latest = await store.listForOrg(orgId);
        const covered = new Set((latest || []).map(r => `${r.target_kind}:${r.target_id}`));
        // Published agents are the targets this check knows about; the routine
        // side is the marking check's business. Ids only — no names.
        out.missing_targets = agents
            .filter(a => !covered.has(`agent:${a.id}`))
            .slice(0, 50)
            .map(a => ({ target_kind: 'agent', target_id: String(a.id) }));
    } catch { /* not provisioned yet — nulls say "unknown", never 0 */ }
    return out;
}

const INTERNAL_TYPES = new Set(['ollama', 'vllm', 'local', 'localai', 'lmstudio']);
const EXTERNAL_PREFIXES = new Set([
    'openai', 'claude', 'anthropic', 'google', 'google-vertex',
    'azure', 'mistral', 'cohere', 'groq', 'together', 'fireworks', 'perplexity',
]);

module.exports = {
    id: 'AIA-Art53-model-inventory',
    regulation: 'AIA',
    article: '53',
    severity: 'medium',
    scope: 'global',
    verification: 'hybrid',
    titleKey: 'compliance.checks.aia_art53.title',
    descriptionKey: 'compliance.checks.aia_art53.desc',
    remediationKey: 'compliance.checks.aia_art53.fix',
    remediationLink: 'admin/compliance/ropa',
    async evaluate(orgId) {
        const ai = (await configStore.getConfig('ai')) || {};
        const providers = Array.isArray(ai.providers) ? ai.providers : [];
        const settings = await complianceStore.getSettings(orgId);
        const attested = new Set(
            (Array.isArray(settings.scc_confirmed_operators) ? settings.scc_confirmed_operators : [])
                .map(e => String(e?.operator || '').toLowerCase()).filter(Boolean)
        );

        let agents = [];
        try {
            agents = await getAll(`SELECT id, name, model, organization_id FROM agents WHERE is_published = TRUE`);
        } catch { /* fresh install */ }
        agents = agents.filter(a => !a.organization_id || a.organization_id === orgId);

        const models = new Map(); // modelString -> { model, provider_prefix, external, agents: [] }
        for (const a of agents) {
            const model = String(a.model || '').trim();
            if (!model) continue;
            const prefix = model.split(/[\/:]/)[0].toLowerCase();
            const entry = models.get(model) || {
                model, provider_prefix: prefix,
                external: EXTERNAL_PREFIXES.has(prefix), agents: [],
            };
            entry.agents.push(a.name || a.id);
            models.set(model, entry);
        }

        const providerRows = providers.map(p => ({
            id: p.id || null,
            type: String(p.type || '').toLowerCase(),
            external: !INTERNAL_TYPES.has(String(p.type || '').toLowerCase()),
        }));

        const inventory = Array.from(models.values());
        const externalUncovered = new Set();
        for (const m of inventory) {
            if (m.external && !attested.has(m.provider_prefix)) externalUncovered.add(m.provider_prefix);
        }
        for (const p of providerRows) {
            if (p.external && p.type && !attested.has(p.type)) externalUncovered.add(p.type);
        }

        const evidence = {
            providers: providerRows,
            models: inventory,
            attested_operators: Array.from(attested),
            external_uncovered: Array.from(externalUncovered),
            ai_act_assessments: await _aiActAssessments(orgId, agents),
        };

        if (!inventory.length && !providerRows.length) {
            return {
                status: 'not_applicable',
                evidence,
                details: 'No AI providers configured and no published agents reference a model.',
            };
        }
        if (externalUncovered.size > 0) {
            return {
                status: 'warn',
                evidence,
                details: `Model inventory recorded, but ${externalUncovered.size} external GPAI provider(s) (${Array.from(externalUncovered).join(', ')}) lack an SCC/DPA attestation. Attest them under Compliance → ROPA.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `Model inventory recorded: ${inventory.length} model(s) across ${providerRows.length} provider(s); every external provider is covered by an attested safeguard.`,
        };
    },
};
