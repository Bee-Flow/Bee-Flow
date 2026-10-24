import { useCallback, useEffect, useRef, useState , useLayoutEffect } from 'react';
import * as api from '../../../api/transcriptionsApi';
import type { MeetingNote } from '../detail/meetingDetailTypes';

/** A new note, or a function of the current one (the callers only run once a note has loaded). */
type LocalUpdate = MeetingNote | ((prev: MeetingNote) => MeetingNote);

export default function useTranscription(id: string | null | undefined) {
    const [data, setData] = useState<MeetingNote | null>(null);
    const [loading, setLoading] = useState<boolean>(false);
    // The caught value as it was thrown. TODO(err-unknown): MeetingDetail.jsx hands it to
    // MeetingLoadError, which still reads it as an ApiError; read it with the caughtError helpers there.
    const [error, setError] = useState<unknown>(null);
    const mounted = useRef<boolean>(true);
    // The id the view shows now; a refresh that started for an older one is dropped.
    const idRef = useRef(id);
    useLayoutEffect(() => {
        idRef.current = id;
    });

    // React 18 Strict Mode runs effects mount → unmount → mount in dev. Resetting
    // `mounted.current` on every mount keeps the guard correct for the *current*
    // mounted instance (otherwise the remount sees `false` and never updates).
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    useEffect(() => {
        // Clear the PREVIOUS note before fetching the new one. This only reset
        // `data` when `id` went falsy, so selecting a note that then failed to
        // load left the old note on screen while the library highlighted the
        // new one — and every action in the detail view (rename, delete,
        // action items) targeted the note still in `data`. A user who trusted
        // the highlight and pressed Delete destroyed a different meeting.
        setData(null);
        setError(null);
        if (!id) { setLoading(false); return; }
        let cancelled = false;
        setLoading(true);
        api.getTranscription(id)
            .then((res: MeetingNote) => { if (!cancelled && mounted.current) setData(res); })
            .catch((err: unknown) => { if (!cancelled && mounted.current) setError(err); })
            .finally(() => { if (!cancelled && mounted.current) setLoading(false); });
        return () => { cancelled = true; };
    }, [id]);

    const refresh = useCallback(async () => {
        if (!id) return;
        try {
            const next = await api.getTranscription(id);
            if (mounted.current && idRef.current === id) setData(next);
        } catch (err) {
            if (mounted.current && idRef.current === id) setError(err);
        }
    }, [id]);

    // While this note is still transcribing (async pipeline), poll so the detail
    // view fills in transcript/speakers/summary the moment processing finishes.
    useEffect(() => {
        if (data?.status !== 'processing') return;
        const interval = setInterval(() => { refresh(); }, 4000);
        return () => clearInterval(interval);
    }, [data?.status, refresh]);

    const setLocal = useCallback((updater: LocalUpdate) => {
        // A function updater has nothing to edit until the note has loaded (the id just
        // changed and `data` is null): spreading null would build a half-filled note.
        setData((prev) => {
            if (typeof updater !== 'function') return updater;
            return prev ? updater(prev) : prev;
        });
    }, []);

    return { data, loading, error, refresh, setLocal };
}
