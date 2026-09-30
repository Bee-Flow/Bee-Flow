/**
 * Nextcloud Sync and the meeting-notes settings beside it on the web's
 * Nextcloud Sync page, as the server serialises them. Each names its route.
 */

export const NC_SYNC_MODES = ['mirror_all', 'selective_groups', 'manual'] as const;
export type NcSyncMode = (typeof NC_SYNC_MODES)[number];

export const NC_DEFAULT_STATUSES = ['active', 'pending'] as const;
export type NcDefaultStatus = (typeof NC_DEFAULT_STATUSES)[number];

/** The editable part of `GET /auth/admin/:orgId/nc-sync`, and the PUT body. */
export interface NcSyncSettings {
    mode: NcSyncMode;
    syncGroups: string[];
    excludedGroups: string[];
    newUserDefaultStatus: NcDefaultStatus;
}

/** `GET /auth/admin/:orgId/nc-sync` (routes/admin/ncSync.js). */
export interface NcSync extends NcSyncSettings {
    ncBaseUrl: string | null;
    lastSyncAt: string | null;
}

/** A mirrored account (`…/nc-sync/users`). */
export interface NcSyncUser {
    id: string;
    email: string | null;
    displayName: string;
    status: string;
}

/** `POST …/nc-sync/run` (services/ncUserGroupSync.js runFullSync). */
export interface NcSyncRun {
    created: number;
    deactivated: number;
    /** Set when the run did nothing: 'manual_mode'. */
    skipped: string | null;
    error: string | null;
}

/** An outstanding pairing code (auth/ncBindingRoutes.js). A bearer credential: admins only. */
export interface PairingCode {
    id: string;
    code: string;
    expiresAt: string | null;
}

/**
 * `GET|PUT /api/talk-notes-settings/:orgId` (routes/talkNotesSettings.js,
 * core/meetingNotes/talkNotesSettings.js). The save REPLACES the stored
 * document, so every field goes back as read; `null` is "no opinion — each
 * member decides", and is kept rather than turned into false.
 */
export interface TalkNotesSettings {
    autoTranscribe: boolean | null;
    postSummaryBack: boolean | null;
    recordingFolder: string | null;
    language: string | null;
    autoRecord: boolean | null;
    autoRecordScope: 'calendar' | 'all' | null;
    recordingMode: 'audio' | 'video' | null;
    insightsPerPersonStats: boolean;
    defaultOwnerUserId: string | null;
    /** Legacy lists, round-tripped for a rollback. */
    excludedEventUids: unknown[];
    excludedRoomTokens: unknown[];
}

/** `GET|PUT /api/gmeet-notes-settings/:orgId` (routes/gmeetNotesSettings.js). Replaced whole, like Talk's. */
export interface MeetNotesSettings {
    autoImport: boolean | null;
    autoRecordConfig: boolean | null;
    importScope: 'organizer' | 'calendar' | null;
    language: string | null;
    lookbackHours: number | null;
    excludedEventIds: string[];
    excludedMeetingCodes: string[];
}
