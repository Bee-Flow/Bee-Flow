/**
 * The library's reads and writes beyond the list itself: the tag vocabulary,
 * a note's tags, and the multi-meeting report.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { listTranscriptionTags, reportMeetings, setTranscriptionTags } from '../api/endpoints';
import { recordingKeys } from '../api/keys';

/** The counted chips. Re-read whenever a note's tags change. */
export function useTranscriptionTags(enabled = true) {
    return useQuery({
        queryKey: recordingKeys.tags,
        queryFn: ({ signal }) => listTranscriptionTags(signal),
        enabled,
        staleTime: 60_000,
    });
}

/** Replace a note's tags; the note, the list and the chip counts all move. */
export function useSetTags(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (tags: string[]) => setTranscriptionTags(id, tags),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: recordingKeys.detail(id) });
            void queryClient.invalidateQueries({ queryKey: recordingKeys.list });
            void queryClient.invalidateQueries({ queryKey: recordingKeys.tags });
        },
    });
}

/**
 * For a screen outside this feature that just made a note (an import): the
 * library list and its tag counts are re-read on the next look.
 */
export function useRefreshMeetings() {
    const queryClient = useQueryClient();
    return () => {
        void queryClient.invalidateQueries({ queryKey: recordingKeys.list });
        void queryClient.invalidateQueries({ queryKey: recordingKeys.tags });
    };
}

/** One question over the selected notes. Nothing is stored, so nothing is invalidated. */
export function useMeetingReport() {
    return useMutation({
        mutationFn: ({ ids, prompt }: { ids: string[]; prompt: string }) => reportMeetings(ids, prompt),
    });
}
