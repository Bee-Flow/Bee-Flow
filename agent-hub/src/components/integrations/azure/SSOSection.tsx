import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { TranslateParams, useTranslation } from '@/hooks/useTranslation';
import { API_BASE, authFetch } from '@/utils/helpers';
import { Input, Toggle, SectionCard, StatusBadge } from './components';
import type { SyncResult, SSOSectionProps } from './SSOSection.types';
import { SSOSectionSection } from './SSOSectionSection';

export default function SSOSection({ ssoClientId, setSsoClientId, ssoClientSecret, setSsoClientSecret, hasSsoClientSecret, ssoTenantId, setSsoTenantId, autoApproveSSO, setAutoApproveSSO, handleSave, saving, saved, orgId, groupSyncSettings, groupSyncStatus, onSyncSettingsChange, onSyncStatusChange }: SSOSectionProps) {
    const { t } = useTranslation();
    const ssoConfigured = !!(ssoClientId && hasSsoClientSecret);

    // ── Group Sync local state ──
    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
    const [syncError, setSyncError] = useState<string | null>(null);
    const [showDetails, setShowDetails] = useState(false);
    const [savingSettings, setSavingSettings] = useState(false);
    const settings = groupSyncSettings || {
        destructiveSync: false,
        autoActivateUsers: true,
        periodicSync: false,
        syncIntervalHours: 6,
    };
    const status = groupSyncStatus || {};

    // ── Sync trigger ──
    const handleSync = async () => {
        if (!orgId || syncing) return;
        setSyncing(true);
        setSyncResult(null);
        setSyncError(null);
        try {
            const res = await authFetch(`${API_BASE}/api/org-azure-config/${orgId}/sync-groups`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            const data = await res.json();
            if (data.ok) {
                setSyncResult(data);
                if (onSyncStatusChange) {
                    onSyncStatusChange({
                        lastSyncAt: new Date().toISOString(),
                        lastSyncResult: data.errors?.length > 0 ? 'partial' : 'success',
                        syncedGroups: data.synced?.groups || 0,
                        syncedUsers: data.synced?.users || 0,
                        errors: data.errors || [],
                    });
                }
            } else {
                setSyncError(data.error || 'Sync failed');
            }
        } catch (err) {
            setSyncError((err as Error).message);
        }
        setSyncing(false);
    };

    // ── Save sync setting ──
    const handleSyncSetting = async (key: string, value: number | boolean) => {
        if (!orgId) return;
        setSavingSettings(true);
        try {
            const res = await authFetch(`${API_BASE}/api/org-azure-config/${orgId}/sync-groups/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: value }),
            });
            const data = await res.json();
            if (data.ok && onSyncSettingsChange) {
                onSyncSettingsChange(data.settings);
            }
        } catch (err) {
            console.error('Failed to update sync setting:', err);
        }
        setSavingSettings(false);
    };

    // ── Format relative time ──
    const formatTimeAgo = (isoString: string | number | Date) => {
        if (!isoString) return 'Never';
        const dt = new Date(isoString);
        const now = new Date();
        const diffMs = now.getTime() - dt.getTime();
        const diffMin = Math.floor(diffMs / 60000);
        const diffHr = Math.floor(diffMin / 60);
        const diffDay = Math.floor(diffHr / 24);
        if (diffMin < 1) return 'Just now';
        if (diffMin < 60) return `${diffMin}m ago`;
        if (diffHr < 24) return `${diffHr}h ago`;
        return `${diffDay}d ago`;
    };

    return (
        <SectionCard
            title={t('azure.sso_title')}
            description={t('azure.sso_section_desc')}
            onSave={() => handleSave('sso', { ssoClientId, ssoClientSecret: ssoClientSecret || undefined, ssoTenantId, autoApproveSSO })}
            saving={saving}
            saved={saved}
        >
            {/* Status overview */}
            <div className="flex items-center gap-3 px-4 py-3 rounded-lg [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center text-lg [background:rgba(0,164,239,0.15)]">
                    🪟
                </div>
                <div className="flex-1">
                    <p className="text-[13px] font-medium text-[var(--text-primary)]">{t('azure.sso_status')}</p>
                    <p className="text-[11px] text-[var(--text-muted)]">
                        {ssoConfigured ? t('azure.sso_configured_desc') : t('azure.sso_not_configured_desc')}
                    </p>
                </div>
                <StatusBadge configured={ssoConfigured} />
            </div>

            {/* Warning: Impact of misconfiguration */}
            <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-lg text-[12px] [background:rgba(239,68,68,0.06)] [border:1px_solid_rgba(239,68,68,0.15)]">
                <AlertTriangle size={15} className="mt-0.5 flex-shrink-0 [color:#ef4444]" />
                <div className="[color:#b91c1c]">
                    <p className="font-semibold mb-1">{t('azure.sso_warning_title')}</p>
                    <ul className="space-y-0.5 text-[11px] text-[var(--text-secondary)]">
                        <li>• {t('azure.sso_warning_client')}</li>
                        <li>• {t('azure.sso_warning_tenant')}</li>
                        <li>• {t('azure.sso_warning_remove')}</li>
                    </ul>
                </div>
            </div>

            {/* Credentials */}
            <Input
                label={t('azure.sso_client_id')}
                value={ssoClientId}
                onChange={setSsoClientId}
                placeholder={t('azure.sso_xxxxxxxx_xxxx_xxxx_xxxx_xxxxxxxxxxxx', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')}
                helpText={t('azure.sso_client_id_help')}
            />
            <Input
                label={t('azure.sso_client_secret')}
                type="password"
                value={ssoClientSecret}
                onChange={setSsoClientSecret}
                placeholder={hasSsoClientSecret ? '••••••••••••' : 'Enter client secret value'}
                helpText={hasSsoClientSecret ? t('azure.sso_client_secret_help_set') : t('azure.sso_client_secret_help_empty')}
            />

            {/* Tenant ID */}
            <SSOSectionSection2 t={t} ssoTenantId={ssoTenantId} setSsoTenantId={setSsoTenantId} />

            {/* Warning: Tenant ID = common */}
            {(ssoTenantId === 'common' || ssoTenantId === '') && (
                <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-lg text-[12px] [background:rgba(245,158,11,0.06)] [border:1px_solid_rgba(245,158,11,0.2)]">
                    <AlertTriangle size={15} className="mt-0.5 flex-shrink-0 [color:#f59e0b]" />
                    <div className="[color:#92400e]">
                        <p className="font-semibold mb-0.5">{t('azure.sso_tenant_common_title')}</p>
                        <p className="text-[11px] text-[var(--text-secondary)]">
                            {t('azure.sso_tenant_common_desc')}
                        </p>
                    </div>
                </div>
            )}

            <div className="h-px my-1 bg-[var(--border-subtle)]" />

            {/* Auto-approve toggle */}
            <div className="space-y-2">
                <Toggle
                    checked={autoApproveSSO}
                    onChange={setAutoApproveSSO}
                    label={t('azure.sso_auto_approve')}
                    description={t('azure.sso_auto_approve_desc')}
                />
                {autoApproveSSO && (
                    <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-lg text-[12px] ml-[48px] [background:rgba(245,158,11,0.06)] [border:1px_solid_rgba(245,158,11,0.2)]">
                        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 [color:#f59e0b]" />
                        <p className="[color:#92400e]">{t('azure.sso_auto_approve_warning')}</p>
                    </div>
                )}
            </div>

            <div className="h-px my-1 bg-[var(--border-subtle)]" />

            {/* ═══════════════ AZURE AD GROUP SYNC ═══════════════ */}
            <SSOSectionSection t={t} status={status} formatTimeAgo={formatTimeAgo} settings={settings} handleSync={handleSync} syncing={syncing} ssoConfigured={ssoConfigured} syncResult={syncResult} setShowDetails={setShowDetails} showDetails={showDetails} syncError={syncError} handleSyncSetting={handleSyncSetting} />

            <div className="h-px my-1 bg-[var(--border-subtle)]" />

            {/* Setup guide */}
            <div className="rounded-lg px-4 py-3 space-y-1.5 [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)]">
                <p className="text-[12px] font-medium text-[var(--text-primary)]">{t('azure.sso_setup_guide')}</p>
                <ol className="text-[11px] space-y-1 list-decimal list-inside text-[var(--text-muted)]">
                    <li>{t('azure.sso_step_1')} <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener noreferrer" className="underline [color:#0078D4]">{t('azure.sso_azure_portal_app_registrations', 'Azure Portal → App registrations')}</a></li>
                    <li>{t('azure.sso_step_2')}</li>
                    <li>{t('azure.sso_under', 'Under')} <strong>{t('azure.sso_authentication', 'Authentication')}</strong>{t('azure.sso_add_a_redirect_uri', ', add a redirect URI:')} <code className="[background:var(--bg-tertiary)] [padding:1px_4px] [border-radius:3px] [font-size:10px]">https://your-domain/auth/callback/microsoft</code></li>
                    <li>{t('azure.sso_step_4')}</li>
                    <li>{t('azure.sso_step_5')}</li>
                    <li>{t('azure.sso_step_6', 'Under API permissions, add Application permissions: GroupMember.Read.All, User.Read.All, Application.Read.All and grant admin consent')}</li>
                </ol>
            </div>
        </SectionCard>
    );
}

function SSOSectionSection2({ t, ssoTenantId, setSsoTenantId }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; ssoTenantId: string; setSsoTenantId: React.Dispatch<React.SetStateAction<string>>; }) {
    return <div className="space-y-1.5">
        <label className="block text-[12px] font-medium text-[var(--text-secondary)]">
            {t('azure.sso_tenant_id')}
        </label>
        <input
            type="text"
            value={ssoTenantId}
            onChange={e => setSsoTenantId(e.target.value)}
            placeholder={t('azure.sso_your_tenant_guid_or_common', 'your-tenant-guid or common')}
            className="w-full px-3 py-2 rounded-lg border outline-none text-[13px] transition-colors focus:ring-2 focus:ring-blue-500/20 [background:var(--bg-primary)] [border-color:var(--border-default)] [color:var(--text-primary)]!" />
        <p className="text-[11px] text-[var(--text-muted)]">
            {t('azure.sso_tenant_help').replace('{code}', '')}
            <code className="[background:var(--bg-tertiary)] [padding:1px_4px] [border-radius:3px]">common</code>
            {' '}{t('azure.sso_tenant_help').split('{code}')[1] || ''}
        </p>
    </div>;
}

