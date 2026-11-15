/**
 * The frame runtime of the React component block, fetched once per page and
 * only by a page that has such a block: `virtual:cms-react-runtime` is a chunk
 * of its own (vite.cmsReactRuntime.mjs), never part of the public entry.
 */
let runtimeText: string | null = null;
let pending: Promise<string> | null = null;

/** The runtime text when it has already arrived, else null. */
export function loadedReactRuntime(): string | null {
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
