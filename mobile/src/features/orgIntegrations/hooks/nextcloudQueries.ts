/** Reads for Nextcloud Sync, pairing codes and the meeting-notes settings. Admins only (the screens decide). */

import { useQuery } from '@tanstack/react-query';

import { integrationKeys } from '../api/keys';
import { getMeetNotes, getNcGroupNames, getNcSync, getNcSyncUsers, getTalkNotes, listPairingCodes } from '../api/nextcloud';

const keys = integrationKeys.nextcloud;

function orgQuery<T>(key: readonly unknown[], orgId: string | null, read: (orgId: string, signal: AbortSignal) => Promise<T>) {
    return { queryKey: key, queryFn: ({ signal }: { signal: AbortSignal }) => read(orgId as string, signal), enabled: Boolean(orgId), retry: false } as const;
}

export function useNcSync(orgId: string | null) {
    return useQuery(orgQuery(keys.sync(orgId ?? 'none'), orgId, getNcSync));
}

/** Asks Nextcloud itself: a 502 here means it could not be reached. */
export function useNcGroupNames(orgId: string | null) {
    return useQuery(orgQuery(keys.groups(orgId ?? 'none'), orgId, getNcGroupNames));
}

export function useNcSyncUsers(orgId: string | null) {
    return useQuery(orgQuery(keys.users(orgId ?? 'none'), orgId, getNcSyncUsers));
}

export function usePairingCodes(enabled: boolean) {
    return useQuery({ queryKey: keys.pairing, queryFn: ({ signal }) => listPairingCodes(signal), enabled, retry: false });
}

export function useTalkNotes(orgId: string | null) {
    return useQuery(orgQuery(keys.talk(orgId ?? 'none'), orgId, getTalkNotes));
}

export function useMeetNotes(orgId: string | null) {
    return useQuery(orgQuery(keys.meet(orgId ?? 'none'), orgId, getMeetNotes));
}
