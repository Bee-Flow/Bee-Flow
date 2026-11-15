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
import { Button } from '@/components/shared/Button';
import { ALERT_ERROR, ALERT_INFO } from '@/components/shared/adminUi';
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
    /** The sub-section the address names; none or an unknown one opens the closest available. */
    section?: string;
    onNavigate: ((path: string) => void) | undefined;
    /**
     * 'library': the server console only (the admin dashboard's Guardrail
     * library row, admin/security/guardrail-library/<section>); the
     * per-organisation shield is the Privacy Shield row, and the dashboard's
     * page frame draws the header (the rail label). Left out: both, the shield
     * as the "Per organisation" tab, under the console's own header.
     */
    mode?: 'all' | 'library';
}

/** The sections the mode offers, and where a section's address and the stale-reference link go. */
function modeRoutes(mode: 'all' | 'library') {
    if (mode === 'all') return { keep: () => true, path: (id: string) => pathFor(id), staleTarget: pathFor('organisations') };
    return { keep: (id: string) => id !== 'organisations', path: (id: string) => pathFor(id, LIBRARY_PATH), staleTarget: PRIVACY_SHIELD_PATH };
}

/** The scope of the open sub-section: the console is server-wide, the shield per organisation. */
function consoleScope(active: string | null) {
    if (!active) return null;
    return active === 'organisations' ? adminSectionScope('security', 'guardrails') : adminSectionScope('security', 'guardrail-library');
}

/** The console's own header: the full console only; the library row's header is the dashboard frame's. */
function ConsoleHeader({ mode }: { mode: 'all' | 'library' }) {
    const { t } = useTranslation();
    if (mode !== 'all') return null;
    return (
        <SectionHeader
            title={t('admin.gr_title', 'Guardrail configs')}
            description={t('admin.gr_subtitle', 'Reusable security configuration for organisations on this server.')}
        />
    );
}

/** A failed load, with a retry rather than a blank pane. */
function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
    const { t } = useTranslation();
    if (!error) return null;
    return (
        <div role="alert" className={`${ALERT_ERROR} items-center justify-between gap-4`}>
            <p className="m-0">{t('admin.gr_load_failed', 'Could not load the guardrail configuration.')}</p>
            <Button variant="secondary" size="sm" onClick={onRetry}>{t('admin.gr_retry', 'Retry')}</Button>
        </div>
    );
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
    useAdminScopeOverride(consoleScope(active));

    // Normalise the URL when it names nothing renderable, so a refresh or a
    // shared link lands on the same place the user is actually looking at.
    useEffect(() => {
        if (!active || loading) return;
        if (section !== active) {
            window.history.replaceState({}, '', `/app/${routes.path(active)}`);
        }
    }, [active, section, loading, routes]);

    const showUnavailableNotice = isKnownButUnavailable(section, sections);

    const tabsLabel = mode === 'library' ? t('admin_platform.guardrail_library', 'Guardrail library') : t('admin.gr_title', 'Guardrail configs');
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
        <div className="space-y-5" data-guardrails-mode={mode}>
            <ConsoleHeader mode={mode} />

            <StatStrip
                rules={data.rules.length}
                collections={data.collections.length}
                orgsBound={data.orgsWithShieldOn}
                orgsTotal={data.orgs.length}
                staleRefs={data.staleRefs}
                onShowStale={() => onNavigate?.(routes.staleTarget)}
            />

            <HealthBanner status={data.guardStatus} />

            <LoadError error={error} onRetry={data.reload} />

            <Tabs
                value={active as string}
                onChange={(id) => onNavigate?.(routes.path(id))}
                items={tabItems}
                ariaLabel={tabsLabel}
            />

            {showUnavailableNotice && (
                <p role="status" className={ALERT_INFO}>
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
