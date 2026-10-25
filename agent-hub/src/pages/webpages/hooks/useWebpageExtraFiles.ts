import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { resizeImageForUpload } from '../../../utils/imageResize';
import { uniqueAssetPath } from '../webpageAssetPath';
import type { ExtraContent, ExtraContents, ExtraFileMeta } from '../../../api/webpageEditorTypes';
import { api, fetchExtraContent } from '../../../api/webpagesApi';
import type { PageGuards } from './usePageGuards';
import { logger } from '../../../utils/logger';

function upsertMeta(prev: ExtraFileMeta[], meta: ExtraFileMeta): ExtraFileMeta[] {
    const idx = prev.findIndex(f => f.path === meta.path);
    if (idx >= 0) { const next = [...prev]; next[idx] = { ...prev[idx], ...meta }; return next; }
    return [...prev, meta];
}

function withoutPath(prev: ExtraContents, path: string): ExtraContents {
    const next = { ...prev };
    delete next[path];
    return next;
}

/**
 * Extra files (multi-file projects): an array of file metadata, plus a map of
 * path → content for text files / dataUrl for binaries. Hydrated from the
 * bundle and kept in sync via the webpage_extra_update / _deleted SSE events,
 * whose handlers this hook returns for the chat engine.
 */
export function useWebpageExtraFiles(
    pageId: string,
    initial: { extraFiles: ExtraFileMeta[]; extraContents: ExtraContents },
    isStillCurrent: PageGuards['isStillCurrent'],
) {
    const [extraFiles, setExtraFiles] = useState<ExtraFileMeta[]>(initial.extraFiles);
    const [extraContents, setExtraContents] = useState<ExtraContents>(initial.extraContents);
    const extraContentsRef = useRef<ExtraContents>(initial.extraContents);
    useEffect(() => { extraContentsRef.current = extraContents; }, [extraContents]);

    // Merge an extra-file meta + content entry into local state (shared by the
    // create/upload/rename handlers; same shape as the extra-update SSE).
    const mergeExtra = useCallback((meta: ExtraFileMeta, contentEntry?: ExtraContent) => {
        setExtraFiles(prev => upsertMeta(prev, meta));
        if (contentEntry) setExtraContents(prev => ({ ...prev, [meta.path]: contentEntry }));
    }, []);

    // A tool just created or updated an extra file. Refetch its content so the
    // preview can inline it, and update the metadata list.
    const onWebpageExtraUpdate = useCallback(async (data: { path: unknown; meta: unknown }) => {
        const { path, meta } = (data || {}) as { path?: string; meta?: ExtraFileMeta };
        if (!path) return;
        const targetId = pageId;
        setExtraFiles(prev => {
            const idx = prev.findIndex(f => f.path === path);
            if (idx >= 0) {
                const next = [...prev];
                next[idx] = { ...prev[idx], ...meta };
                return next;
            }
            return [...prev, meta as ExtraFileMeta];
        });
        try {
            const entry = await fetchExtraContent(targetId, { path, mimeType: meta?.mimeType });
            // Drop the fetched content if the user switched pages meanwhile.
            if (!isStillCurrent(targetId)) return;
            setExtraContents(prev => ({ ...prev, [path]: entry }));
        } catch (err) { logger.debug('ignore single-file fetch failures', err); }
    }, [pageId, isStillCurrent]);

    const onWebpageExtraDeleted = useCallback((data: { path: unknown }) => {
        const path = (data as { path?: string } | null)?.path;
        if (!path) return;
        setExtraFiles(prev => prev.filter(f => f.path !== path));
        setExtraContents(prev => withoutPath(prev, path));
    }, []);

    // A user edit of an extra text file; the caller marks the path dirty.
    const changeExtraContent = useCallback((path: string, newContent: string) => {
        setExtraContents(prev => {
            const existing = prev[path];
            if (!existing || !existing.isText) return prev;
            if (existing.content === newContent) return prev;
            return { ...prev, [path]: { ...existing, content: newContent } };
        });
    }, []);

    return {
        extraFiles, setExtraFiles, extraContents, setExtraContents, extraContentsRef,
        mergeExtra, onWebpageExtraUpdate, onWebpageExtraDeleted, changeExtraContent,
    };
}

export type WebpageExtraFiles = ReturnType<typeof useWebpageExtraFiles>;

async function failOnError(res: Response, label: string): Promise<void> {
    if (res.ok) return;
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `${label} ${res.status}`);
}

