import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { GroupSyncSettings, GroupSyncStatus, SyncResult } from './SSOSection.types';
import { SSOSectionSection } from './SSOSectionSection';
import { apiFetch } from '@/api/typedRequest';

export interface GroupSyncBlockProps {
    orgId: string;
    /** Whether a directory is connected: the run and the settings are offered only then. */
    connected: boolean;
    groupSyncSettings: GroupSyncSettings | null;
    groupSyncStatus: GroupSyncStatus | null;
    onSyncSettingsChange: React.Dispatch<React.SetStateAction<GroupSyncSettings | null>>;
    onSyncStatusChange: React.Dispatch<React.SetStateAction<GroupSyncStatus | null>>;
    /** The line shown while no directory is connected (default: configure the SSO credentials above). */
    notConnectedHint?: string;
}

/**
 * The Azure AD group sync of one organisation: its last run, "Sync now" and
 * the sync settings, over the organisation-scoped routes
 * (POST /api/org-azure-config/:orgId/sync-groups, PUT …/sync-groups/settings).
 * Drawn inside the Microsoft SSO section of the Azure panel and on its own in
 * GroupSyncPanel.
 */
export default function GroupSyncBlock({ orgId, connected, groupSyncSettings, groupSyncStatus, onSyncSettingsChange, onSyncStatusChange, notConnectedHint }: GroupSyncBlockProps) {
    const { t } = useTranslation();
    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
    const [syncError, setSyncError] = useState<string | null>(null);
    const [showDetails, setShowDetails] = useState(false);
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
        try {
            const res = await apiFetch('PUT /api/org-azure-config/{orgId}/sync-groups/settings', { params: { orgId }, body: { [key]: value } });
            const data = await res.json();
            if (data.ok) onSyncSettingsChange(data.settings);
        } catch (err) {
            console.error('Failed to update sync setting:', err);
        }
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
        <SSOSectionSection t={t} status={status} formatTimeAgo={formatTimeAgo} settings={settings} handleSync={handleSync} syncing={syncing} ssoConfigured={connected} syncResult={syncResult} setShowDetails={setShowDetails} showDetails={showDetails} syncError={syncError} handleSyncSetting={handleSyncSetting} notConnectedHint={notConnectedHint} />
    );
}
