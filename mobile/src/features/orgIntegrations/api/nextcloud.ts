/**
 * Nextcloud Sync, pairing a new Nextcloud, and the Talk and Google Meet
 * meeting-notes settings (the web shows all four on its Nextcloud Sync page).
 *
 * Verified against:
 * - server/routes/admin/ncSync.js (mounted under /auth) — GET/PUT
 *   /auth/admin/:orgId/nc-sync (PUT `{ mode?, syncGroups?, excludedGroups?,
 *   newUserDefaultStatus? }`, .strict()), POST …/nc-sync/run, GET …/groups
 *   (502 when Nextcloud cannot be reached) and …/users. An org that is not
 *   bound to a Nextcloud answers 400.
 * - server/auth/ncBindingRoutes.js — POST /auth/admin/nc-bindings/generate-pairing-code
 *   `{}` (organizationId optional: the caller's own org), GET …/pairing-codes
 *   → `{ codes }`, DELETE …/pairing-codes/:id. Org admin or super admin.
 * - server/routes/talkNotesSettings.js and gmeetNotesSettings.js — GET/PUT
 *   /api/{talk,gmeet}-notes-settings/:orgId, .strict() bodies that REPLACE
 *   the stored document (see model/nextcloudTypes.ts). Behind the
 *   `meeting_notes` licence feature (index.js requireLicenseFeature).
 */

import { api } from '@/core/api/client';

import {
    readMeetNotes,
    readNcGroupNames,
    readNcSync,
    readNcSyncRun,
    readNcSyncUsers,
    readPairingCodes,
    readTalkNotes,
} from './nextcloudReaders';
import type {
    MeetNotesSettings,
    NcSync,
    NcSyncRun,
    NcSyncSettings,
    NcSyncUser,
    PairingCode,
    TalkNotesSettings,
} from '../model/nextcloudTypes';

const seg = encodeURIComponent;
const syncPath = (orgId: string) => `/auth/admin/${seg(orgId)}/nc-sync`;
const PAIRING = '/auth/admin/nc-bindings';

export async function getNcSync(orgId: string, signal?: AbortSignal): Promise<NcSync> {
    return readNcSync(await api.get<unknown>(syncPath(orgId), { signal }));
}

export async function saveNcSync(orgId: string, body: NcSyncSettings): Promise<void> {
    await api.put(syncPath(orgId), body);
}

export async function runNcSync(orgId: string): Promise<NcSyncRun> {
    return readNcSyncRun(await api.post<unknown>(`${syncPath(orgId)}/run`));
}

export async function getNcGroupNames(orgId: string, signal?: AbortSignal): Promise<string[]> {
    return readNcGroupNames(await api.get<unknown>(`${syncPath(orgId)}/groups`, { signal }));
}

export async function getNcSyncUsers(orgId: string, signal?: AbortSignal): Promise<NcSyncUser[]> {
    return readNcSyncUsers(await api.get<unknown>(`${syncPath(orgId)}/users`, { signal }));
}

export async function listPairingCodes(signal?: AbortSignal): Promise<PairingCode[]> {
    return readPairingCodes(await api.get<unknown>(`${PAIRING}/pairing-codes`, { signal }));
}

export async function generatePairingCode(): Promise<void> {
    await api.post(`${PAIRING}/generate-pairing-code`, {});
}

export async function revokePairingCode(id: string): Promise<void> {
    await api.delete(`${PAIRING}/pairing-codes/${seg(id)}`);
}

export async function getTalkNotes(orgId: string, signal?: AbortSignal): Promise<TalkNotesSettings> {
    return readTalkNotes(await api.get<unknown>(`/api/talk-notes-settings/${seg(orgId)}`, { signal }));
}

export async function saveTalkNotes(orgId: string, body: TalkNotesSettings): Promise<void> {
    await api.put(`/api/talk-notes-settings/${seg(orgId)}`, body);
}

export async function getMeetNotes(orgId: string, signal?: AbortSignal): Promise<MeetNotesSettings> {
    return readMeetNotes(await api.get<unknown>(`/api/gmeet-notes-settings/${seg(orgId)}`, { signal }));
}

export async function saveMeetNotes(orgId: string, body: MeetNotesSettings): Promise<void> {
    await api.put(`/api/gmeet-notes-settings/${seg(orgId)}`, body);
}
