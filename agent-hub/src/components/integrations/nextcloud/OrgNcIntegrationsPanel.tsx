import React, { useState } from 'react';
import { ChevronRight, Loader2, Users } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useNcIntegrationsQuery } from '@/api/queries/integrationsAdmin';
import { ORG_INTEGRATION_AVAILABILITY_PREFIX } from '@/api/queries/orgIntegrationAvailability';
import type { NcCatalogItem, NcGroup, NcIntegrationsConfig } from '@/api/queries/integrationsAdmin';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { ApiError } from '@/api/mutate';
import { panelOrgId } from '@/utils/adminAccess';
import { apiRequest } from '@/api/typedRequest';
import SaveStatus from '@/components/shared/SaveStatus';
import Toggle from '@/components/shared/Toggle';
import { SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { ALERT_ERROR, CHIP, CHIP_WARNING } from '@/components/shared/adminUi';
import { useAutosaveStatus } from './useAutosaveStatus';

const CHECKBOX = 'h-3.5 w-3.5 accent-[var(--accent-primary)] disabled:cursor-not-allowed';

interface OrgNcIntegrationsPanelProps {
    user?: { organizationId?: string } | null;
    /** The organisation to act on; left out, the user's home organisation (outside the admin dashboard). */
    orgId?: string | null;
}

/** A PUT that a refusal turns into "not saved". */
async function put(t: TranslateFn, send: () => Promise<unknown>): Promise<void> {
    try {
        await send();
    } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        throw new Error(t('admin_connections.save_failed', 'Not saved. Try again.'));
    }
}

/**
 * Org-admin UI for switching Nextcloud integrations on org-wide and adding
 * per-group exceptions. Only rendered for organisations bound to a Nextcloud
 * (the chosen organisation's availability, upstream in OrgIntegrationSettings).
 * Every switch and checkbox saves itself.
 *
 * Conflict resolution at runtime is "enable wins": a tool is blocked for a
 * person only when EVERY group they belong to blocks it — see
 * server/core/integrations/runtimeAppGate.js and userAppGate.js. The copy says so.
 */
const OrgNcIntegrationsPanel = ({ user, orgId: orgIdProp }: OrgNcIntegrationsPanelProps) => {
    const { t } = useTranslation();
    const orgId = panelOrgId(orgIdProp, user) ?? undefined;
    const ncQuery = useNcIntegrationsQuery(orgId);
    // Edits on top of the server answer (optimistic); a failed save puts the row back.
    const [enabledDraft, setEnabledDraft] = useState<string[] | null>(null);
    const [groupDraft, setGroupDraft] = useState<Record<string, string[]>>({});
    const config: NcIntegrationsConfig | null = ncQuery.data?.config ? { ...ncQuery.data.config, enabled: enabledDraft ?? ncQuery.data.config.enabled } : null;
    const groups: NcGroup[] = (ncQuery.data?.groups ?? []).map((g: NcGroup) => (groupDraft[g.id] ? { ...g, disabledIntegrations: groupDraft[g.id] } : g));
    const autosave = useAutosaveStatus();
    const queryClient = useQueryClient();

    // A failed save puts its row back only while nothing newer was chosen on
    // top of it: a later change, saved after it, already carries the whole list.
    const toggleOrgWide = async (id: string) => {
        if (!config) return;
        const before = config.enabled;
        const next = before.includes(id) ? before.filter((x: string) => x !== id) : [...before, id];
        setEnabledDraft(next);
        const ok = await autosave.run(() => put(t, () => apiRequest('PUT /auth/admin/{orgId}/nc-integrations', { params: { orgId: String(orgId) }, body: { enabled: next } })));
        if (!ok) setEnabledDraft(cur => (cur === next ? before : cur));
        // The org-wide switches decide which Nextcloud apps the organisation has (Integration status).
        else void queryClient.invalidateQueries({ queryKey: ORG_INTEGRATION_AVAILABILITY_PREFIX });
    };

    const toggleGroupDisable = async (groupId: string, integrationId: string) => {
        const group = groups.find((g: NcGroup) => g.id === groupId);
        if (!group) return;
        const cur = Array.isArray(group.disabledIntegrations) ? group.disabledIntegrations : [];
        const next = cur.includes(integrationId) ? cur.filter((x: string) => x !== integrationId) : [...cur, integrationId];
        setGroupDraft((d) => ({ ...d, [groupId]: next }));
        const ok = await autosave.run(() => put(t, () => apiRequest('PUT /auth/admin/{orgId}/nc-integrations/groups/{groupId}', { params: { orgId: String(orgId), groupId }, body: { disabledIntegrations: next } })));
        if (!ok) setGroupDraft((d) => (d[groupId] === next ? { ...d, [groupId]: cur } : d));
    };

    if (ncQuery.isPending) {
        return <div role="status" className="p-6"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" aria-label={t('common.loading', 'Loading...')} /></div>;
    }
    if (!config) {
        return <div className="p-6 text-sm text-[var(--text-muted)]">{t('integ.org_nc_integrations_nextcloud_integrations_are_only', 'Nextcloud integrations are only available for organisations bound to a Nextcloud instance.')}</div>;
    }

    const catalog = config.ncCatalog || [];
    return (
        <div className="flex flex-col gap-6" data-testid="org-nc-integrations">
            <SettingsGroup
                title={t('integ.org_nc_integrations_nextcloud_integrations', 'Nextcloud integrations')}
                description={t('admin_connections.nc_tools_desc', 'The Nextcloud tools agents may use for every member of this organisation. Changes apply immediately.')}
                actions={<SaveStatus saveState={autosave.state} lastSavedAt={autosave.lastSavedAt} onRetry={autosave.retry} showWhenIdle size={12} />}
            >
                {autosave.state === 'error' && autosave.error && <div role="alert" className={ALERT_ERROR}>{autosave.error}</div>}
                <SettingsList>
                    {catalog.map((it: NcCatalogItem) => (
                        <Toggle
                            key={it.id}
                            flat
                            checked={config.enabled.includes(it.id)}
                            onChange={() => { void toggleOrgWide(it.id); }}
                            label={it.name}
                            description={it.description}
                        />
                    ))}
                </SettingsList>
            </SettingsGroup>
            <GroupExceptions t={t} groups={groups} catalog={catalog} config={config} toggleGroupDisable={toggleGroupDisable} />
        </div>
    );
};

