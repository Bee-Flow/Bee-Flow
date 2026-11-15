// The shapes of an organisation's Entra ID group sync as the
// organisation-scoped routes answer them (server/routes/orgAzureConfig.js,
// usecases/orgAzureSyncView.js).

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
    /** GET …/sync-groups/status answers the number of errors of the last run, not their text. */
    errorCount?: number;
}

export interface SyncResult {
    synced?: { groups?: number; users?: number };
    details?: string[];
}
