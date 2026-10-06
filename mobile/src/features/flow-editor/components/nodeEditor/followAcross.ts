/**
 * "Use what this Condition keeps" as ONE draft-store edit — the host half of
 * the web's `onFollowRoute` (BuildTab): the next steps named are re-pointed
 * from the list the Condition filters to the output they hang off (the
 * shared followSuccessors), so one Undo restores them all. Answers the
 * rewrites made, or undefined when nothing changed (edits are locked, the
 * steps already read the output).
 */

import type { DraftStore } from '@/features/flow-editor/state';
import { followSuccessors, type RouteRebound } from '@/shared/expr';

export function followAcross(store: DraftStore, routeId: string, stepIds: readonly string[]): RouteRebound[] | undefined {
    let rebound: RouteRebound[] = [];
    store.getState().applyOp((definition) => {
        const out = followSuccessors(definition, routeId, stepIds);
        rebound = out.rebound;
        return out.rebound.length ? out.definition : definition;
    });
    return rebound.length ? rebound : undefined;
}
