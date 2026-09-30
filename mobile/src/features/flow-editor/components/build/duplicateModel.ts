/**
 * Duplicating a step from the phone, without the two surprises the shared
 * duplicate (model/nodeOps applyDuplicateNode, the web's) has:
 *
 *   wiring   the web's copy gets only the original's INCOMING lines, so the
 *            flow forks and both run — a duplicated "Send email" sends twice.
 *            Here the copy runs after the original: original → copy → what
 *            came next. A step whose lines branch (a Condition, a Switch)
 *            has no one "next", so its copy stands unwired beside it for the
 *            author to place.
 *   inside   a copied loop or group kept its inner steps' ids, which the
 *            server refuses to go live with (loop.body_item_id_duplicate).
 *            Here every step inside the copy gets a new id, and the copy's
 *            own references to them follow.
 *
 * A step held inside a loop is copied as before: next in line in its body.
 */

import { uniqueStepId, type FlowDefinition, type FlowStep } from '@/features/flow-editor/model';
import { allIds, bodyOf, branchesOf, duplicateStep, isNestedAddress, leafId, updateAtAddress } from '@/features/flow-editor/model/outline';

const escapeId = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every step held inside `step`, at any depth. */
function heldSteps(step: FlowStep): FlowStep[] {
    const direct = [...bodyOf(step), ...branchesOf(step).flat()];
    return direct.flatMap((s) => [s, ...heldSteps(s)]);
}

/** New ids for every step inside the copy, and the copy's own mentions of them renamed. */
export function renumberInside(def: FlowDefinition, address: string): FlowDefinition {
    const taken = allIds(def);
    return updateAtAddress(def, address, (copy) => {
        const inner = heldSteps(copy);
        if (inner.length === 0) return copy;
        let text = JSON.stringify(copy);
        for (const s of inner) {
            const next = uniqueStepId(s.type, taken);
            taken.add(next);
            text = text.replace(new RegExp(`(^|[^\\w-])${escapeId(s.id)}(?![\\w-])`, 'g'), `$1${next}`);
        }
        return JSON.parse(text) as FlowStep;
    });
}

/** The copy after the original: it takes over the original's lines out, and the original leads into it. */
function chainAfter(def: FlowDefinition, originalId: string, copyId: string): FlowDefinition {
    const withoutCopyIn = def.edges.filter((e) => e.to !== copyId);
    const out = withoutCopyIn.filter((e) => e.from === originalId);
    const branches = new Set(out.map((e) => e.to)).size > 1 || out.some((e) => e.label || e.caseName != null);
    if (branches) return { ...def, edges: withoutCopyIn };
    const kept = withoutCopyIn.filter((e) => e.from !== originalId);
    const moved = out.map((e) => ({ ...e, from: copyId }));
    return { ...def, edges: [...kept, { from: originalId, to: copyId }, ...moved] };
}

export function duplicateSafely(def: FlowDefinition, address: string): { definition: FlowDefinition; address: string | null } {
    const copied = duplicateStep(def, address);
    if (!copied.address || copied.definition === def) return copied;
    let next = renumberInside(copied.definition, copied.address);
    if (!isNestedAddress(address)) next = chainAfter(next, leafId(address), copied.address);
    return { definition: next, address: copied.address };
}
