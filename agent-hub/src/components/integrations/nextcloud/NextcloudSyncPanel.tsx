import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Users, Loader2 } from 'lucide-react';
import { integrationsAdminKeys, useFreshOrgIdQuery, useNcSyncQuery } from '@/api/queries/integrationsAdmin';
import type { NcSyncConfig, NcSyncUser } from '@/api/queries/integrationsAdmin';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { ApiError, RefusedError, errorBody } from '@/api/mutate';
import { type ApiBody, apiRequest } from '@/api/typedRequest';
import { Button } from '@/components/shared/Button';
import ChoiceCards from '@/components/shared/ChoiceCards';
import SaveStatus from '@/components/shared/SaveStatus';
import { SettingBlock, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { ALERT_ERROR, ALERT_SUCCESS, ALERT_WARNING, CHIP, CHIP_SUCCESS, CHIP_WARNING, DOT_LIVE, DOT_OFF, DOT_WARN } from '@/components/shared/adminUi';
import { NC_SYNC_MODES, isNcSyncMode, relativeSince, syncModeDescription, syncModeLabel, type NcSyncMode } from './ncSyncText';
import { useAutosaveStatus } from './useAutosaveStatus';

// Theme tokens only, so every card, pill and control stays readable in every theme.
const STAT_CARD = 'rounded-lg px-3 py-2.5 bg-[var(--bg-secondary)] border border-[var(--border-subtle)]';
const STAT_LABEL = 'text-[10px] font-semibold uppercase tracking-wider mb-0.5 text-[var(--text-muted)]';
const CHECKBOX = 'h-3.5 w-3.5 accent-[var(--accent-primary)]';

/** "Selected groups" with no group to mirror: not stored until a group is chosen. */
const needsGroup = (c: NcSyncConfig) => c.mode === 'selective_groups' && !(c.syncGroups && c.syncGroups.length);

const statusChip = (status: string) => (status === 'active' ? CHIP_SUCCESS : status === 'pending' ? CHIP_WARNING : CHIP);

/**
 * Org-admin UI for Nextcloud user/group sync.
 *
 * The org is auto-bound to a NC instance during connector bootstrap. This
 * panel lets the admin pick the sync mode, exclude specific NC groups,
 * and force an on-demand re-sync. Every control saves itself (SaveStatus);
 * the page header is the admin dashboard frame's.
 */
interface NextcloudSyncPanelProps {
    user?: { organizationId?: string | null } | null;
    /** The organisation to act on; left out, the user's home organisation (outside the admin dashboard). */
    orgId?: string | null;
}

/** The org's sync config, NC groups and synced users, with the unsaved edits laid over the server answer. */
function useNcSyncData(user: NextcloudSyncPanelProps['user'], orgIdProp: string | null | undefined) {
    // The user prop may be a stale snapshot from initial App mount. If we
    // can't see an org id on it, re-fetch /auth/user once before deciding
    // to show "no org" — the connector flow auto-provisions on first hit.
    // A named organisation (the admin dashboard's) is used as it is, never re-read.
    const named = orgIdProp !== undefined;
    const propOrgId = (named ? orgIdProp : user?.organizationId) || null;
    const freshOrgId = useFreshOrgIdQuery(!named && !propOrgId).data ?? null;
    const orgId = named ? propOrgId : propOrgId || freshOrgId;
    const queryClient = useQueryClient();
    const syncQuery = useNcSyncQuery(orgId);
    // Edits on top of the server answer until the next reload (after a sync) drops them.
    const [patch, setPatch] = useState<Partial<NcSyncConfig>>({});
    const config: NcSyncConfig | null = syncQuery.data?.config ? { ...syncQuery.data.config, ...patch } : null;
    const update = (change: Partial<NcSyncConfig>) => setPatch(p => ({ ...p, ...change }));
    const reload = async () => {
        setPatch({});
        await queryClient.refetchQueries({ queryKey: integrationsAdminKeys.ncSync(orgId) });
    };
    return {
        orgId, config, update, reload,
        groups: syncQuery.data?.groups ?? [] as string[],
        users: syncQuery.data?.users ?? [] as NcSyncUser[],
        loading: syncQuery.isPending,
    };
}

/** PUT nc-sync with the whole configuration; a refusal is "not saved". */
async function saveNcSync(orgId: string | null, config: NcSyncConfig, t: TranslateFn): Promise<void> {
    type Body = ApiBody<'PUT /auth/admin/{orgId}/nc-sync'>;
    try {
        await apiRequest('PUT /auth/admin/{orgId}/nc-sync', {
            params: { orgId: String(orgId) },
            body: {
                mode: config.mode as Body['mode'],
                syncGroups: config.syncGroups,
                excludedGroups: config.excludedGroups,
                newUserDefaultStatus: config.newUserDefaultStatus as Body['newUserDefaultStatus'],
            },
        });
    } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        throw new Error(t('admin_connections.save_failed', 'Not saved. Try again.'));
    }
}

