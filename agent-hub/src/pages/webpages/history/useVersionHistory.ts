import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranslateFn } from '../../../hooks/useTranslation';
import type { PrimaryContent } from '../webpageEditorTypes';
import { api } from '../webpagesApi';

/** One row of `GET /:id/versions` (routes/webpages.js + core/webpages/versionFacts.js). */
export interface VersionRow {
    id: string;
    seq?: number | null;
    summary?: string;
    source?: string;
    isPublished?: boolean;
    actor?: { isYou?: boolean; name?: string | null } | null;
    createdAt?: string;
    contentLength?: number;
    lineDelta?: number | null;
}

/** A version opened read-only; `files: null` while its bytes are on the way or unreadable. */
export type ViewedVersion = VersionRow & { files: PrimaryContent | null };

/**
 * WHAT a snapshot of this page covers. Without it an empty list can only be
 * explained as "you have not edited enough yet", which is false on the
 * DEFAULT project type (react-mui): the app lives in extra files there, and
 * those are in no snapshot.
 */
export interface VersionCoverage {
    coversProject?: boolean;
    extraFiles?: boolean;
}

const errorText = (err: unknown) => (err as Error).message;

/** The version list of one page: load, page on, and the read-only viewer. */
export function useVersionList(webpageId: string, onLoaded: ((n: number) => void) | undefined) {
    const [versions, setVersions] = useState<VersionRow[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [published, setPublished] = useState<{ seq?: number | null } | null>(null);
    const [coverage, setCoverage] = useState<VersionCoverage | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    // A ref, so loading is not rebuilt when the parent passes a new callback —
    // otherwise every render of the parent would trigger a new fetch.
    const onLoadedRef = useRef(onLoaded);
    useEffect(() => { onLoadedRef.current = onLoaded; }, [onLoaded]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await api(`/${webpageId}/versions`);
            if (!mountedRef.current) return;
            const rows: VersionRow[] = Array.isArray(data.versions) ? data.versions : [];
            setVersions(rows);
            setHasMore(!!data.hasMore);
            setPublished(data.published || null);
            setCoverage(data.coverage || null);
            setError(null);
            onLoadedRef.current?.(rows.length);
        } catch (err) {
            if (mountedRef.current) setError(errorText(err));
        } finally {
            if (mountedRef.current) setLoading(false);
        }
    }, [webpageId]);
    useEffect(() => { load(); }, [load]);

    const loadMore = useCallback(async () => {
        if (loadingMore) return;
        setLoadingMore(true);
        try {
            const data = await api(`/${webpageId}/versions?offset=${versions.length}`);
            if (!mountedRef.current) return;
            const rows: VersionRow[] = Array.isArray(data.versions) ? data.versions : [];
            // The PARENT's counter is NOT called from inside this updater. A
            // state updater runs during render and must be pure; React may call
            // it again, and `onLoaded` is a setState of WebpageEditorPage in the
            // real app — the documented "Cannot update a component while
            // rendering a different component" trap.
            setVersions((prev) => [...prev, ...rows]);
            setHasMore(!!data.hasMore);
            onLoadedRef.current?.(versions.length + rows.length);
        } catch (err) {
            if (mountedRef.current) setError(errorText(err));
        } finally {
            if (mountedRef.current) setLoadingMore(false);
        }
    }, [webpageId, versions.length, loadingMore]);

    return { versions, hasMore, published, coverage, loading, loadingMore, error, setError, load, loadMore, mountedRef };
}

/** The read-only view of one version. `viewing: null` means the list is in front. */
export function useVersionViewer(webpageId: string, t: TranslateFn, mountedRef: { current: boolean }) {
    const [viewing, setViewing] = useState<ViewedVersion | null>(null);
    const [viewSlot, setViewSlot] = useState<keyof PrimaryContent>('html');
    const [viewError, setViewError] = useState<string | null>(null);

    const handleView = useCallback(async (version: VersionRow) => {
        setViewError(null);
        setViewSlot('html');
        // Show what is already known at once, so the screen does not stay
        // empty while the bytes are on the way.
        setViewing({ ...version, files: null });
        try {
            const data = await api(`/${webpageId}/versions/${version.id}`);
            if (!mountedRef.current) return;
            const v = data.version || {};
            // `readable: false` means the row exists but its bytes have gone
            // from storage. Showing that as an EMPTY file would not tell the
            // viewer whether the version WAS empty or nothing is left — and
            // Restore on that same row would write that emptiness over the
            // live page.
            if (v.readable === false) {
                setViewError(t('webpages.versions.unreadable',
                    'This snapshot cannot be read any more, so it cannot be shown or restored.'));
                setViewing({ ...version, ...v, files: null });
                return;
            }
            setViewing({ ...version, ...v, files: { html: v.html || '', css: v.css || '', js: v.js || '' } });
        } catch (err) {
            if (mountedRef.current) setViewError(errorText(err));
        }
    }, [webpageId, t, mountedRef]);

    return { viewing, setViewing, viewSlot, setViewSlot, viewError, handleView };
}
