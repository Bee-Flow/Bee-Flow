/**
 * The frame runtime of the React component block, fetched once per page and
 * only by a page that has such a block: `virtual:cms-react-runtime` is a chunk
 * of its own (vite.cmsReactRuntime.mjs), never part of the public entry.
 */
import { useEffect, useState } from 'react';
import { logger } from '../../utils/logger';

let runtimeText: string | null = null;
let pending: Promise<string> | null = null;

/** The runtime text when it has already arrived, else null. */
function loadedReactRuntime(): string | null {
    return runtimeText;
}

export function loadReactRuntime(): Promise<string> {
    if (runtimeText !== null) return Promise.resolve(runtimeText);
    if (!pending) {
        pending = import('virtual:cms-react-runtime')
            .then((mod) => {
                runtimeText = mod.default;
                return runtimeText;
            })
            .catch((err: unknown) => {
                pending = null;
                throw err;
            });
    }
    return pending;
}

/** The runtime text, once its chunk has arrived (null until then). */
export function useReactRuntime(): string | null {
    const [runtime, setRuntime] = useState<string | null>(loadedReactRuntime);
    useEffect(() => {
        if (runtime !== null) return undefined;
        let live = true;
        loadReactRuntime().then(
            (text) => { if (live) setRuntime(text); },
            (err: unknown) => logger.warn('[ReactBlock] the React runtime could not be loaded', err),
        );
        return () => { live = false; };
    }, [runtime]);
    return runtime;
}
