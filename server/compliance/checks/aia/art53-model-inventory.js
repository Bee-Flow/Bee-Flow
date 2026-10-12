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
const { LOCAL_PROVIDER_TYPES } = require('../../../core/providers/localModels');
const complianceStore = require('../../../stores/complianceStore');
const { canonical } = require('../../lib/observedOperators');
const pd = require('../../projects/projectData');

// undefined_table / undefined_column: the agent register is not provisioned
// yet. Any other SQLSTATE is a FAILED read: the inventory would then pass on
// the providers alone while the agents' models went unlisted.
const NOT_PROVISIONED = new Set(['42P01', '42703']);

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
        // Published agents are the targets this check knows about; the automation
        // side is the marking check's business. Ids only — no names.
        out.missing_targets = agents
            .filter(a => !covered.has(`agent:${a.id}`))
            .slice(0, 50)
            .map(a => ({ target_kind: 'agent', target_id: String(a.id) }));
    } catch { /* not provisioned yet — nulls say "unknown", never 0 */ }
    return out;
}

// Self-hosted runtimes are not an external processor. Read from the one list
// the provider factory uses (CLAUDE.md: adding a runtime is one LOCAL_RUNTIMES
// entry); the hand copy here missed llama.cpp, SGLang, TGI, Jan, KoboldCpp and
// openai-compatible and called them external providers. 'local' is the legacy
// type name older configs still carry.
const INTERNAL_TYPES = new Set(['local', ...LOCAL_PROVIDER_TYPES]);
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
        // The ROPA SCC toggle records the ledger's operator name ('Anthropic',
        // 'Microsoft', 'Google'), while providers and model prefixes carry the
        // adapter type ('claude', 'azure', 'google-vertex'). Both sides go
        // through observedOperators.canonical, the fold the DORA register uses.
        const attested = new Set(
            (Array.isArray(settings.scc_confirmed_operators) ? settings.scc_confirmed_operators : [])
                .map(e => canonical(e?.operator)).filter(Boolean)
        );

        const providerRows = providers.map(p => ({
            id: p.id || null,
            type: String(p.type || '').toLowerCase(),
            external: !INTERNAL_TYPES.has(String(p.type || '').toLowerCase()),
        }));

        // Org scoping (same convention as art50-ai-disclosure): an agent with
        // no organisation is a platform agent that only org-less users see, so
        // it belongs to the 'default' bucket, never to every tenant. The JS
        // filter mirrors the SQL predicate.
        const scope = orgId || pd.NO_ORG_ORG_ID;
        let agents = [];
        try {
            agents = await getAll(
                `SELECT id, name, model, organization_id FROM agents WHERE is_published = TRUE AND ${pd.orgMatch('organization_id')}`,
                [scope],
            );
        } catch (e) {
            if (!NOT_PROVISIONED.has(e?.code)) {
                // Only the SQLSTATE goes into the evidence: a driver message
                // can echo query values.
                const code = e?.code || null;
                return {
                    status: 'warn',
                    evidence: { providers: providerRows, agents_readable: false, error_code: code },
                    details: `The agent register could not be read${code ? ` (SQL state ${code})` : ''}, so the models published agents use are missing from this run's inventory.`,
                };
            }
            agents = []; // not provisioned: a fresh install has no agents
        }
        agents = (Array.isArray(agents) ? agents : []).filter(a => (a.organization_id || pd.NO_ORG_ORG_ID) === scope);

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

        // Matched on the canonical operator; the raw names stay in
        // external_uncovered so the reader sees what is configured.
        const inventory = Array.from(models.values());
        const externalUncovered = new Set();
        for (const m of inventory) {
            if (m.external && !attested.has(canonical(m.provider_prefix))) externalUncovered.add(m.provider_prefix);
        }
        for (const p of providerRows) {
            if (p.external && p.type && !attested.has(canonical(p.type))) externalUncovered.add(p.type);
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
