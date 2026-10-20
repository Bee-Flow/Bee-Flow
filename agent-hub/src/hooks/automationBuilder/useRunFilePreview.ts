import { useEffect, useState } from 'react';
import { fetchRunFileImage, fetchRunFilePage } from '../../api/queries/automation/runFiles';
import type { RunFilePreviewKind } from '../../api/queries/automation/runFiles';
import { AutomationRequestError } from '../../api/queries/automation/http';

export interface RunFilePreviewState {
    /** An object URL for the image to show, or null while it loads or after a failure. */
    url: string | null;
    totalPages: number | null;
    loading: boolean;
    /** The server's code (`preview_unavailable`, `run_file_too_large_to_preview`, …) or `failed`. */
    errorCode: string | null;
}

/** What one request came back with, tagged with the request it answers. */
interface Answer {
    key: string;
    url: string | null;
    totalPages: number | null;
    errorCode: string | null;
}

/**
 * The picture of one page of a kept file (or of the image itself), fetched
 * with the session. The object URL is released when the page changes and on
 * unmount; an answer to an earlier page never shows as the current one.
 */
export default function useRunFilePreview(
    runId: string, fileId: string, kind: RunFilePreviewKind, page: number,
): RunFilePreviewState {
    const key = `${runId}/${fileId}/${kind}/${page}`;
    const [answer, setAnswer] = useState<Answer | null>(null);
    // The page count outlives a page change, so the pager does not flicker.
    const [totalPages, setTotalPages] = useState<number | null>(null);

    useEffect(() => {
        let alive = true;
        let objectUrl: string | null = null;
        const load = kind === 'pdf'
            ? fetchRunFilePage(runId, fileId, page)
            : fetchRunFileImage(runId, fileId).then((blob) => ({ blob, totalPages: 1 as number | null }));
        load.then((loaded) => {
            if (!alive) return;
            objectUrl = URL.createObjectURL(loaded.blob);
            if (loaded.totalPages) setTotalPages(loaded.totalPages);
            setAnswer({ key, url: objectUrl, totalPages: loaded.totalPages, errorCode: null });
        }).catch((e: unknown) => {
            if (alive) setAnswer({ key, url: null, totalPages: null, errorCode: (e instanceof AutomationRequestError && e.code) || 'failed' });
        });
        return () => {
            alive = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [key, runId, fileId, kind, page]);

    const current = answer && answer.key === key ? answer : null;
    return { url: current?.url ?? null, totalPages, loading: !current, errorCode: current?.errorCode ?? null };
}
