import { useCallback } from 'react';

/**
 * The `onRequestForEach` a step editor hands its value fields: "run this step
 * once per item of that list" (step.forEach, which the runtime honours on
 * every leaf step — server/core/automationRunner/execFlow.js execForEachStep).
 *
 * `allowed` is false when the step already runs per item: switching the list under it would
 * orphan every field that reads the current item. Such a step shows that item
 * as the first group under "Comes in", which is where its fields come from; a
 * list picked anyway gets an answer that keeps one run (mismatch.js
 * quietDefaultId), never a second forEach.
 */
interface ForEach { overRef?: string; itemVar?: string; maxIterations?: number; [k: string]: unknown }
type SetFn = (key: string, value: unknown) => void;

export interface ForEachRequest {
    /** Sets (or, with null, clears) the step's forEach. Always there, so Undo works. */
    request: (fe: ForEach | null) => void;
    /** May a pick START a forEach? False while the step already runs per item. */
    allowed: boolean;
}

export default function useForEachRequest(
    draft: { forEach?: ForEach | null } | null | undefined,
    set: SetFn,
): ForEachRequest {
    const running = !!draft?.forEach?.overRef;
    const request = useCallback((fe: ForEach | null) => {
        set('forEach', fe ? { itemVar: 'item', maxIterations: 100, ...fe } : null);
    }, [set]);
    return { request, allowed: !running };
}
