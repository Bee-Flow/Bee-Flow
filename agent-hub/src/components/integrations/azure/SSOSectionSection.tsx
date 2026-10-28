import React from 'react';
import { AlertTriangle, RefreshCw, Loader2, Clock, CheckCircle2, XCircle, Info, ChevronDown, ChevronUp } from 'lucide-react';
import { TranslateParams } from '@/hooks/useTranslation';
import { Toggle } from './components';
import type { GroupSyncSettings, GroupSyncStatus, SyncResult } from './SSOSection.types';

export function SSOSectionSection({ t, status, formatTimeAgo, settings, handleSync, syncing, ssoConfigured, syncResult, setShowDetails, showDetails, syncError, handleSyncSetting }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; status: GroupSyncStatus; formatTimeAgo: (isoString: string | number | Date) => string; settings: GroupSyncSettings; handleSync: () => Promise<void>; syncing: boolean; ssoConfigured: boolean; syncResult: SyncResult | null; setShowDetails: React.Dispatch<React.SetStateAction<boolean>>; showDetails: boolean; syncError: string | null; handleSyncSetting: (key: string, value: number | boolean) => Promise<void>; }) {
    return <div className="space-y-4">
        <div>
            <h4 className="text-[13px] font-semibold text-[var(--text-primary)]">
                {t('azure.sync_groups_title', 'Azure AD Group Sync')}
            </h4>
            <p className="text-[11px] mt-0.5 text-[var(--text-muted)]">
                {t('azure.sync_groups_desc', 'Automatically sync groups and users assigned to your Azure AD enterprise app to BeeFlow.')}
            </p>
        </div>

        {/* Sync status card */}
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{
                background: status.lastSyncResult === 'success' ? 'rgba(34,197,94,0.12)' :
                    status.lastSyncResult === 'partial' ? 'rgba(245,158,11,0.12)' :
                        status.lastSyncResult === 'error' ? 'rgba(239,68,68,0.12)' : 'rgba(100,116,139,0.12)'
            }}>
                {status.lastSyncResult === 'success' ? <CheckCircle2 size={18} className="[color:#22c55e]" /> :
                    status.lastSyncResult === 'partial' ? <AlertTriangle size={18} className="[color:#f59e0b]" /> :
                        status.lastSyncResult === 'error' ? <XCircle size={18} className="[color:#ef4444]" /> :
                            <Clock size={18} className="text-[var(--text-muted)]" />}
            </div>
            <div className="flex-1">
                <p className="text-[12px] font-medium text-[var(--text-primary)]">
                    {status.lastSyncAt
                        ? `${t('azure.sync_last_synced', 'Last synced')}: ${formatTimeAgo(status.lastSyncAt)}`
                        : t('azure.sync_never', 'Never synced')}
                </p>
                {status.lastSyncAt && (
                    <p className="text-[11px] text-[var(--text-muted)]">
                        {status.syncedGroups || 0} {t('azure.sso_group_s', 'group(s),')} {status.syncedUsers || 0} {t('azure.sso_user_s_synced', 'user(s) synced')}
                        {settings.periodicSync && ` • Auto-sync every ${settings.syncIntervalHours}h`}
                    </p>
                )}
                {settings.periodicSync && status.lastSyncAt && (() => {
                    const nextSyncDate = new Date(new Date(status.lastSyncAt).getTime() + settings.syncIntervalHours * 60 * 60 * 1000);
                    const now = new Date();
                    const diffMs = nextSyncDate.getTime() - now.getTime();
                    const isOverdue = diffMs < 0;
                    const absDiffMin = Math.floor(Math.abs(diffMs) / 60000);
                    const absDiffHr = Math.floor(absDiffMin / 60);
                    const remainingMin = absDiffMin % 60;

                    let timeLabel: string;
                    if (isOverdue) {
                        timeLabel = t('azure.sync_overdue', 'Overdue');
                    } else if (absDiffMin < 1) {
                        timeLabel = t('azure.sync_next_imminent', 'Any moment');
                    } else if (absDiffHr < 1) {
                        timeLabel = `${absDiffMin}m`;
                    } else {
                        timeLabel = remainingMin > 0 ? `${absDiffHr}h ${remainingMin}m` : `${absDiffHr}h`;
                    }

                    return (
                        <p className="text-[11px] flex items-center gap-1" style={{ color: isOverdue ? '#f59e0b' : '#22c55e' }}>
                            <Clock size={10} />
                            {t('azure.sync_next', 'Next sync')}: {timeLabel}
                        </p>
                    );
                })()}
            </div>

            {/* Sync button */}
            <button
                onClick={handleSync}
                disabled={syncing || !ssoConfigured}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all"
                style={{
                    background: ssoConfigured ? '#0078D4' : 'var(--bg-tertiary)',
                    color: ssoConfigured ? '#fff' : 'var(--text-muted)',
                    opacity: syncing ? 0.7 : 1,
                    cursor: ssoConfigured ? 'pointer' : 'not-allowed',
                }}
            >
                {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {syncing ? t('azure.sync_syncing', 'Syncing...') : t('azure.sync_groups_button', 'Sync Now')}
            </button>
        </div>

        {/* Sync result or error */}
        {syncResult && (
            <div className="rounded-lg [border:1px_solid_var(--border-subtle)]">
                <div
                    className="flex items-center gap-2 px-3.5 py-2.5 cursor-pointer [background:rgba(34,197,94,0.06)]"
                    onClick={() => setShowDetails(!showDetails)}
                >
                    <CheckCircle2 size={14} className="[color:#22c55e]" />
                    <span className="text-[12px] font-medium flex-1 [color:#166534]!">
                        {t('azure.sync_groups_success', 'Sync completed')}: {syncResult.synced?.groups || 0} {t('azure.sso_group_s', 'group(s),')} {syncResult.synced?.users || 0} {t('azure.sso_new_user_s', 'new user(s)')}
                    </span>
                    {showDetails ? <ChevronUp size={13} className="text-[var(--text-muted)]" /> : <ChevronDown size={13} className="text-[var(--text-muted)]" />}
                </div>
                {showDetails && syncResult.details && (
                    <div className="px-3.5 py-2.5 text-[11px] font-mono space-y-0.5 max-h-[200px] overflow-y-auto [background:var(--bg-primary)] [color:var(--text-secondary)]! [border-top:1px_solid_var(--border-subtle)]">
                        {syncResult.details.map((d, i) => <div key={i}>{d}</div>)}
                    </div>
                )}
            </div>
        )}

        {syncError && (
            <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-lg text-[12px] [background:rgba(239,68,68,0.06)] [border:1px_solid_rgba(239,68,68,0.15)]">
                <XCircle size={14} className="mt-0.5 flex-shrink-0 [color:#ef4444]" />
                <div>
                    <p className="font-medium [color:#b91c1c]">{t('azure.sync_groups_error', 'Sync failed')}</p>
                    <p className="text-[11px] mt-0.5 text-[var(--text-secondary)]">{syncError}</p>
                </div>
            </div>
        )}

        {/* Not configured hint */}
        {!ssoConfigured && (
            <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-lg text-[12px] [background:rgba(100,116,139,0.06)] [border:1px_solid_rgba(100,116,139,0.15)]">
                <Info size={14} className="mt-0.5 flex-shrink-0 text-[var(--text-muted)]" />
                <p className="text-[var(--text-secondary)]">
                    {t('azure.sync_requires_sso', 'Configure Microsoft SSO credentials above before using group sync.')}
                </p>
            </div>
        )}

        {/* ── Sync Settings Toggles ── */}
        {ssoConfigured && (
            <div className="space-y-3 rounded-lg px-4 py-3 [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {t('azure.sync_settings', 'Sync Settings')}
                </p>

                {/* Auto-activate users */}
                <Toggle
                    checked={settings.autoActivateUsers}
                    onChange={(val) => handleSyncSetting('autoActivateUsers', val)}
                    label={t('azure.sync_auto_activate', 'Auto-activate synced users')}
                    description={t('azure.sync_auto_activate_desc', 'When enabled, new users from Azure groups are immediately active. When disabled, they require admin approval.')} />

                {/* Destructive sync */}
                <Toggle
                    checked={settings.destructiveSync}
                    onChange={(val) => handleSyncSetting('destructiveSync', val)}
                    label={t('azure.sync_destructive', 'Destructive sync')}
                    description={t('azure.sync_destructive_desc', 'Remove groups and group memberships from BeeFlow when they are no longer assigned in Azure AD.')} />
                {settings.destructiveSync && (
                    <div className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg text-[11px] ml-[48px] [background:rgba(239,68,68,0.06)] [border:1px_solid_rgba(239,68,68,0.15)]">
                        <AlertTriangle size={13} className="mt-0.5 flex-shrink-0 [color:#ef4444]" />
                        <p className="[color:#b91c1c]">
                            {t('azure.sync_destructive_warning', 'Warning: This will remove users from BeeFlow groups and delete Azure-synced groups that are no longer assigned to the enterprise app.')}
                        </p>
                    </div>
                )}

                {/* Periodic sync */}
                <Toggle
                    checked={settings.periodicSync}
                    onChange={(val) => handleSyncSetting('periodicSync', val)}
                    label={t('azure.sync_periodic', 'Automatic periodic sync')}
                    description={t('azure.sync_periodic_desc', 'Automatically sync groups from Azure AD at a regular interval.')} />
                {settings.periodicSync && (
                    <div className="flex items-center gap-2 ml-[48px]">
                        <label className="text-[11px] text-[var(--text-secondary)]">
                            {t('azure.sync_interval', 'Sync every')}
                        </label>
                        <select
                            value={settings.syncIntervalHours}
                            onChange={(e) => handleSyncSetting('syncIntervalHours', parseInt(e.target.value, 10))}
                            className="px-2 py-1 rounded-lg border text-[12px] outline-none [background:var(--bg-primary)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
                        >
                            <option value={1}>{t('azure.sso_1_hour', '1 hour')}</option>
                            <option value={3}>{t('azure.sso_3_hours', '3 hours')}</option>
                            <option value={6}>{t('azure.sso_6_hours', '6 hours')}</option>
                            <option value={12}>{t('azure.sso_12_hours', '12 hours')}</option>
                            <option value={24}>{t('azure.sso_24_hours', '24 hours')}</option>
                            <option value={48}>{t('azure.sso_48_hours', '48 hours')}</option>
                            <option value={168}>{t('azure.sso_weekly', 'Weekly')}</option>
                        </select>
                    </div>
                )}
            </div>
        )}

        {/* Azure permissions info */}
        {ssoConfigured && (
            <div className="rounded-lg px-4 py-3 space-y-1.5 [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)]">
                <p className="text-[12px] font-medium text-[var(--text-primary)]">
                    {t('azure.sync_permissions_title', 'Required Azure Permissions')}
                </p>
                <p className="text-[11px] text-[var(--text-muted)]">
                    {t('azure.sync_permissions_desc', 'The following Application permissions must be granted in Azure Portal → App registrations → API permissions, with admin consent:')}
                </p>
                <div className="flex flex-wrap gap-1.5 mt-1">
                    {['GroupMember.Read.All', 'User.Read.All', 'Application.Read.All'].map(perm => (
                        <span key={perm} className="px-2 py-0.5 rounded text-[10px] font-mono [background:rgba(0,120,212,0.08)] [color:#0078D4]! [border:1px_solid_rgba(0,120,212,0.2)]">
                            {perm}
                        </span>
                    ))}
                </div>
            </div>
        )}
    </div>;
}
