// The body of an organisation's Entra ID group sync (GroupSyncBlock holds the
// state and the calls): the last run with "Sync now", the outcome of a run,
// and, once a directory is connected, the sync settings and the permissions
// the app registration needs. Theme tokens only; Microsoft blue is for the logo.

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Clock, Info, RefreshCw, XCircle } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import { Button } from '@/components/shared/Button';
import Toggle from '@/components/shared/Toggle';
import { SettingRow, SettingsList } from '@/components/shared/SettingsList';
import { ALERT_ERROR, ALERT_INFO, ALERT_SUCCESS, ALERT_WARNING, CHIP } from '@/components/shared/adminUi';
import { relativeSince } from '@/components/integrations/nextcloud/ncSyncText';
import type { GroupSyncSettings, GroupSyncStatus, SyncResult } from './groupSync.types';

interface GroupSyncSectionProps {
    status: GroupSyncStatus;
    settings: GroupSyncSettings;
    onSync: () => void;
    syncing: boolean;
    /** A directory is connected: the run and the settings are offered only then. */
    connected: boolean;
    syncResult: SyncResult | null;
    syncError: string | null;
    onSetting: (key: keyof GroupSyncSettings, value: number | boolean) => void;
    /** The line shown while no directory is connected. */
    notConnectedHint: string;
}

/** The Graph application permissions group sync reads with. */
const REQUIRED_PERMISSIONS = ['GroupMember.Read.All', 'User.Read.All', 'Application.Read.All'] as const;

/** When the periodic sync runs next, or null when it is off or never ran. */
function nextSyncLabel(t: TranslateFn, status: GroupSyncStatus, settings: GroupSyncSettings): { text: string; overdue: boolean } | null {
    if (!settings.periodicSync || !status.lastSyncAt) return null;
    const diffMs = new Date(status.lastSyncAt).getTime() + settings.syncIntervalHours * 3_600_000 - Date.now();
    if (diffMs < 0) return { text: t('azure.sync_overdue', 'Overdue'), overdue: true };
    const minutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (minutes < 1) return { text: t('azure.sync_next_imminent', 'Any moment'), overdue: false };
    if (hours < 1) return { text: `${minutes}m`, overdue: false };
    return { text: rest > 0 ? `${hours}h ${rest}m` : `${hours}h`, overdue: false };
}

function LastRunIcon({ result }: { result?: string }) {
    if (result === 'success') return <CheckCircle2 size={18} className="text-[var(--success-ink)]" />;
    if (result === 'partial') return <AlertTriangle size={18} className="text-[var(--warning-ink)]" />;
    if (result === 'error') return <XCircle size={18} className="text-[var(--error-ink)]" />;
    return <Clock size={18} className="text-[var(--text-tertiary)]" />;
}

function LastRun({ status, settings, onSync, syncing, connected }: Pick<GroupSyncSectionProps, 'status' | 'settings' | 'onSync' | 'syncing' | 'connected'>) {
    const { t, resolvedLocale } = useTranslation();
    // How long ago, in the viewer's language ("5 minutes ago", "5 minuten geleden").
    const lastRun = relativeSince(status.lastSyncAt, resolvedLocale);
    const next = nextSyncLabel(t, status, settings);
    return (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-4 py-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--bg-secondary)]" aria-hidden="true">
                <LastRunIcon result={status.lastSyncResult} />
            </span>
            <div className="min-w-0 flex-1">
                <p className="m-0 text-[13px] font-medium text-[var(--text-primary)]">
                    {lastRun
                        ? `${t('azure.sync_last_synced', 'Last synced')}: ${lastRun}`
                        : t('azure.sync_never', 'Never synced')}
                </p>
                {status.lastSyncAt && (
                    <p className="m-0 text-xs text-[var(--text-tertiary)]">
                        {status.syncedGroups || 0} {t('azure.sso_group_s', 'group(s),')} {status.syncedUsers || 0} {t('azure.sso_user_s_synced', 'user(s) synced')}
                        {settings.periodicSync && ` · ${t('azure.sync_auto_every', 'Automatic sync every {hours}h', { hours: settings.syncIntervalHours })}`}
                    </p>
                )}
                {next && (
                    <p className={`m-0 flex items-center gap-1 text-xs ${next.overdue ? 'text-[var(--warning-ink)]' : 'text-[var(--success-ink)]'}`}>
                        <Clock size={10} aria-hidden="true" />
                        {t('azure.sync_next', 'Next sync')}: {next.text}
                    </p>
                )}
            </div>
            <Button variant="primary" size="sm" icon={RefreshCw} onClick={onSync} busy={syncing} disabled={!connected}>
                {syncing ? t('azure.sync_syncing', 'Syncing...') : t('azure.sync_groups_button', 'Sync now')}
            </Button>
        </div>
    );
}

