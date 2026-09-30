/**
 * Edits to a section's condition at any depth — the web's recursive `Rule`
 * editor (agent-hub pages/documents/DocumentWorkspacePanel.jsx), as pure
 * functions so the component only renders. A condition is a rule, or a group
 * `{ all: [...] }` / `{ any: [...] }` whose children are conditions again.
 *
 * The web's semantics, kept exactly:
 *   - no condition + "Add condition" → `{ all: [rule] }`;
 *   - removing a group's last child, or a child edit that empties the group,
 *     removes the group (null), never leaves `{ all: [] }` behind;
 *   - "+ Group" adds `{ all: [rule] }` and is offered while depth < 4.
 */

import type { Condition, Rule } from './types';

export type Join = 'all' | 'any';
export type Group = { all: Condition[] } | { any: Condition[] };

/** The deepest level at which "+ Group" is still offered (the web's `depth < 4`). */
export const MAX_GROUP_DEPTH = 4;

export function isGroup(condition: Condition): condition is Group {
    return 'all' in condition || 'any' in condition;
}

export function joinOf(group: Group): Join {
    return 'all' in group ? 'all' : 'any';
}

export function childrenOf(group: Group): Condition[] {
    return 'all' in group ? group.all : group.any;
}

function make(join: Join, children: Condition[]): Group {
    return join === 'all' ? { all: children } : { any: children };
}

/** A brand-new condition: one group holding one rule. */
export function newCondition(rule: Rule): Group {
    return { all: [rule] };
}

export function setJoin(group: Group, join: Join): Group {
    return make(join, childrenOf(group));
}

/** Replace child `index`; `null` drops it, and an emptied group is gone. */
export function setChild(group: Group, index: number, next: Condition | null): Group | null {
    const changed = childrenOf(group).flatMap((child, i) => (i === index ? (next ? [next] : []) : [child]));
    return changed.length ? make(joinOf(group), changed) : null;
}

export function removeChild(group: Group, index: number): Group | null {
    return setChild(group, index, null);
}

export function addRule(group: Group, rule: Rule): Group {
    return make(joinOf(group), [...childrenOf(group), rule]);
}

export function addGroup(group: Group, rule: Rule): Group {
    return make(joinOf(group), [...childrenOf(group), newCondition(rule)]);
}
