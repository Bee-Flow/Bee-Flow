/** Contract readers for Nextcloud Sync, pairing codes and the meeting-notes settings. */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import {
    NC_DEFAULT_STATUSES,
    NC_SYNC_MODES,
    type MeetNotesSettings,
    type NcSync,
    type NcSyncRun,
    type NcSyncUser,
    type PairingCode,
    type TalkNotesSettings,
} from '../model/nextcloudTypes';

export const readNcSync: (raw: unknown) => NcSync = shapeOf({
    ncBaseUrl: field.strOrNull,
    mode: field.oneOf(NC_SYNC_MODES, 'mirror_all'),
    syncGroups: field.strArray,
    excludedGroups: field.strArray,
    newUserDefaultStatus: field.oneOf(NC_DEFAULT_STATUSES, 'active'),
    lastSyncAt: field.strOrNull,
});

/** `{ groups }`: Nextcloud group names. */
export const readNcGroupNames = (raw: unknown): string[] => field.strArray(pick(raw, 'groups')).filter(Boolean);

const readUserRows = shapeListOf({
    id: field.str(''),
    email: field.strOrNull,
    displayName: field.str(''),
    status: field.str(''),
});

export const readNcSyncUsers = (raw: unknown): NcSyncUser[] => readUserRows(pick(raw, 'users')).filter((u) => u.id);

export const readNcSyncRun: (raw: unknown) => NcSyncRun = shapeOf({
    created: field.num(0),
    deactivated: field.num(0),
    skipped: field.strOrNull,
    error: field.strOrNull,
});

const readCodeRows = shapeListOf({ id: field.str(''), code: field.str(''), expiresAt: field.strOrNull });

export const readPairingCodes = (raw: unknown): PairingCode[] => readCodeRows(pick(raw, 'codes')).filter((c) => c.id);

/** true, false or null ("no opinion"); anything else reads as no opinion. */
const boolOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** The Meet lists refuse an empty id (`legacyList`), so only real ones go back. */
const ids = (value: unknown): string[] => field.strArray(value).filter(Boolean);

export const readTalkNotes: (raw: unknown) => TalkNotesSettings = shapeOf({
    autoTranscribe: boolOrNull,
    postSummaryBack: boolOrNull,
    recordingFolder: field.strOrNull,
    language: field.strOrNull,
    autoRecord: boolOrNull,
    autoRecordScope: field.oneOfOrNull(['calendar', 'all'] as const),
    recordingMode: field.oneOfOrNull(['audio', 'video'] as const),
    insightsPerPersonStats: field.bool(true),
    defaultOwnerUserId: field.strOrNull,
    excludedEventUids: list,
    excludedRoomTokens: list,
});

export const readMeetNotes: (raw: unknown) => MeetNotesSettings = shapeOf({
    autoImport: boolOrNull,
    autoRecordConfig: boolOrNull,
    importScope: field.oneOfOrNull(['organizer', 'calendar'] as const),
    language: field.strOrNull,
    lookbackHours: field.numOrNull,
    excludedEventIds: ids,
    excludedMeetingCodes: ids,
});
