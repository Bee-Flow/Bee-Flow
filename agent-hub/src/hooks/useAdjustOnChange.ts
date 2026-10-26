import { useState } from 'react';

/**
 * Adjust state when a value from outside changes: React's "store information
 * from previous renders" pattern, in place of an effect that copies a prop into
 * state (`useEffect(() => setX(prop), [prop])`, which renders once with the old
 * state and then again).
 *
 * `adjust` runs DURING render, the first time a render sees `deps` differ
 * (Object.is, element by element) from the render before. React then throws
 * that render away and renders again with the new state, before anything is
 * painted. Unlike an effect it does not run on mount: the state's initial value
 * already matches.
 *
 * `adjust` gets the deps as they were before the change. It may only set state
 * of the component that calls this hook, and must do nothing else (no fetch, no
 * ref, no parent callback).
 */
export default function useAdjustOnChange<T extends readonly unknown[]>(deps: T, adjust: (previous: T) => void): void {
    const [seen, setSeen] = useState(deps);
    if (deps.length !== seen.length || deps.some((d, i) => !Object.is(d, seen[i]))) {
        setSeen(deps);
        adjust(seen);
    }
}
