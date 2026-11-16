import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import { ALERT_ERROR } from '@/components/shared/adminUi';
import type { GroupSyncSettings, GroupSyncStatus, SyncResult } from './groupSync.types';
import { GroupSyncSection } from './GroupSyncSection';
import { apiFetch } from '@/api/typedRequest';

export interface GroupSyncBlockProps {
    orgId: string;
    /** Whether a directory is connected: the run and the settings are offered only then. */
    connected: boolean;
    groupSyncSettings: GroupSyncSettings | null;
    groupSyncStatus: GroupSyncStatus | null;
    onSyncSettingsChange: React.Dispatch<React.SetStateAction<GroupSyncSettings | null>>;
    onSyncStatusChange: React.Dispatch<React.SetStateAction<GroupSyncStatus | null>>;
    /** The line shown while no directory is connected. */
    notConnectedHint: string;
}

const DEFAULT_SETTINGS: GroupSyncSettings = {
    destructiveSync: false,
    autoActivateUsers: true,
    periodicSync: false,
    syncIntervalHours: 6,
};

/**
 * The Entra ID group sync of one organisation: its last run, "Sync now" and
 * the sync settings, over the organisation-scoped routes
 * (POST /api/org-azure-config/:orgId/sync-groups, PUT …/sync-groups/settings).
 * A settings switch saves at once; a refused save says so.
 */
export default function GroupSyncBlock({ orgId, connected, groupSyncSettings, groupSyncStatus, onSyncSettingsChange, onSyncStatusChange, notConnectedHint }: GroupSyncBlockProps) {
    const { t } = useTranslation();
    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
    const [syncError, setSyncError] = useState<string | null>(null);
    const [settingError, setSettingError] = useState<string | null>(null);
    const settings = groupSyncSettings || DEFAULT_SETTINGS;
    const status = groupSyncStatus || {};

    const handleSync = async () => {
        if (!orgId || syncing) return;
        setSyncing(true);
        setSyncResult(null);
        setSyncError(null);
        try {
            const res = await apiFetch('POST /api/org-azure-config/{orgId}/sync-groups', { params: { orgId }, init: { headers: { 'Content-Type': 'application/json' } } });
            const data = await res.json();
            if (data.ok) {
                setSyncResult(data);
                onSyncStatusChange({
                    lastSyncAt: new Date().toISOString(),
                    lastSyncResult: data.errors?.length > 0 ? 'partial' : 'success',
                    syncedGroups: data.synced?.groups || 0,
                    syncedUsers: data.synced?.users || 0,
                    errors: data.errors || [],
                });
            } else {
                setSyncError(data.error || t('azure.sync_groups_error', 'Sync failed'));
            }
        } catch (err) {
            setSyncError(errorMessage(err) ?? t('azure.sync_groups_error', 'Sync failed'));
        }
        setSyncing(false);
    };

    const handleSyncSetting = async (key: keyof GroupSyncSettings, value: number | boolean) => {
        if (!orgId) return;
        setSettingError(null);
        try {
            const res = await apiFetch('PUT /api/org-azure-config/{orgId}/sync-groups/settings', { params: { orgId }, body: { [key]: value } });
            const data = await res.json();
            if (data.ok) onSyncSettingsChange(data.settings);
            else setSettingError(data.error || t('common.save_failed', 'Save failed'));
        } catch (err) {
            setSettingError(errorMessage(err) ?? t('common.save_failed', 'Save failed'));
        }
    };

    return (
        <div className="flex flex-col gap-3">
            <GroupSyncSection
                status={status}
                settings={settings}
                onSync={handleSync}
                syncing={syncing}
                connected={connected}
                syncResult={syncResult}
                syncError={syncError}
                onSetting={handleSyncSetting}
                notConnectedHint={notConnectedHint}
            />
            {settingError && <p role="alert" className={ALERT_ERROR}>{settingError}</p>}
        </div>
    );
}
