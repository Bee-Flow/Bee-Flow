import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import GroupSyncBlock from './GroupSyncBlock';
import type { GroupSyncSettings, GroupSyncStatus } from './SSOSection.types';
import { panelOrgId } from '@/utils/adminAccess';
import { apiRequest } from '@/api/typedRequest';

interface GroupSyncPanelProps {
    user?: { organizationId?: string } | null;
    /** The organisation to act on; left out, the user's home organisation (outside the admin dashboard). */
    orgId?: string | null;
}

/** What GET /api/org-azure-config/:orgId/sync-groups/status answers (server/routes/orgAzureSyncView.js). */
interface GroupSyncRead {
    directoryConfigured: boolean;
    status: GroupSyncStatus | null;
    settings: GroupSyncSettings | null;
}

async function readGroupSync(orgId: string): Promise<GroupSyncRead> {
    const res = await apiRequest('GET /api/org-azure-config/{orgId}/sync-groups/status', { params: { orgId } });
    const d = await res.json();
    return { directoryConfigured: d?.directoryConfigured === true, status: d?.status || null, settings: d?.settings || null };
}

/**
 * Settings > Organisation > Group sync, for an organisation admin who is not
 * the platform admin: the organisation's own Azure AD group sync (last run,
 * "Sync now", the sync settings). Its read answers whether a directory is
 * connected but none of the connection's values; the connection itself is the
 * platform admin's, in the full Azure panel.
 */
export default function GroupSyncPanel({ user, orgId: orgIdProp }: GroupSyncPanelProps) {
    const { t } = useTranslation();
    const orgId = panelOrgId(orgIdProp, user) || '';
    const query = useQuery({ queryKey: ['org-group-sync', orgId], queryFn: () => readGroupSync(orgId), enabled: !!orgId });
    // What a run or a settings save changed since the read; the read fills the rest.
    const [settings, setSettings] = useState<GroupSyncSettings | null>(null);
    const [status, setStatus] = useState<GroupSyncStatus | null>(null);

    if (!orgId) {
        return (
            <div className="rounded-xl px-5 py-4 [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)]">
                <p className="text-[13px] text-[var(--text-muted)]">{t('azure.no_org_message')}</p>
            </div>
        );
    }

    if (query.isPending) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 size={24} className="animate-spin text-[var(--text-muted)]" />
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div>
                <p className="text-[11px] font-semibold uppercase tracking-widest mb-2 text-[var(--text-muted)]">
                    {t('azure.group_sync_nav', 'Group sync')}
                </p>
                <p className="flex items-start gap-2 text-[12px] mb-4 text-[var(--text-muted)]">
                    <Info size={14} className="mt-0.5 flex-shrink-0" />
                    {t('azure.group_sync_platform_managed', 'The directory connection itself is managed by the platform administrator.')}
                </p>
            </div>

            {query.isError ? (
                <div role="alert" className="flex items-center gap-2 px-4 py-3 rounded-lg text-[12px] [background:rgba(239,68,68,0.08)] [color:#ef4444]! [border:1px_solid_rgba(239,68,68,0.2)]">
                    <AlertTriangle size={14} />
                    {errorMessage(query.error)}
                </div>
            ) : (
                <div className="rounded-xl px-6 py-5 [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)]">
                    <GroupSyncBlock
                        orgId={orgId}
                        connected={query.data.directoryConfigured}
                        groupSyncSettings={settings ?? query.data.settings}
                        groupSyncStatus={status ?? query.data.status}
                        onSyncSettingsChange={setSettings}
                        onSyncStatusChange={setStatus}
                        notConnectedHint={t('azure.group_sync_not_connected', 'The platform administrator has not connected a directory to this organisation yet, so there is nothing to sync.')}
                    />
                </div>
            )}
        </div>
    );
}