export default OrgNcIntegrationsPanel;

interface GroupExceptionsProps {
    t: TranslateFn;
    groups: NcGroup[];
    catalog: NcCatalogItem[];
    config: NcIntegrationsConfig;
    toggleGroupDisable: (groupId: string, integrationId: string) => Promise<void>;
}

function GroupExceptions({ t, groups, catalog, config, toggleGroupDisable }: GroupExceptionsProps) {
    const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
    return (
        <SettingsGroup
            title={t('integ.org_nc_integrations_per_group_exceptions', 'Per-group exceptions')}
            description={t('admin_connections.nc_group_rule', 'Block a tool for a Nextcloud group. A person loses the tool only when every group they belong to blocks it: membership of any other group keeps it on.')}
        >
            {groups.length === 0 ? (
                <p className="m-0 text-xs text-[var(--text-muted)]">{t('integ.org_nc_integrations_no_nextcloud_groups_synced_yet_sync', 'No Nextcloud groups synced yet. Sync runs automatically every 6 hours, or use "Sync now" under Nextcloud.')}</p>
            ) : (
                <SettingsList>
                    {groups.map((g: NcGroup) => (
                        <GroupRow key={g.id} t={t} group={g} catalog={catalog} config={config} open={expandedGroup === g.id}
                            onOpen={(open) => setExpandedGroup(open ? g.id : null)} onToggle={(id) => { void toggleGroupDisable(g.id, id); }} />
                    ))}
                </SettingsList>
            )}
        </SettingsGroup>
    );
}

interface GroupRowProps {
    t: TranslateFn;
    group: NcGroup;
    catalog: NcCatalogItem[];
    config: NcIntegrationsConfig;
    open: boolean;
    onOpen: (open: boolean) => void;
    onToggle: (integrationId: string) => void;
}

function GroupRow({ t, group: g, catalog, config, open, onOpen, onToggle }: GroupRowProps): React.ReactElement {
    const blocked = g.disabledIntegrations || [];
    return (
        <div>
            <button type="button" onClick={() => onOpen(!open)} aria-expanded={open}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--item-hover-bg)] transition-colors">
                <ChevronRight className={`w-3.5 h-3.5 transition-transform text-[var(--text-muted)] ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
                <span className="text-[13px] font-medium flex-1 truncate text-[var(--text-primary)]">{g.name}</span>
                <span className={CHIP}><Users className="w-3 h-3" aria-hidden="true" /> {g.userCount}</span>
                {blocked.length > 0 && (
                    <span className={CHIP_WARNING}>{t('admin_connections.nc_blocked_count', '{count} blocked', { count: blocked.length })}</span>
                )}
            </button>
            {open && (
                <div className="px-4 pb-3 pt-1 grid grid-cols-1 sm:grid-cols-2 gap-1.5 bg-[var(--bg-secondary)]">
                    {catalog.map((it: NcCatalogItem) => {
                        const orgOn = config.enabled.includes(it.id);
                        return (
                            <label key={it.id}
                                className={`flex items-center gap-2 p-2 rounded-md text-[12px] ${orgOn ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
                                title={orgOn ? undefined : t('admin_connections.nc_enable_first', 'Switch this tool on for the organisation first.')}>
                                <input type="checkbox" className={CHECKBOX} disabled={!orgOn} checked={blocked.includes(it.id)} onChange={() => orgOn && onToggle(it.id)} />
                                <span className="text-[var(--text-primary)]">{t('admin_connections.nc_block_name', 'Block {name}', { name: it.name })}</span>
                            </label>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