/** POST nc-sync/run; a refusal reads as the server's `error` (or "Sync failed"). */
async function runNcSync(orgId: string | null, t: TranslateFn): Promise<{ created?: number; deactivated?: number }> {
    try {
        const res = await apiRequest('POST /auth/admin/{orgId}/nc-sync/run', { params: { orgId: String(orgId) } });
        return await res.json();
    } catch (err) {
        if (err instanceof RefusedError) throw new Error((errorBody(err) as { error?: string } | null)?.error || t('admin_connections.nc_sync_failed', 'Sync failed.'));
        throw err;
    }
}

type SyncResult = { ok: true; created: number; deactivated: number } | { ok: false; text: string };

const NextcloudSyncPanel = ({ user, orgId: orgIdProp }: NextcloudSyncPanelProps) => {
    const { t, resolvedLocale } = useTranslation();
    const { orgId, config, groups, users, loading, update, reload } = useNcSyncData(user, orgIdProp);
    const autosave = useAutosaveStatus();
    const [syncing, setSyncing] = useState(false);
    const [result, setResult] = useState<SyncResult | null>(null);

    if (loading) return <div role="status"><Loader2 className="animate-spin text-[var(--text-muted)]" aria-label={t('common.loading', 'Loading...')} /></div>;
    if (!config) return <div className="text-sm text-[var(--text-muted)]">{t('integ.nextcloud_sync_nextcloud_sync_is_only_available_for', 'Nextcloud sync is only available for organisations bound to a Nextcloud instance.')}</div>;

    /**
     * Every change is saved at once with the whole configuration, except
     * "Selected groups" without a group: stored, it mirrors nobody and the next
     * group change in Nextcloud switches that member's account off. It waits
     * on screen until a group is ticked, which then saves both.
     */
    const change = (patch: Partial<NcSyncConfig>) => {
        const next = { ...config, ...patch };
        update(patch);
        if (needsGroup(next)) return;
        void autosave.run(() => saveNcSync(orgId, next, t));
    };
    const toggleGroup = (key: 'syncGroups' | 'excludedGroups', group: string) => {
        const list = config[key] || [];
        change({ [key]: list.includes(group) ? list.filter((g: string) => g !== group) : [...list, group] });
    };
    const handleSyncNow = async () => {
        setSyncing(true);
        setResult(null);
        try {
            const j = await runNcSync(orgId, t);
            setResult({ ok: true, created: j.created || 0, deactivated: j.deactivated || 0 });
            await reload();
        } catch (e) {
            setResult({ ok: false, text: (e as Error).message });
        } finally { setSyncing(false); }
    };

    const mode: NcSyncMode = isNcSyncMode(config.mode) ? config.mode : 'manual';
    const manual = mode === 'manual';
    // The shown mode is not stored yet: a sync would still run the stored one.
    const waitingForGroup = needsGroup(config);
    return (
        <div className="flex flex-col gap-6" data-testid="nextcloud-sync-panel">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <SaveStatus saveState={autosave.state} lastSavedAt={autosave.lastSavedAt} onRetry={autosave.retry} showWhenIdle size={12} />
                <Button
                    variant="primary" size="sm" icon={syncing ? undefined : RefreshCw} busy={syncing} disabled={manual || waitingForGroup} onClick={handleSyncNow}
                    title={manual ? t('admin_connections.nc_sync_manual_hint', 'The sync mode is Manual only. Pick another mode to sync.') : t('admin_connections.nc_sync_now_hint', 'Compare with Nextcloud and sync now')}
                >
                    {syncing && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                    {t('integ.nextcloud_sync_sync_now', 'Sync now')}
                </Button>
            </div>
            {autosave.state === 'error' && autosave.error && <div role="alert" className={ALERT_ERROR}>{autosave.error}</div>}
            {result && (result.ok
                ? <div role="status" className={ALERT_SUCCESS}>{t('admin_connections.nc_sync_done', 'Sync done: {created} created, {deactivated} deactivated.', { created: result.created, deactivated: result.deactivated })}</div>
                : <div role="alert" className={ALERT_ERROR}>{result.text}</div>)}

            <SyncStats t={t} config={config} mode={mode} users={users} locale={resolvedLocale} />

            <SettingsGroup title={t('integ.nextcloud_sync_sync_mode', 'Sync mode')}>
                <ChoiceCards
                    value={mode}
                    onChange={next => change({ mode: next })}
                    ariaLabel={t('integ.nextcloud_sync_sync_mode', 'Sync mode')}
                    columns={3}
                    options={NC_SYNC_MODES.map(m => ({ value: m, label: syncModeLabel(t, m), description: syncModeDescription(t, m) }))}
                />
            </SettingsGroup>

            <SettingsGroup title={t('admin_connections.nc_accounts_title', 'New accounts')}>
                <SettingsList>
                    <SettingRow label={t('integ.nextcloud_sync_new_user_default_status', 'New user default status')} htmlFor="nc-sync-default-status">
                        <select
                            id="nc-sync-default-status"
                            value={config.newUserDefaultStatus}
                            onChange={e => change({ newUserDefaultStatus: e.target.value })}
                            className="w-full rounded-md border px-2 py-1.5 text-[13px] outline-none bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)] focus:border-[var(--accent-primary)]"
                        >
                            <option value="active">{t('integ.nextcloud_sync_active_immediately_recommended', 'Active immediately (recommended)')}</option>
                            <option value="pending">{t('integ.nextcloud_sync_pending_admin_must_approve', 'Pending — admin must approve')}</option>
                        </select>
                    </SettingRow>
                    {mode === 'selective_groups' && (
                        <SettingBlock label={t('integ.nextcloud_sync_groups_to_mirror', 'Groups to mirror')} hint={t('admin_connections.nc_groups_to_mirror_hint', 'Only members of these Nextcloud groups get an account.')}>
                            {waitingForGroup && (
                                <div role="note" className={`${ALERT_WARNING} mb-2`}>
                                    {t('admin_connections.nc_pick_a_group', 'Pick at least one group. "Selected groups" is saved once a group is ticked; until then the saved mode stays in force.')}
                                </div>
                            )}
                            <GroupChecklist groups={groups} checked={config.syncGroups} onToggle={g => toggleGroup('syncGroups', g)} />
                        </SettingBlock>
                    )}
                    <SettingBlock label={t('integ.nextcloud_sync_excluded_groups', 'Excluded groups')} hint={t('admin_connections.nc_excluded_hint', 'Members of these Nextcloud groups never get an account, whatever the sync mode.')}>
                        <GroupChecklist groups={groups} checked={config.excludedGroups} onToggle={g => toggleGroup('excludedGroups', g)} />
                    </SettingBlock>
                </SettingsList>
            </SettingsGroup>

            <SettingsGroup title={<span className="inline-flex items-center gap-2"><Users className="w-4 h-4" aria-hidden="true" />{t('integ.nextcloud_sync_synced_users_count', 'Synced users ({count})', { count: users.length })}</span>}>
                <ul className="max-h-48 overflow-y-auto divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-sm text-[var(--text-primary)]">
                    {users.map(u => (
                        <li key={u.id} className="px-3 py-1.5 flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate">{u.displayName} <span className="text-[var(--text-muted)]">({u.email})</span></span>
                            <span className={statusChip(u.status)}>{userStatusLabel(t, u.status)}</span>
                        </li>
                    ))}
                </ul>
            </SettingsGroup>
        </div>
    );
};

export default NextcloudSyncPanel;

function userStatusLabel(t: TranslateFn, status: string): string {
    switch (status) {
        case 'active': return t('admin_connections.nc_user_active', 'Active');
        case 'pending': return t('admin_connections.nc_user_pending', 'Pending');
        case 'disabled': return t('admin_connections.nc_user_disabled', 'Disabled');
        default: return status;
    }
}

function GroupChecklist({ groups, checked, onToggle }: { groups: readonly string[]; checked: readonly string[] | undefined; onToggle: (group: string) => void }) {
    const { t } = useTranslation();
    if (groups.length === 0) return <p className="m-0 text-xs text-[var(--text-muted)]">{t('admin_connections.nc_no_groups', 'No Nextcloud groups yet. Run a sync first.')}</p>;
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 max-h-40 overflow-y-auto">
            {groups.map(g => (
                <label key={g} className="flex items-center gap-2 text-sm text-[var(--text-primary)] cursor-pointer">
                    <input type="checkbox" className={CHECKBOX} checked={!!checked?.includes(g)} onChange={() => onToggle(g)} />
                    {g}
                </label>
            ))}
        </div>
    );
}

