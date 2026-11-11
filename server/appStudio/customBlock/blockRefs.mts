/**
 * Custom block: which actions a block can run.
 *
 * A control in the template raises an event (`data-emit="pick"`), and `events` wires an event
 * name to an action. A block can run an action only when BOTH are there: an entry of `events`
 * that no control of the template raises wires nothing. So that is what counts as "this node
 * runs this action" for the reachability walk, and with it for the actions an anonymous
 * visitor may run on a public screen that draws the block (nodeActionRefs.mts).
 */

import { canonicalTemplate, inspectTemplate } from '../../shared/blockTemplate/index.mjs';

type ActionRef = { actionId: string; via: string; label?: string };

const MEMO_MAX = 100;
const raised = new Map<string, readonly string[]>();

/** The event names the controls of a template raise (after the vocabulary is applied). */
export function templateEvents(template: unknown): readonly string[] {
    if (typeof template !== 'string' || !template.includes('data-emit')) return [];
    const known = raised.get(template);
    if (known) return known;
    const events = Object.freeze(inspectTemplate(canonicalTemplate(template).nodes).events);
    if (raised.size >= MEMO_MAX) raised.clear();
    raised.set(template, events);
    return events;
}

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The actions `props.block` runs: one per wired event that a control of the template raises. */
export function blockActionRefs(block: unknown): ActionRef[] {
    if (!isObject(block) || !isObject(block.events)) return [];
    const out: ActionRef[] = [];
    for (const name of templateEvents(block.template)) {
        const actionId = Object.hasOwn(block.events, name) ? block.events[name] : null;
        if (typeof actionId === 'string' && actionId) out.push({ actionId, via: `block.events.${name}`, label: name });
    }
    return out;
}
