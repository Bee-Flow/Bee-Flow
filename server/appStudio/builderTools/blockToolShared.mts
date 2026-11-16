/**
 * App Studio builder tools: what the two tools that write a framed block share, app_edit_block
 * (custom_block, ./appEditBlock.mts) and app_edit_react_block (react_block,
 * ./appEditReactBlock.mts): the definition operations, the common tail of a mutating tool, and
 * the check that every wired event names an action that exists.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export type DraftWrap = { def: Record<string, unknown> };

export const ops = nodeRequire('../definitionOps.js') as {
    findNode: (def: unknown, id: string) => { node: Record<string, unknown> } | null;
    updateNodeProps: (def: unknown, id: string, patch: Record<string, unknown>) => unknown;
};
export const { adoptCanonical } = nodeRequire('./shared.js') as { adoptCanonical: (wrap: DraftWrap, next: unknown, result: Record<string, unknown>) => Record<string, unknown> };

export function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The first wired event whose action does not exist, as a sentence; null when all exist. */
export function unknownAction(events: unknown, def: Record<string, unknown>): string | null {
    if (!isObject(events)) return null;
    const actions = isObject(def.actions) ? def.actions : {};
    for (const [name, actionId] of Object.entries(events)) {
        if (typeof actionId === 'string' && actionId && !Object.hasOwn(actions, actionId)) return `events.${name} names the action ${JSON.stringify(actionId)}, which does not exist.`;
    }
    return null;
}

/** The hint of a call that wires an event to an action that does not exist. */
export const UNKNOWN_ACTION_HINT = 'Create the action first (app_set_action), then wire it; or set the event to null.';
