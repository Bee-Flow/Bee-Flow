import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { meetingNotesKey, useTranscriptionsQuery } from '../../../api/queries/meetingLibrary';
import type { MeetingNote, MeetingRowPatch } from '../detail/meetingDetailTypes';

const NO_NOTES: MeetingNote[] = [];

/**
 * The library's notes. The list re-reads itself while any note is still
 * transcribing (see useTranscriptionsQuery); `reload` is the explicit re-read
 * that shows the spinner, and the *Local functions edit the cached list in
 * place (rename, delete, a note that was just created).
 */
export default function useTranscriptions() {
    const queryClient = useQueryClient();
    const query = useTranscriptionsQuery();
    const { refetch } = query;
    const [reloading, setReloading] = useState(false);

    const reload = useCallback(async () => {
        setReloading(true);
        try { await refetch(); } finally { setReloading(false); }
    }, [refetch]);

    const edit = useCallback((update: (prev: MeetingNote[]) => MeetingNote[]) => {
        queryClient.setQueryData<MeetingNote[]>(meetingNotesKey, (prev) => update(prev ?? NO_NOTES));
    }, [queryClient]);

    const removeLocal = useCallback((id: string) => {
        edit((prev) => prev.filter((t) => t.id !== id));
    }, [edit]);

    const patchLocal = useCallback((id: string, patch: MeetingRowPatch) => {
        edit((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    }, [edit]);

    const upsertLocal = useCallback((item: MeetingNote | null | undefined) => {
        if (!item || !item.id) return;
        edit((prev) => {
            const idx = prev.findIndex((t) => t.id === item.id);
            if (idx === -1) return [item, ...prev];
            const next = [...prev];
            next[idx] = { ...next[idx], ...item };
            return next;
        });
    }, [edit]);

    return {
        items: query.data ?? NO_NOTES,
        loading: query.isPending || reloading,
        error: query.error,
        reload, removeLocal, patchLocal, upsertLocal,
    };
}
