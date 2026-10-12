/**
 * How a pick goes into an EMPTY slot that wants ONE value — the web's value
 * builder pipeline (agent-hub `Builder/mapping/ValueBuilder.jsx` proposePick:
 * proposePick.ts, then deepPick.ts, then the quiet remedy):
 *
 *   1. which path: a table's column or a record's field when the slot names it
 *      (bindings/mismatch proposePickBinding);
 *   2. a value from a list INSIDE a list goes in as its path, never joined:
 *      the host turns it into one run per inner item when it writes the
 *      inputs (bindings/deepenInputs.ts, the integration spec's `write`);
 *   3. anything else that does not fit gets the quiet default at once (a list
 *      into text joined, into a number its first, a table as a table).
 *
 * Pure.
 */

import { proposePickBinding } from '@/features/flow-editor/bindings';
import type { ForEachConfig } from '@/features/flow-editor/bindings/deepenForEach';
import { planDeepPick } from '@/features/flow-editor/bindings/deepPick';

/**
 * What a slot that wants ONE value expects, so a pick is shaped the way the
 * web's value builder shapes it. Absent: a pick goes in as it is.
 */
export interface PickShaping {
    /** The slot's name; a table's column or a record's field may be named after it. */
    slot?: string | null;
    /** The single-value kind the slot wants (bindings/fieldKinds expectedKindFor). */
    expectKind?: string | null;
    /** 'scalar' when the slot wants one value (bindings/listShape expectedShapeFor). */
    expectShape?: string | null;
    sampleRoot?: unknown;
    /**
     * The host runs the step once per inner item when a value from a list
     * inside a list is written (bindings/deepenInputs.ts). `forEach` is the
     * step's current one; leave it out when the host does not say, and every
     * pick that COULD deepen keeps its path.
     */
    deepen?: { forEach?: ForEachConfig | null } | null;
}

const LOOP_VAR_RE = /^loop\.([A-Za-z_$][\w$]*)/;
const noApply = () => null;

/** Would the host's write (deepenInputsWrite) turn this pick into one run per inner item? */
function deepensOnWrite(path: string, sampleRoot: unknown, deepen: NonNullable<PickShaping['deepen']>): boolean {
    if (deepen.forEach !== undefined) {
        // Exactly deepenInputsWrite's question.
        const fe = deepen.forEach?.overRef ? deepen.forEach : null;
        const handle = fe ? { itemVar: fe.itemVar || 'item', forEach: fe, apply: noApply } : null;
        return !!planDeepPick(path, { deepenForEach: handle, canForEach: !fe, sampleRoot });
    }
    // The step's forEach is unknown: a list in a list read either way keeps its path.
    const loopVar = LOOP_VAR_RE.exec(path)?.[1];
    if (loopVar && planDeepPick(path, { deepenForEach: { itemVar: loopVar, apply: noApply }, sampleRoot })) return true;
    return !!planDeepPick(path, { canForEach: true, sampleRoot });
}

/** The path a pick goes in as, and the binding that replaces the field's value (null: insert the path). */
export function shapePick(picked: string, shaping: PickShaping): { path: string; binding: unknown } {
    const decided = proposePickBinding(picked, shaping.sampleRoot, shaping);
    if (!decided.remedy) return { path: decided.path, binding: null };
    if (shaping.deepen && deepensOnWrite(decided.path, shaping.sampleRoot, shaping.deepen)) return { path: decided.path, binding: null };
    return { path: decided.path, binding: decided.remedy.binding };
}
