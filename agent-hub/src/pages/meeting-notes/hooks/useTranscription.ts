import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '@/api/transcriptionsApi';
import type { MeetingNote } from '../detail/meetingDetailTypes';

/** A new note, or a function of the current one (the callers only run once a note has loaded). */
type LocalUpdate = MeetingNote | ((prev: MeetingNote) => MeetingNote);

const noteKey = (id: string | null | undefined) => ['meetingNotes', 'note', id ?? null] as const;

export default function useTranscription(id: string | null | undefined) {
    const queryClient = useQueryClient();
    // One answer per note, and nothing kept for a note left behind: selecting
    // another note shows no frame of the previous one. Every action in the
    // detail view (rename, delete, action items) targets the note in `data`, so
    // a note that then failed to load must not leave the old one on screen while
    // the library highlights the new one — a user who trusted the highlight and
    // pressed Delete would destroy a different meeting.
    //
    // While the note is still transcribing (async pipeline) it is read again every
    // 4 s, so the detail view fills in transcript/speakers/summary the moment
    // processing finishes.
    const query = useQuery<MeetingNote>({
        queryKey: noteKey(id),
        enabled: !!id,
        staleTime: 0,
        gcTime: 0,
        retry: false,
        refetchInterval: (q) => ((q.state.data as MeetingNote | undefined)?.status === 'processing' ? 4000 : false),
        refetchIntervalInBackground: true,
        queryFn: () => api.getTranscription(id as string),
    });

    const { refetch } = query;
    const refresh = useCallback(async () => {
        if (!id) return;
        await refetch();
    }, [id, refetch]);

    // Bound to the note it was handed out for. The library keeps one detail view
    // while the user moves from note to note, so a write that started on note A
    // (regenerate, a PATCH echo, a speaker update) can answer after B has loaded.
    // The handler that awaited it still holds A's setLocal, which writes into A's
    // own cached read: it never shows A's summary and action items under B's id,
    // and the next checkbox on B cannot PATCH A's full list over B's.
    const setLocal = useCallback((updater: LocalUpdate) => {
        // A function updater has nothing to edit until the note has loaded:
        // spreading nothing would build a half-filled note.
        queryClient.setQueryData<MeetingNote>(noteKey(id), (prev) => {
            if (typeof updater !== 'function') return updater;
            return prev ? updater(prev) : prev;
        });
    }, [queryClient, id]);

    return {
        data: query.data ?? null,
        loading: !!id && query.isPending,
        // The caught value as it was thrown. TODO(err-unknown): MeetingDetail.jsx hands it to
        // MeetingLoadError, which still reads it as an ApiError; read it with the caughtError helpers there.
        error: query.error as unknown,
        refresh,
        setLocal,
    };
}
