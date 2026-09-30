/**
 * useSourcesPolling — owns a notebook's source list, the add/delete/retry
 * handlers, the upload queue and the "poll while processing" loop.
 *
 *   entityId   notebook id (null in list view → handlers no-op)
 *   onError    surface an error message to the page (URL/text/meeting adds)
 *   onChanged  refresh the notebook list counts after a mutation
 *
 * Uploads go through a small queue (two at a time) whose rows say what each
 * file is doing — waiting, uploading, added, or failed with a retry — instead
 * of one opaque banner at the end. Removing a source is deferred for a few
 * seconds behind an Undo: the row leaves the list at once, the request is sent
 * when the grace period ends (or immediately when the notebook is left).
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    notebookApi, uploadSourceFile, getSourceContent, renameSource as renameSourceApi,
    reorderSourcesApi, bulkDeleteSourcesApi,
} from './notebookApi';
import useTranslation from '../../../hooks/useTranslation';

export interface NotebookSource {
    id: string;
    name: string;
    type: string;
    status: 'processing' | 'ready' | 'error' | string;
    error?: string | null;
    wordCount?: number;
    [key: string]: unknown;
}

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed';
export interface UploadItem { id: string; name: string; size: number; status: UploadStatus; error?: string }
export interface PendingDelete { source: NotebookSource; index: number }

/** How long a removed source can still be brought back. */
export const UNDO_DELETE_MS = 8000;
const UPLOAD_CONCURRENCY = 2;
const DONE_ROW_MS = 4000;

interface Options {
    entityId?: string | null;
    onError?: (message: string) => void;
    onChanged?: () => void;
}

let uploadSeq = 0;

