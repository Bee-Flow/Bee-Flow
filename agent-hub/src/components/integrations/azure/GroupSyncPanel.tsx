import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Info } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import GroupSyncBlock from './GroupSyncBlock';
import type { GroupSyncSettings, GroupSyncStatus } from './groupSync.types';
import { panelOrgId } from '@/utils/adminAccess';
import { apiRequest } from '@/api/typedRequest';
import { SettingsGroup } from '@/components/shared/SettingsList';
import LoadingState from '@/components/shared/LoadingState';
import { ALERT_ERROR, ALERT_INFO } from '@/components/shared/adminUi';

interface GroupSyncPanelProps {
    user?: { organizationId?: string } | null;
    /** The organisation to act on; left out, the user's home organisation (outside the admin dashboard). */
    orgId?: string | null;
}

/** What GET /api/org-azure-config/:orgId/sync-groups/status answers (server/usecases/orgAzureSyncView.js). */
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
 * An organisation's own Entra ID group sync (last run, "Sync now", the sync
 * settings): a card of the Microsoft 365 page (Microsoft365Panel), and on its
 * own the Settings tab of an organisation admin. Its read answers whether a
 * directory is connected but none of the connection's values; the connection
 * itself is the platform admin's (the Microsoft sign-in app and the directory
 * binding of MicrosoftIdentityPanel).
 */
export default function GroupSyncPanel({ user, orgId: orgIdProp }: GroupSyncPanelProps) {
    const { t } = useTranslation();
    const orgId = panelOrgId(orgIdProp, user) || '';
    const query = useQuery({ queryKey: ['org-group-sync', orgId], queryFn: () => readGroupSync(orgId), enabled: !!orgId });
    // What a run or a settings save changed since the read; the read fills the rest.
    const [settings, setSettings] = useState<GroupSyncSettings | null>(null);
    const [status, setStatus] = useState<GroupSyncStatus | null>(null);

    return (
        <SettingsGroup
            title={t('azure.sync_groups_title', 'Microsoft Entra ID group sync')}
            description={t('azure.sync_groups_desc', 'Automatically sync the groups and users assigned to your Entra ID enterprise app to Bee Flow.')}
        >
            {!orgId ? (
                <p className={ALERT_INFO}>{t('azure.no_org_message')}</p>
            ) : (
                <>
                    <p className="m-0 flex items-start gap-2 text-xs text-[var(--text-tertiary)]">
                        <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                        {t('azure.group_sync_platform_managed', 'The directory connection itself is managed by the platform administrator.')}
                    </p>
                    <LoadingState
                        loading={query.isPending}
                        error={query.isError ? query.error : null}
                        errorFallback={(err) => (
                            <p role="alert" className={ALERT_ERROR}>
                                <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                                {errorMessage(err)}
                            </p>
                        )}
                    >
                        {query.data && (
                            <GroupSyncBlock
                                orgId={orgId}
                                connected={query.data.directoryConfigured}
                                groupSyncSettings={settings ?? query.data.settings}
                                groupSyncStatus={status ?? query.data.status}
                                onSyncSettingsChange={setSettings}
                                onSyncStatusChange={setStatus}
                                notConnectedHint={t('azure.group_sync_not_connected', 'The platform administrator has not connected a directory to this organisation yet, so there is nothing to sync.')}
                            />
                        )}
                    </LoadingState>
                </>
            )}
        </SettingsGroup>
    );
}
