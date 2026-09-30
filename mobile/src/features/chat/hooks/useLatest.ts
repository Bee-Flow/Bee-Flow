import { useCallback, useEffect, useRef } from 'react';

/**
 * A callback whose identity never changes but which always runs the latest
 * `fn`. For handlers passed to memoised children (the composer, the
 * transcript) that must see the current settings without re-rendering them.
 */
export function useLatest<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    const ref = useRef(fn);
    useEffect(() => {
        ref.current = fn;
    });
    return useCallback((...args: A) => ref.current(...args), []);
}