export default function useSourcesPolling({ entityId, onError, onChanged }: Options = {}) {
    const { t } = useTranslation();
    const [sources, setSourcesState] = useState<NotebookSource[]>([]);
    // Mirrors for handlers that must read the CURRENT list and queue at call
    // time (a state updater runs later, during render, and may run twice).
    const sourcesRef = useRef<NotebookSource[]>([]);
    const setSources = useCallback((next: NotebookSource[] | ((prev: NotebookSource[]) => NotebookSource[])) => {
        sourcesRef.current = typeof next === 'function' ? next(sourcesRef.current) : next;
        setSourcesState(sourcesRef.current);
    }, []);
    // Has the server ANSWERED for this notebook? `sources` starts [] so the
    // array alone cannot tell "no sources" from "not loaded yet"; the chat's
    // sources pill needs the difference. Resets per notebook.
    const [sourcesKnown, setSourcesKnown] = useState(false);
    const [uploads, setUploadsState] = useState<UploadItem[]>([]);
    const uploadsRef = useRef<UploadItem[]>([]);
    const setUploads = useCallback((next: UploadItem[] | ((prev: UploadItem[]) => UploadItem[])) => {
        uploadsRef.current = typeof next === 'function' ? next(uploadsRef.current) : next;
        setUploadsState(uploadsRef.current);
    }, []);
    const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
    const filesRef = useRef(new Map<string, File>());
    const activeRef = useRef(0);
    const pendingDeleteRef = useRef<PendingDelete | null>(null);
    const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const entityRef = useRef(entityId);
    useEffect(() => { entityRef.current = entityId; }, [entityId]);

    const onErrorRef = useRef(onError);
    const onChangedRef = useRef(onChanged);
    useEffect(() => { onErrorRef.current = onError; onChangedRef.current = onChanged; }, [onError, onChanged]);

    const refreshSources = useCallback(async () => {
        if (!entityId) return;
        try {
            const data = await notebookApi(`/${entityId}/sources`);
            if (entityRef.current !== entityId) return;
            const pending = pendingDeleteRef.current?.source.id;
            setSources((data.sources || []).filter((s: NotebookSource) => s.id !== pending));
            setSourcesKnown(true);
        } catch (e) { onErrorRef.current?.((e as Error).message); }
    }, [entityId, setSources]);

    /** The list the notebook read already carried: it counts as an answer. */
    const seedSources = useCallback((list: NotebookSource[] | null | undefined) => {
        setSources(Array.isArray(list) ? list : []);
        setSourcesKnown(Array.isArray(list));
    }, [setSources]);

    // Poll while any source is still processing; stop once all settle.
    const hasProcessing = useMemo(() => sources.some((s) => s.status === 'processing'), [sources]);
    useEffect(() => {
        if (!entityId || !hasProcessing) return undefined;
        const interval = setInterval(() => { void refreshSources(); }, 3000);
        return () => clearInterval(interval);
    }, [entityId, hasProcessing, refreshSources]);

    // ── Deferred delete with undo ───────────────────────────────────
    const commitDelete = useCallback((forId: string | null | undefined) => {
        const pending = pendingDeleteRef.current;
        if (deleteTimerRef.current) { clearTimeout(deleteTimerRef.current); deleteTimerRef.current = null; }
        pendingDeleteRef.current = null;
        setPendingDelete(null);
        if (!pending || !forId) return;
        notebookApi(`/${forId}/sources/${pending.source.id}`, { method: 'DELETE' })
            .then(() => onChangedRef.current?.())
            .catch((e: Error) => {
                // The source is still there: put it back where it was.
                if (entityRef.current === forId) {
                    setSources((prev) => (prev.some((s) => s.id === pending.source.id) ? prev
                        : [...prev.slice(0, pending.index), pending.source, ...prev.slice(pending.index)]));
                    onErrorRef.current?.(t('notebooks.source_remove_failed', 'The source could not be removed: {message}', { message: e.message }));
                }
            });
    }, [t]);

    const handleDeleteSource = useCallback((sid: string) => {
        if (!entityId) return;
        // One at a time: a second removal settles the first.
        if (pendingDeleteRef.current) commitDelete(entityId);
        const index = sourcesRef.current.findIndex((s) => s.id === sid);
        if (index < 0) return;
        const found = { source: sourcesRef.current[index], index };
        setSources((prev) => prev.filter((s) => s.id !== sid));
        pendingDeleteRef.current = found;
        setPendingDelete(found);
        const forId = entityId;
        deleteTimerRef.current = setTimeout(() => commitDelete(forId), UNDO_DELETE_MS);
    }, [entityId, commitDelete, setSources]);

    const undoDelete = useCallback(() => {
        const pending = pendingDeleteRef.current;
        if (!pending) return;
        if (deleteTimerRef.current) { clearTimeout(deleteTimerRef.current); deleteTimerRef.current = null; }
        pendingDeleteRef.current = null;
        setPendingDelete(null);
        setSources((prev) => [...prev.slice(0, pending.index), pending.source, ...prev.slice(pending.index)]);
    }, []);

    // Leaving the notebook (or the page) settles a pending removal at once.
    useEffect(() => {
        setSourcesKnown(false);
        setUploads([]);
        filesRef.current.clear();
        activeRef.current = 0;
        const forId = entityId;
        return () => { if (pendingDeleteRef.current) commitDelete(forId); };
    }, [entityId, commitDelete]);

    // ── Upload queue ────────────────────────────────────────────────
    const patchUpload = useCallback((id: string, patch: Partial<UploadItem>) => {
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
    }, [setUploads]);

    const pump = useCallback(() => {
        const forId = entityRef.current;
        if (!forId) return;
        const free = UPLOAD_CONCURRENCY - activeRef.current;
        if (free <= 0) return;
        const next = uploadsRef.current.filter((u) => u.status === 'queued' && filesRef.current.has(u.id)).slice(0, free);
        if (!next.length) return;
        const started = new Set(next.map((u) => u.id));
        setUploads((prev) => prev.map((u) => (started.has(u.id) ? { ...u, status: 'uploading' as UploadStatus } : u)));
        for (const item of next) {
            const file = filesRef.current.get(item.id) as File;
            activeRef.current += 1;
            uploadSourceFile(forId, file)
                .then(() => {
                    filesRef.current.delete(item.id);
                    patchUpload(item.id, { status: 'done' });
                    setTimeout(() => setUploads((list) => list.filter((u) => u.id !== item.id)), DONE_ROW_MS);
                    void refreshSources();
                    onChangedRef.current?.();
                })
                .catch((e: Error) => {
                    patchUpload(item.id, { status: 'failed', error: e.message || t('notebooks.upload_failed', 'Upload failed') });
                })
                .finally(() => { activeRef.current -= 1; setTimeout(pumpRef.current, 0); });
        }
    }, [patchUpload, refreshSources, setUploads, t]);
    const pumpRef = useRef(pump);
    useEffect(() => { pumpRef.current = pump; }, [pump]);

    const handleFileUpload = useCallback((files: FileList | File[] | null | undefined) => {
        if (!files || !files.length || !entityId) return;
        const added: UploadItem[] = Array.from(files).map((file) => {
            uploadSeq += 1;
            const id = `up-${uploadSeq}`;
            filesRef.current.set(id, file);
            return { id, name: file.name, size: file.size, status: 'queued' as UploadStatus };
        });
        setUploads((prev) => [...prev, ...added]);
        pump();
    }, [entityId, pump, setUploads]);

    const retryUpload = useCallback((id: string) => {
        if (!filesRef.current.has(id)) return;
        patchUpload(id, { status: 'queued', error: undefined });
        pump();
    }, [patchUpload, pump]);

    const dismissUpload = useCallback((id: string) => {
        filesRef.current.delete(id);
        setUploads((prev) => prev.filter((u) => u.id !== id));
    }, [setUploads]);

    // ── The other adds and edits ───────────────────────────────────
    const post = useCallback(async (path: string, payload: unknown) => {
        if (!entityId) return;
        try {
            await notebookApi(`/${entityId}${path}`, { method: 'POST', body: JSON.stringify(payload) });
            await refreshSources();
            onChangedRef.current?.();
        } catch (e) { onErrorRef.current?.((e as Error).message); }
    }, [entityId, refreshSources]);

    const handleAddUrl = useCallback((url: string) => (url?.trim() ? post('/sources/url', { url: url.trim() }) : undefined), [post]);
    const handleAddText = useCallback((text: string, name?: string) => (text?.trim()
        ? post('/sources/text', { text: text.trim(), name: name?.trim() || undefined }) : undefined), [post]);
    const handleAddMeeting = useCallback((meetingId: string, opts: { mode?: string } = {}) => (meetingId
        ? post('/sources/meeting', { meetingId, mode: opts.mode === 'summary' ? 'summary' : 'full' }) : undefined), [post]);

    // Retry flips the row back to processing immediately so the shimmer shows.
    const handleRetrySource = useCallback(async (sid: string) => {
        if (!entityId) return;
        try {
            await notebookApi(`/${entityId}/sources/${sid}/retry`, { method: 'POST' });
            setSources((prev) => prev.map((s) => (s.id === sid ? { ...s, status: 'processing', error: null } : s)));
        } catch (e) { onErrorRef.current?.((e as Error).message); }
    }, [entityId]);

    const handleCancelSource = useCallback(async (sid: string) => {
        if (!entityId) return;
        try {
            await notebookApi(`/${entityId}/sources/${sid}/cancel`, { method: 'POST' });
            setSources((prev) => prev.map((s) => (s.id === sid ? { ...s, status: 'error', error: t('notebooks.cancelled_by_you', 'Cancelled') } : s)));
        } catch (e) { onErrorRef.current?.((e as Error).message); }
    }, [entityId, t]);

    const handleRenameSource = useCallback(async (sid: string, name: string) => {
        if (!entityId || !name?.trim()) return;
        const clean = name.trim();
        setSources((prev) => prev.map((s) => (s.id === sid ? { ...s, name: clean } : s)));
        try { await renameSourceApi(entityId, sid, clean); }
        catch (e) { onErrorRef.current?.((e as Error).message); await refreshSources(); }
    }, [entityId, refreshSources]);

    const handleReorderSources = useCallback(async (ordered: NotebookSource[]) => {
        if (!entityId || !Array.isArray(ordered)) return;
        setSources(ordered);
        try { await reorderSourcesApi(entityId, ordered.map((s) => s.id)); }
        catch (e) { onErrorRef.current?.((e as Error).message); await refreshSources(); }
    }, [entityId, refreshSources]);

    const handleBulkDelete = useCallback(async (ids: string[]) => {
        if (!entityId || !ids?.length) return;
        const set = new Set(ids);
        setSources((prev) => prev.filter((s) => !set.has(s.id)));
        try { await bulkDeleteSourcesApi(entityId, ids); onChangedRef.current?.(); }
        catch (e) { onErrorRef.current?.((e as Error).message); await refreshSources(); }
    }, [entityId, refreshSources]);

    const fetchSourceContent = useCallback((sid: string) => getSourceContent(entityId, sid), [entityId]);

    const readySources = useMemo(() => sources.filter((s) => s.status === 'ready'), [sources]);
    const totalWords = useMemo(() => sources.reduce((acc, src) => acc + (src.wordCount || 0), 0), [sources]);

    return {
        sources, setSources, seedSources, sourcesKnown, refreshSources, readySources, totalWords,
        uploads, retryUpload, dismissUpload,
        pendingDelete, undoDelete,
        handleFileUpload, handleAddUrl, handleAddText, handleAddMeeting,
        handleDeleteSource, handleRetrySource, handleCancelSource,
        handleRenameSource, handleReorderSources, handleBulkDelete, fetchSourceContent,
    };
}
