/** Meeting-notes queries. Screens call these rather than useQuery. */

import { useQuery } from '@tanstack/react-query';

import { ApiError } from '@/core/api/client';

import { forgetMeetingAudio, getTranscription, listTranscriptions } from '../api/endpoints';
import { recordingKeys } from '../api/keys';

/**
 * How often to re-read a note while the server is still working on it.
 *
 * The pipeline takes minutes on a long meeting and there is nothing to stream,
 * so this is a poll — but a poll on a phone is a battery cost, so it is only
 * ever active while at least one note is 'processing'. React Query pauses it
 * when the app is backgrounded (focusManager is bridged to AppState at the
 * root), which is exactly the behaviour we want.
 */
export const PROCESSING_POLL_MS = 12_000;

export function useTranscriptions() {
    return useQuery({
        queryKey: recordingKeys.list,
        queryFn: ({ signal }) => listTranscriptions(signal),
        // Poll only while the server still owes us something: the upload
        // answers 202 and finishes in the background, so this is the only way
        // a note ever turns from 'processing' into a transcript.
        refetchInterval: (q) =>
            (q.state.data ?? []).some((item) => item.status === 'processing') ? PROCESSING_POLL_MS : false,
    });
}

export function useTranscription(id: string) {
    return useQuery({
        queryKey: recordingKeys.detail(id),
        queryFn: async ({ signal }) => {
            try {
                return await getTranscription(id, signal);
            } catch (err) {
                // Gone, or no longer shared with us: a copy of its recording
                // left in the cache must not outlive that access.
                if (err instanceof ApiError && err.status === 404) forgetMeetingAudio(id);
                throw err;
            }
        },
        enabled: Boolean(id),
        // Same reasoning as the list, and only while this note is processing.
        refetchInterval: (q) => (q.state.data?.status === 'processing' ? PROCESSING_POLL_MS : false),
    });
}