interface FileActionDeps {
    pageId: string;
    extras: WebpageExtraFiles;
    guards: Pick<PageGuards, 'isStillCurrent' | 'reportHandlerError'> & { inflightAbortRef: RefObject<AbortController | null> };
}

/**
 * Manual file / asset management (owner-only; mirrors the AI tools). Every
 * handler is page-guarded: a late answer for a page that is no longer open
 * changes nothing, and a failure lands in the editor's error banner.
 */
export function useWebpageFileActions({ pageId, extras, guards }: FileActionDeps) {
    const { extraFiles, setExtraFiles, setExtraContents, mergeExtra } = extras;
    const { isStillCurrent, reportHandlerError, inflightAbortRef } = guards;

    const handleCreateFile = useCallback(async (path: string) => {
        if (!path) return;
        const targetId = pageId;
        try {
            const r = await api(`/${targetId}/files`, { method: 'PUT', body: JSON.stringify({ path, content: '' }), signal: inflightAbortRef.current?.signal });
            if (!isStillCurrent(targetId)) return;
            mergeExtra(r.file, { mimeType: r.file.mimeType, isText: true, content: '' });
        } catch (err) { reportHandlerError(targetId, err); }
    }, [pageId, mergeExtra, isStillCurrent, reportHandlerError, inflightAbortRef]);

    const handleDeleteFile = useCallback(async (path: string) => {
        if (!path) return;
        const targetId = pageId;
        try {
            await api(`/${targetId}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE', signal: inflightAbortRef.current?.signal });
            if (!isStillCurrent(targetId)) return;
            setExtraFiles(prev => prev.filter(f => f.path !== path));
            setExtraContents(prev => withoutPath(prev, path));
        } catch (err) { reportHandlerError(targetId, err); }
    }, [pageId, isStillCurrent, reportHandlerError, inflightAbortRef, setExtraFiles, setExtraContents]);

    const handleRenameFile = useCallback(async (oldPath: string, newPath: string) => {
        if (!oldPath || !newPath || oldPath === newPath) return;
        const targetId = pageId;
        try {
            const res = await authFetch(`${API_BASE}/api/webpages/${targetId}/assets/move`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: oldPath, to: newPath }), signal: inflightAbortRef.current?.signal,
            });
            await failOnError(res, 'Rename');
            const { file: meta } = await res.json() as { file: ExtraFileMeta };
            if (!isStillCurrent(targetId)) return;
            setExtraFiles(prev => prev.filter(f => f.path !== oldPath).concat(meta));
            setExtraContents(prev => { const n = { ...prev }; const c = n[oldPath]; delete n[oldPath]; if (c) n[meta.path] = c; return n; });
        } catch (err) { reportHandlerError(targetId, err); }
    }, [pageId, isStillCurrent, reportHandlerError, inflightAbortRef, setExtraFiles, setExtraContents]);

    const handleAssetUpload = useCallback(async (file: File, folder = 'assets'): Promise<string | undefined> => {
        if (!file) return undefined;
        const targetId = pageId;
        try {
            let blob: Blob = file;
            let mimeType = file.type || 'application/octet-stream';
            if (file.type && file.type.startsWith('image/')) {
                const r = await resizeImageForUpload(file);
                blob = r.blob; mimeType = r.mimeType;
            }
            const path = uniqueAssetPath(file.name, mimeType, folder, new Set(extraFiles.map(f => f.path)));
            const form = new FormData();
            form.append('file', blob, path.split('/').pop());
            form.append('path', path);
            const res = await authFetch(`${API_BASE}/api/webpages/${targetId}/assets`, { method: 'POST', body: form, signal: inflightAbortRef.current?.signal });
            await failOnError(res, 'Upload');
            const { file: meta, contentBase64 } = await res.json() as { file: ExtraFileMeta; contentBase64: string };
            if (!isStillCurrent(targetId)) return undefined;
            mergeExtra(meta, { mimeType: meta.mimeType, isText: false, dataUrl: `data:${meta.mimeType};base64,${contentBase64}` });
            return meta.path;
        } catch (err) { reportHandlerError(targetId, err); }
        return undefined;
    }, [pageId, extraFiles, mergeExtra, isStillCurrent, reportHandlerError, inflightAbortRef]);

    return { handleCreateFile, handleDeleteFile, handleRenameFile, handleAssetUpload };
}
