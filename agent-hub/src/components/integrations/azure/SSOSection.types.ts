import type React from 'react';

export interface GroupSyncSettings {
    destructiveSync: boolean;
    autoActivateUsers: boolean;
    periodicSync: boolean;
    syncIntervalHours: number;
}

export interface GroupSyncStatus {
    lastSyncAt?: string;
    lastSyncResult?: string;
    syncedGroups?: number;
    syncedUsers?: number;
    errors?: unknown[];
}

export interface SyncResult {
    synced?: { groups?: number; users?: number };
    details?: string[];
}

export interface SSOSectionProps {
    ssoClientId: string;
    setSsoClientId: React.Dispatch<React.SetStateAction<string>>;
    ssoClientSecret: string;
    setSsoClientSecret: React.Dispatch<React.SetStateAction<string>>;
    hasSsoClientSecret: boolean;
    ssoTenantId: string;
    setSsoTenantId: React.Dispatch<React.SetStateAction<string>>;
    autoApproveSSO: boolean;
    setAutoApproveSSO: React.Dispatch<React.SetStateAction<boolean>>;
    saving: boolean;
    saved: boolean;
    orgId: string;
    handleSave: (section: string, body: Record<string, unknown>) => void;
    groupSyncSettings: GroupSyncSettings | null;
    groupSyncStatus: GroupSyncStatus | null;
    onSyncSettingsChange: React.Dispatch<React.SetStateAction<GroupSyncSettings | null>>;
    onSyncStatusChange: React.Dispatch<React.SetStateAction<GroupSyncStatus | null>>;
}
