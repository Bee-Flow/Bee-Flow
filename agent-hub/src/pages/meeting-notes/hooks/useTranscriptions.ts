import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../../api/transcriptionsApi';
import type { MeetingNote, MeetingRowPatch } from '../detail/meetingDetailTypes';

export default function useTranscriptions() {
    const [items, setItems] = useState<MeetingNote[]>([]);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<unknown>(null);
    const mounted = useRef(true);

    // React 18 Strict Mode runs effects mount → unmount → mount in dev. A naïve
    // `mounted.current = false` on cleanup leaves the ref stuck at false for
    // the remounted instance, and the in-flight fetch's success branch never
    // calls setLoading(false) — UI hangs on the spinner forever. Resetting
    // the ref on every mount keeps the guard correct for the *current*
    // mounted instance.
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const load = useCallback(async (showSpinner: boolean) => {
        if (showSpinner) setLoading(true);
        try {
            const list = await api.listTranscriptions();
            if (mounted.current) {
                setItems(list);
                setError(null);
            }
        } catch (err) {
            if (mounted.current) setError(err);
        } finally {
            if (mounted.current && showSpinner) setLoading(false);
        }
    }, []);

    const reload = useCallback(() => load(true), [load]);

    useEffect(() => { reload(); }, [reload]);

    // While any note is still transcribing (async pipeline), poll quietly so the
    // list flips it from a spinner to the finished note without a manual refresh.
    // Depend on the derived boolean, not `items`: every poll result is a fresh
    // array, which used to tear down and recreate the interval every 4s.
    const hasProcessing = items.some((t: MeetingNote) => t.status === 'processing');
    useEffect(() => {
        if (!hasProcessing) return;
        const interval = setInterval(() => { load(false); }, 4000);
        return () => clearInterval(interval);
    }, [hasProcessing, load]);

    const removeLocal = useCallback((id: string) => {
        setItems((prev: MeetingNote[]) => prev.filter((t: MeetingNote) => t.id !== id));
    }, []);

    const patchLocal = useCallback((id: string, patch: MeetingRowPatch) => {
        setItems((prev: MeetingNote[]) => prev.map((t: MeetingNote) => (t.id === id ? { ...t, ...patch } : t)));
    }, []);

    const upsertLocal = useCallback((item: MeetingNote | null | undefined) => {
        if (!item || !item.id) return;
        setItems((prev: MeetingNote[]) => {
            const idx = prev.findIndex((t: MeetingNote) => t.id === item.id);
            if (idx === -1) return [item, ...prev];
            const next = [...prev];
            next[idx] = { ...next[idx], ...item };
            return next;
        });
    }, []);

    return { items, loading, error, reload, removeLocal, patchLocal, upsertLocal };
}
