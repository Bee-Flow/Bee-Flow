import { useEffect, useMemo } from 'react';
import useGuardrailsData from './api/useGuardrailsData';
import DirectChatView from './directchat/DirectChatView';
import { availableSections, resolveSection, isKnownButUnavailable, pathFor, LIBRARY_PATH, PRIVACY_SHIELD_PATH } from './guardrailsRoutes';
import OrgShieldEditor from './orgShield/OrgShieldEditor';
import HealthBanner from './overview/HealthBanner';
import StatStrip from './overview/StatStrip';
import PatternsView from './patterns/PatternsView';
import { useTranslation } from '@/hooks/useTranslation';
import Spinner from '@/components/shared/Spinner';
import SectionHeader from '@/components/shared/SectionHeader';
import Tabs from '@/components/shared/Tabs';
import { adminSectionScope } from '@/components/admin/dashboard/adminTabs';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { useAdminScopeOverride } from '@/components/admin/dashboard/useAdminScopeOverride';

/**
 * Guardrail Configs — the server-operator console.
 *
 * The page this replaces mixed two scopes in one tab strip: regex rules and
 * direct chat are INSTALLATION-wide, while the Privacy Shield tab edited one
 * organisation. Nothing on screen distinguished them, which is how an admin
 * could believe they were configuring a tenant while editing a global default,
 * and vice versa. Here the authoring tabs come first and anything per-org lives
 * behind "Organisations".
 *
 * Sections are capability-gated (see guardrailsRoutes): the artefact types this
 * console is being built for do not all have endpoints yet, so a tab appears
 * when its route exists rather than 404-ing in place.
 */
interface GuardrailsHubProps {
    section: string;
    onNavigate: ((path: string) => void) | undefined;
    /**
     * 'library': the server console only (the admin dashboard's Guardrail
     * library row, admin/security/guardrail-library/<section>); the
     * per-organisation shield is the Privacy Shield row. Left out: both, the
     * shield as the Organisations tab.
     */
    mode?: 'all' | 'library';
}

/** The sections the mode offers, and where a section's address and the stale-reference link go. */
function modeRoutes(mode: 'all' | 'library') {
    if (mode === 'all') return { keep: () => true, path: (id: string) => pathFor(id), staleTarget: pathFor('organisations') };
    return { keep: (id: string) => id !== 'organisations', path: (id: string) => pathFor(id, LIBRARY_PATH), staleTarget: PRIVACY_SHIELD_PATH };
}

const GuardrailsHub = ({ section, onNavigate, mode = 'all' }: GuardrailsHubProps) => {
    const { t } = useTranslation();
    const data = useGuardrailsData();
    // The organisation the dashboard works on; none = every organisation, then the editor's own picker applies.
    const chosenOrgId = useAdminOrgChoice()?.orgId ?? null;
    const { capabilities, loading, error } = data;
    const routes = useMemo(() => modeRoutes(mode), [mode]);

    const sections = useMemo(() => availableSections(capabilities).filter(s => routes.keep(s.id)), [capabilities, routes]);
    const active = resolveSection(section, sections);
    // The scope follows the sub-section that is open: the console is server-wide, the shield is per organisation.
    useAdminScopeOverride(active ? (active === 'organisations' ? adminSectionScope('security', 'guardrails') : adminSectionScope('security', 'guardrail-library')) : null);

    // Normalise the URL when it names nothing renderable, so a refresh or a
    // shared link lands on the same place the user is actually looking at.
    useEffect(() => {
        if (!active || loading) return;
        if (section !== active) {
            window.history.replaceState({}, '', `/app/${routes.path(active)}`);
        }
    }, [active, section, loading, routes]);

    const showUnavailableNotice = isKnownButUnavailable(section, sections);

    const tabItems = sections.map(s => ({
        id: s.id,
        label: t(s.labelKey, s.fallback),
        icon: <s.icon size={14} aria-hidden="true" />,
    }));

    const activeMeta = sections.find(s => s.id === active);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-16">
                <Spinner size="md" label={t('admin.gr_loading', 'Loading guardrail configuration…')} />
            </div>
        );
    }

    return (
        <div className="space-y-5">

            <SectionHeader
                title={t('admin.gr_title', 'Guardrail configs')}
                description={t('admin.gr_subtitle', 'Reusable security configuration for organisations on this server.')}
            />

            <StatStrip
                rules={data.rules.length}
                collections={data.collections.length}
                orgsBound={data.orgsWithShieldOn}
                orgsTotal={data.orgs.length}
                staleRefs={data.staleRefs}
                onShowStale={() => onNavigate?.(routes.staleTarget)}
            />

            <HealthBanner status={data.guardStatus} />

            {(error as Error | null) && (
                <div role="alert" className="flex items-center justify-between gap-4 rounded-xl border border-[color-mix(in_srgb,var(--error)_30%,transparent)] bg-[color-mix(in_srgb,var(--error)_10%,transparent)] px-4 py-3">
                    <p className="text-sm text-[var(--text-primary)]">
                        {t('admin.gr_load_failed', 'Could not load the guardrail configuration.')}
                    </p>
                    <button
                        onClick={data.reload}
                        className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg border border-[color-mix(in_srgb,var(--error)_40%,transparent)] text-[var(--error-ink)]
                                   hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--error)]"
                    >
                        {t('admin.gr_retry', 'Retry')}
                    </button>
                </div>
            )}

            <Tabs
                value={active as string}
                onChange={(id) => onNavigate?.(routes.path(id))}
                items={tabItems}
                ariaLabel={t('admin.gr_title', 'Guardrail configs')}
            />

            {showUnavailableNotice && (
                <p role="status" className="text-xs px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                    {t('admin.gr_section_unavailable', 'That section is not available on this server yet — showing the closest one instead.')}
                </p>
            )}

            {activeMeta?.descKey && (
                <p className="text-xs text-[var(--text-tertiary)]">
                    {t(activeMeta.descKey, activeMeta.descFallback)}
                </p>
            )}

            <div>
                {active === 'patterns' && (
                    <PatternsView
                        rules={data.rules}
                        setRules={data.setRules}
                        collections={data.collections}
                        setCollections={data.setCollections}
                        onSaved={data.reload}
                    />
                )}

                {active === 'directchat' && (
                    <DirectChatView
                        collections={data.collections}
                        directChat={data.directChat}
                        setDirectChat={data.setDirectChat}
                        onSaved={data.reload}
                    />
                )}

                {active === 'organisations' && (
                    /* The dashboard's organisation, pinned and with its "What happened" tab;
                       with none chosen the editor's own picker applies (no activity tab:
                       the endpoints need to know which organisation to read). */
                    chosenOrgId
                        ? <OrgShieldEditor key={chosenOrgId} orgId={chosenOrgId} showActivityTab activityOrgId={chosenOrgId} />
                        : <OrgShieldEditor allowOrgPicker />
                )}
            </div>
        </div>
    );
};

export default GuardrailsHub;
