/** Meeting-source reads. Screens call these rather than useQuery. */

import { useQuery } from '@tanstack/react-query';

import {
    listMeetImports,
    listMeetMeetings,
    listMeetRecordings,
    listNextcloudFiles,
    listTalkMeetings,
    listTalkRecordings,
} from '../api/endpoints';
import { sourceKeys } from '../api/keys';

/*
 * Every one of these asks a third party (Nextcloud or Google) on the server's
 * side, so none of them refetches on its own: they load when their screen
 * opens and again on pull-to-refresh. A failed provider is an answer to show,
 * not a request to hammer, so no retry either.
 */
const ON_DEMAND = { retry: false, staleTime: 60_000, refetchOnWindowFocus: false } as const;

export function useTalkMeetings() {
    return useQuery({ queryKey: sourceKeys.talkMeetings, queryFn: ({ signal }) => listTalkMeetings(signal), ...ON_DEMAND });
}

export function useMeetMeetings() {
    return useQuery({ queryKey: sourceKeys.meetMeetings, queryFn: ({ signal }) => listMeetMeetings(signal), ...ON_DEMAND });
}

export function useTalkRecordings(enabled: boolean) {
    return useQuery({
        queryKey: sourceKeys.talkRecordings,
        queryFn: ({ signal }) => listTalkRecordings(signal),
        enabled,
        ...ON_DEMAND,
    });
}

export function useNextcloudFiles(folder: string, enabled: boolean) {
    return useQuery({
        queryKey: sourceKeys.nextcloudFiles(folder),
        queryFn: ({ signal }) => listNextcloudFiles(folder, signal),
        enabled: enabled && Boolean(folder),
        ...ON_DEMAND,
    });
}

export function useMeetRecordings(enabled: boolean) {
    return useQuery({
        queryKey: sourceKeys.meetRecordings,
        queryFn: ({ signal }) => listMeetRecordings(signal),
        enabled,
        ...ON_DEMAND,
    });
}

export function useMeetImports(enabled: boolean) {
    return useQuery({
        queryKey: sourceKeys.meetImports,
        queryFn: ({ signal }) => listMeetImports(signal),
        enabled,
        ...ON_DEMAND,
    });
}