function SyncStats({ t, config, mode, users, locale }: { t: TranslateFn; config: NcSyncConfig; mode: NcSyncMode; users: NcSyncUser[]; locale: string }) {
    // The clock is read once per mount: the page is re-read after every sync anyway.
    const [now] = useState(() => Date.now());
    const activeUsers = users.filter(u => u.status === 'active').length;
    const isFresh = !!config.lastSyncAt && (now - new Date(config.lastSyncAt).getTime() < 30 * 60_000);
    return (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className={STAT_CARD}>
                <div className={STAT_LABEL}>{t('integ.nextcloud_sync_instance', 'Instance')}</div>
                <div className="text-[12px] font-medium truncate text-[var(--text-primary)]" title={config.ncBaseUrl}>
                    {config.ncBaseUrl ? config.ncBaseUrl.replace(/^https?:\/\//, '') : '—'}
                </div>
            </div>
            <div className={STAT_CARD}>
                <div className={STAT_LABEL}>{t('integ.nextcloud_sync_sync_mode', 'Sync mode')}</div>
                <div className="text-[12px] font-medium text-[var(--text-primary)]">{syncModeLabel(t, mode)}</div>
            </div>
            <div className={STAT_CARD}>
                <div className={STAT_LABEL}>{t('integ.nextcloud_sync_active_users', 'Active users')}</div>
                <div className="text-[12px] font-medium text-[var(--text-primary)]">{activeUsers} <span className="text-[var(--text-muted)] font-normal">/ {users.length}</span></div>
            </div>
            <div className={STAT_CARD}>
                <div className={STAT_LABEL}>{t('integ.nextcloud_sync_last_sync', 'Last sync')}</div>
                <div className="text-[12px] font-medium flex items-center gap-1.5 text-[var(--text-primary)]">
                    <span className={isFresh ? DOT_LIVE : config.lastSyncAt ? DOT_WARN : DOT_OFF} aria-hidden="true" />
                    {relativeSince(config.lastSyncAt, locale, now) ?? t('admin_connections.nc_never', 'Never')}
                </div>
            </div>
        </div>
    );
}
