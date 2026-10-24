import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, isAbortError } from '../../../utils/caughtError';
import { logger } from '../../../utils/logger';

/**
 * Page-scope guards of the open webpage editor. `mountedRef` is what makes a
 * late response harmless; the AbortController cancels outstanding page-scoped
 * mutations (uploads, file create/delete/rename) when this page is left.
 *
 * `isStillCurrent(targetId)` ignores an async result whose webpage is no
 * longer the one loaded (the user switched away), so a late response can't
 * mutate the wrong page's state or resurrect a deleted file. Aborted requests
 * are silent (the switch cancelled them on purpose); any other failure lands
 * in `error`, the banner under the header.
 */
export default function usePageGuards(pageId: string) {
    const [error, setError] = useState<string | null | undefined>(null);
    const mountedRef = useRef(true);
    const inflightAbortRef = useRef<AbortController | null>(null);
    useEffect(() => {
        mountedRef.current = true;
        inflightAbortRef.current = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        return () => {
            mountedRef.current = false;
            try { inflightAbortRef.current?.abort(); } catch (err) { logger.debug('ignore', err); }
        };
    }, []);
    const isStillCurrent = useCallback((targetId: string) => mountedRef.current && targetId === pageId, [pageId]);
    const reportHandlerError = useCallback((targetId: string, err: unknown) => {
        if (isAbortError(err)) return;
        if (isStillCurrent(targetId)) setError(errorMessage(err) ?? null);
    }, [isStillCurrent]);
    return { error, setError, mountedRef, inflightAbortRef, isStillCurrent, reportHandlerError };
}

export type PageGuards = ReturnType<typeof usePageGuards>;
