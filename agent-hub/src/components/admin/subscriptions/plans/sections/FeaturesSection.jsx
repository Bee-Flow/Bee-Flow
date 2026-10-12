import { Puzzle, FlaskConical, Sparkles, Clock, BookOpen, Globe, Workflow, Brain, Zap, Server, ShieldCheck } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { INTEGRATION_CATALOG } from '../../../../../config/integrationCatalog';
import { getIntegrationIcon } from '../../../../../config/integrationIcons';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { apiJson } from '../../hooks/useApi';
import { Banner } from '../../ui/Banner';
import { FeatureCardGrid } from '../../ui/FeatureCardGrid';
import { FeatureChipGrid } from '../../ui/FeatureChipGrid';

// Integration IDs that exist in the catalog but are NOT gated by the org
// integration system — they're gated by their beta/license feature instead,
// so toggling them as an integration here is a no-op. We hide them from the
// plan editor's integration list to avoid the "I toggled it but nothing
// happened" confusion. (The catalog ID itself is left intact — it's a runtime
// gate key referenced elsewhere — we only drop it from this option list.)
const PLAN_HIDDEN_INTEGRATION_IDS = new Set(['webpages']);

// Mirrors OrgFeatureTogglesPanel.pickBetaIcon — keyword sniff over the
// beta's id/name. Kept locally so we don't reach into the admin panel.
function pickBetaIcon(idOrName) {
    const s = (idOrName || '').toLowerCase();
    if (s.includes('compliance') || s.includes('gdpr')) return <ShieldCheck className="w-4 h-4" />;
    if (s.includes('skill'))                       return <Sparkles className="w-4 h-4" />;
    if (s.includes('automation'))                     return <Clock className="w-4 h-4" />;
    if (s.includes('knowledge') || s.includes('kb')) return <BookOpen className="w-4 h-4" />;
    if (s.includes('webpage') || s.includes('web')) return <Globe className="w-4 h-4" />;
    if (s.includes('automation'))                  return <Workflow className="w-4 h-4" />;
    if (s.includes('memory'))                      return <Brain className="w-4 h-4" />;
    if (s.includes('zap') || s.includes('quick'))  return <Zap className="w-4 h-4" />;
    return <Sparkles className="w-4 h-4" />;
}

export function FeaturesSection({ form, update }) {
    const { t } = useTranslation();
    const [betaRegistry, setBetaRegistry] = useState([]);
    const [mcpRegistry, setMcpRegistry] = useState([]);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const data = await apiJson('/api/subscriptions/registries');
                if (!alive) return;
                setBetaRegistry(Array.isArray(data.beta_features) ? data.beta_features : []);
                setMcpRegistry(Array.isArray(data.mcp_servers) ? data.mcp_servers : []);
            } catch (e) {
                console.warn('Failed to load registries:', e);
            }
        })();
        return () => { alive = false; };
    }, []);

    // Catalog integrations + installed MCP servers in ONE list. MCP servers are
    // integrations now (id `mcp:<id>`), but tagged isMcp so the grid forces them
    // to be explicitly selected (never swept in by an unrestricted plan).
    const integrationOptions = useMemo(
        () => [
            ...INTEGRATION_CATALOG
                .filter(i => !PLAN_HIDDEN_INTEGRATION_IDS.has(i.id))
                .map(i => ({ id: i.id, label: i.label, description: i.description, category: i.category })),
            ...mcpRegistry.map(s => ({
                id: s.id,
                label: s.name,
                description: s.enabled === false
                    ? t('admin_subscriptions.features_mcp_disabled', '{description} · currently disabled on the server.', { description: s.description || '' }).trim()
                    : (s.description || ''),
                category: 'MCP servers',
                isMcp: true,
            })),
        ],
        [mcpRegistry, t]
    );
    const betaOptions = useMemo(
        () => betaRegistry.map(b => ({
            id: b.id,
            label: b.name,
            // Compound betas carry a license_feature — enabling the beta here
            // also grants its paid capability, so the gate unlocks end-to-end.
            description: b.license_feature
                ? t('admin_subscriptions.features_beta_license', '{description} · includes its license grant (enabling this beta unlocks the paid capability too).', { description: b.description })
                : b.description,
            category: 'Feature flags',
        })),
        [betaRegistry, t]
    );

    return (
        <div className="space-y-8">
            <div>
                <h3 className="text-[15px] font-bold text-[var(--text-primary)] mb-1">{t('admin_subscriptions.features_title', 'Features & integrations')}</h3>
                <p className="text-[12px] text-[var(--text-muted)]">{t('admin_subscriptions.features_desc', "Controls what's enabled for organizations on this plan.")}</p>
            </div>

            <div>
                <h4 className="text-[13px] font-semibold text-[var(--text-primary)] mb-2.5">
                    {t('admin_subscriptions.features_core', 'Core features')}
                    <span className="ml-2 font-normal text-[11px] text-[var(--text-muted)]">{t('admin_subscriptions.features_core_hint', 'base licensed capabilities; beta features below carry their own license grant. All selected = unrestricted')}</span>
                </h4>
                <FeatureChipGrid
                    selected={form.allowed_features}
                    onChange={v => update('allowed_features', v)}
                />
            </div>

            <div>
                <h4 className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)] mb-2.5">
                    <Puzzle className="w-4 h-4 text-blue-400" />
                    {t('admin_subscriptions.features_integrations', 'Included integrations')}
                </h4>
                <Banner tone="info" className="mb-3">
                    {t('admin_subscriptions.features_integrations_banner', "These integrations are capped at the org level: an org-admin cannot turn on anything outside this list. MCP servers are opt-in: they must be explicitly selected here (turn on \"Restrict to selection\"). They're never part of an unrestricted plan, so a newly installed server stays off until added.")}
                </Banner>
                <FeatureCardGrid
                    options={integrationOptions}
                    value={form.allowed_integrations}
                    onChange={v => update('allowed_integrations', v)}
                    renderIcon={(id, item) => item?.isMcp ? <Server className="w-4 h-4" /> : getIntegrationIcon(id)}
                    grouped
                    restrictLabel={t('admin_subscriptions.features_integrations_restrict', 'Restrict integrations to selection')}
                    restrictDescription={t('admin_subscriptions.features_integrations_restrict_desc', 'Off: every catalog integration is included (MCP servers still require explicit selection).')}
                />
            </div>

            <div>
                <h4 className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)] mb-2.5">
                    <FlaskConical className="w-4 h-4 text-emerald-400" />
                    {t('admin_subscriptions.features_beta', 'Included beta features')}
                </h4>
                <Banner tone="info" className="mb-3">
                    {t('admin_subscriptions.features_beta_banner', "On cloud, this list is the source of truth for beta access: it's what organizations on this plan actually get, no separate admin opt-in. Features that note \"includes its license grant\" also unlock their paid capability automatically.")}
                </Banner>
                <FeatureCardGrid
                    options={betaOptions}
                    value={form.allowed_beta_features}
                    onChange={v => update('allowed_beta_features', v)}
                    renderIcon={(_, item) => pickBetaIcon(item?.id || item?.label)}
                    grouped={false}
                    emptyHint={t('admin_subscriptions.features_beta_loading', 'Loading beta features…')}
                    restrictLabel={t('admin_subscriptions.features_beta_restrict', 'Restrict beta features to selection')}
                    restrictDescription={t('admin_subscriptions.features_beta_restrict_desc', 'Off: every beta feature in the registry is included with this plan.')}
                />
            </div>
        </div>
    );
}