function RunOutcome({ syncResult, syncError }: Pick<GroupSyncSectionProps, 'syncResult' | 'syncError'>) {
    const { t } = useTranslation();
    const [showDetails, setShowDetails] = useState(false);
    return (
        <>
            {syncResult && (
                <div className="flex flex-col gap-2">
                    <button type="button" className={`${ALERT_SUCCESS} w-full text-left`} onClick={() => setShowDetails(!showDetails)} aria-expanded={showDetails}>
                        <CheckCircle2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span className="flex-1 font-medium">
                            {t('azure.sync_groups_success', 'Sync completed')}: {syncResult.synced?.groups || 0} {t('azure.sso_group_s', 'group(s),')} {syncResult.synced?.users || 0} {t('azure.sso_new_user_s', 'new user(s)')}
                        </span>
                        {showDetails ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
                    </button>
                    {showDetails && syncResult.details && (
                        <div className="max-h-[200px] overflow-y-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3.5 py-2.5 font-mono text-[11px] text-[var(--text-secondary)]">
                            {syncResult.details.map((d, i) => <div key={i}>{d}</div>)}
                        </div>
                    )}
                </div>
            )}
            {syncError && (
                <div className={ALERT_ERROR} role="alert">
                    <XCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <div>
                        <p className="m-0 font-medium">{t('azure.sync_groups_error', 'Sync failed')}</p>
                        <p className="m-0 mt-0.5">{syncError}</p>
                    </div>
                </div>
            )}
        </>
    );
}

function SyncSettings({ settings, onSetting }: Pick<GroupSyncSectionProps, 'settings' | 'onSetting'>) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-2">
            <h4 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{t('azure.sync_settings', 'Sync settings')}</h4>
            <p className="m-0 text-xs text-[var(--text-tertiary)]">{t('azure.sync_settings_autosave', 'Changes apply immediately.')}</p>
            <SettingsList>
                <Toggle flat
                    checked={settings.autoActivateUsers}
                    onChange={(val) => onSetting('autoActivateUsers', val)}
                    label={t('azure.sync_auto_activate', 'Auto-activate synced users')}
                    description={t('azure.sync_auto_activate_desc', 'When enabled, new users from Entra ID groups are immediately active. When disabled, they require admin approval.')} />
                <div>
                    <Toggle flat
                        checked={settings.destructiveSync}
                        onChange={(val) => onSetting('destructiveSync', val)}
                        label={t('azure.sync_destructive', 'Destructive sync')}
                        description={t('azure.sync_destructive_desc', 'Remove groups and group memberships from Bee Flow when they are no longer assigned in Entra ID.')} />
                    {settings.destructiveSync && (
                        <div className="px-4 pb-3">
                            <p className={ALERT_WARNING}>
                                <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                                {t('azure.sync_destructive_warning', 'This removes users from Bee Flow groups and deletes synced groups that are no longer assigned to the enterprise app.')}
                            </p>
                        </div>
                    )}
                </div>
                <Toggle flat
                    checked={settings.periodicSync}
                    onChange={(val) => onSetting('periodicSync', val)}
                    label={t('azure.sync_periodic', 'Automatic periodic sync')}
                    description={t('azure.sync_periodic_desc', 'Automatically sync groups from Microsoft Entra ID at a regular interval.')} />
                {settings.periodicSync && (
                    <SettingRow label={t('azure.sync_interval', 'Sync every')} htmlFor="group-sync-interval" inline>
                        <select
                            id="group-sync-interval"
                            value={settings.syncIntervalHours}
                            onChange={(e) => onSetting('syncIntervalHours', parseInt(e.target.value, 10))}
                            className="rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                        >
                            <option value={1}>{t('azure.sso_1_hour', '1 hour')}</option>
                            <option value={3}>{t('azure.sso_3_hours', '3 hours')}</option>
                            <option value={6}>{t('azure.sso_6_hours', '6 hours')}</option>
                            <option value={12}>{t('azure.sso_12_hours', '12 hours')}</option>
                            <option value={24}>{t('azure.sso_24_hours', '24 hours')}</option>
                            <option value={48}>{t('azure.sso_48_hours', '48 hours')}</option>
                            <option value={168}>{t('azure.sso_weekly', 'Weekly')}</option>
                        </select>
                    </SettingRow>
                )}
            </SettingsList>
        </div>
    );
}

function RequiredPermissions() {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-4 py-3">
            <p className="m-0 text-[13px] font-medium text-[var(--text-primary)]">{t('azure.sync_permissions_title', 'Required Azure Permissions')}</p>
            <p className="m-0 text-xs text-[var(--text-tertiary)]">
                {t('azure.sync_permissions_desc', 'Microsoft Entra ID group sync needs these Application permissions in Azure Portal → App registrations → API permissions, with admin consent. Without group sync, leave them off the app registration:')}
            </p>
            <div className="mt-1 flex flex-wrap gap-1.5">
                {REQUIRED_PERMISSIONS.map(perm => <span key={perm} className={`${CHIP} font-mono`}>{perm}</span>)}
            </div>
        </div>
    );
}

export function GroupSyncSection(props: GroupSyncSectionProps) {
    const { connected, notConnectedHint } = props;
    return (
        <div className="flex flex-col gap-4">
            <LastRun {...props} />
            <RunOutcome syncResult={props.syncResult} syncError={props.syncError} />
            {!connected && (
                <p className={ALERT_INFO}>
                    <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                    {notConnectedHint}
                </p>
            )}
            {connected && <SyncSettings settings={props.settings} onSetting={props.onSetting} />}
            {connected && <RequiredPermissions />}
        </div>
    );
}
