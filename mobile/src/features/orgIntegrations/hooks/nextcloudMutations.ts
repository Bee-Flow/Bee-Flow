/** Writes for Nextcloud Sync, pairing codes and the meeting-notes settings. None retries. */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { integrationKeys } from '../api/keys';
import {
    generatePairingCode,
    revokePairingCode,
    runNcSync,
    saveMeetNotes,
    saveNcSync,
    saveTalkNotes,
} from '../api/nextcloud';
import type { MeetNotesSettings, NcSyncSettings, TalkNotesSettings } from '../model/nextcloudTypes';

const keys = integrationKeys.nextcloud;

function requireOrg(orgId: string | null): string {
    if (!orgId) throw new Error('No organisation');
    return orgId;
}

/** A save that refreshes `key` before it resolves, so a form that drops its edits shows the new values. */
function useOrgSave<V>(orgId: string | null, key: readonly unknown[], save: (orgId: string, body: V) => Promise<void>) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: V) => save(requireOrg(orgId), body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
    });
}

export function useSaveNcSync(orgId: string | null) {
    return useOrgSave<NcSyncSettings>(orgId, keys.sync(orgId ?? 'none'), saveNcSync);
}

export function useSaveTalkNotes(orgId: string | null) {
    return useOrgSave<TalkNotesSettings>(orgId, keys.talk(orgId ?? 'none'), saveTalkNotes);
}

export function useSaveMeetNotes(orgId: string | null) {
    return useOrgSave<MeetNotesSettings>(orgId, keys.meet(orgId ?? 'none'), saveMeetNotes);
}

/** A full diff sync now; the status and the mirrored users are re-read after. */
export function useRunNcSync(orgId: string | null) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => runNcSync(requireOrg(orgId)),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.sync(orgId ?? 'none') }),
    });
}

export function useGeneratePairingCode() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => generatePairingCode(),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.pairing }),
    });
}

export function useRevokePairingCode() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => revokePairingCode(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.pairing }),
    });
}
