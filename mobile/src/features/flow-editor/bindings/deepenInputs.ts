/**
 * The phone's half of the web's per-item pick (ValueBuilder + deepPick.ts,
 * integrationActionFields' deepen): a value from a list INSIDE a list that
 * lands in a step's input runs the step once per INNER item, the outer items
 * kept (`forEach.parents`), instead of putting a list into a one-value field.
 *
 * Applied where the phone writes a step's inputs (the integration spec's
 * `write`), so a pick from "Insert data" and an auto-map both go through it,
 * for an input that was EMPTY and takes ONE value (see mayDeepen):
 *   - the step runs per order and gets `loop.order.line_items[*].sku` (or the
 *     same column by its full path): it moves down to the line items and keeps
 *     the order (deepenForEach.ts);
 *   - the step does not run per item yet and gets
 *     `steps.shop.output.orders[*].line_items[*].sku`: it runs per line item,
 *     the order kept.
 *
 * Pure.
 */

import { scanTemplate } from '@/shared/expr';

import { deepenedForEach, findNestedColumn, rebindToNewItem } from './deepenForEach';
import type { ForEachConfig } from './deepenForEach';
import { planDeepPick } from './deepPick';
import { expectedShapeFor } from './listShape';
import { isEmptyBinding } from './partitionInputs';

type Inputs = Record<string, unknown>;
/** The action's input schema, as far as the deepen needs it: which inputs take one value. */
export type InputsSchema = { properties?: Record<string, unknown> | null; required?: string[] } | null | undefined;

/** Does the schema declare `slot` as an input that takes ONE value (text, a number, a yes/no)? */
function takesOneValue(schema: InputsSchema, slot: string): boolean {
    const prop = schema?.properties?.[slot];
    return expectedShapeFor(prop && typeof prop === 'object' ? (prop as { type?: string | string[] }) : null) === 'scalar';
}

/**
 * May this input's new value move the step into a list inside a list? Only
 * where the web's value builder does it (ValueBuilder.proposePick): a pick
 * into a still EMPTY input that takes ONE value. The write runs on every
 * keystroke and a slot holds text after the first one, so a half-typed
 * formula (`loop.order.line_items[*]`) never moves the step mid-word; a list
 * parameter takes the column as the list it is; an input the schema does not
 * declare (or no schema at all) is left as it is.
 */
function mayDeepen(slot: string, before: Inputs | null | undefined, schema: InputsSchema): boolean {
    return isEmptyBinding((before || {})[slot]) && takesOneValue(schema, slot);
}

/** The one path a binding holds as a whole: a ref, or a template that is a single `{{ path }}`. */
function lonePath(b: unknown): string | null {
    if (!b || typeof b !== 'object') return null;
    const { kind, path, value } = b as { kind?: unknown; path?: unknown; value?: unknown };
    if (kind === 'ref' && typeof path === 'string') return path;
    if (kind !== 'template' || typeof value !== 'string') return null;
    const parts = scanTemplate(value);
    const only = parts.length === 1 ? parts[0] : undefined;
    return only && only.type === 'ref' ? only.inner : null;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The inputs a field (or auto-map) just wrote, and — when one of the changed
 * values comes from a list inside a list and may move the step (mayDeepen,
 * against the action's `schema`) — the forEach the step now runs with
 * (`sampleRoot` is the run data the lists are read from).
 * `forEach` is absent when nothing moves; every other input passes through.
 */
export function deepenInputsWrite(
    forEach: ForEachConfig | null | undefined,
    before: Inputs | null | undefined,
    next: Inputs,
    { sampleRoot, schema }: { sampleRoot: unknown; schema: InputsSchema },
): { inputs: Inputs; forEach?: ForEachConfig } {
    const fe = forEach?.overRef ? forEach : null;
    const handle = fe ? { itemVar: fe.itemVar || 'item', forEach: fe, apply: () => null } : null;
    for (const [slot, b] of Object.entries(next || {})) {
        if (same(b, (before || {})[slot]) || !mayDeepen(slot, before, schema)) continue;
        const path = lonePath(b);
        const pick = path ? planDeepPick(path, { deepenForEach: handle, canForEach: !fe, sampleRoot }) : null;
        if (!pick) continue;
        if (pick.plan && fe) {
            const inputs = rebindToNewItem({ ...next, [slot]: pick.binding }, pick.plan, pick.newItem, fe).inputs;
            return { inputs, forEach: deepenedForEach(fe, pick.plan, sampleRoot) };
        }
        if (pick.forEach) return { inputs: { ...next, [slot]: pick.binding }, forEach: pick.forEach };
    }
    return { inputs: next };
}

/**
 * Auto-map's version for a step that already runs per item: the first still
 * empty input (required first) that takes one value and is named like a
 * column of a list inside the item (`attachmentId` →
 * `loop.mail.attachments[*].attachmentId`), as a patch that
 * deepenInputsWrite then turns into the move — never a column it would leave
 * standing as a list. Empty when there is none.
 */
export function nestedColumnPatch(
    schema: InputsSchema,
    inputs: Inputs,
    itemSample: unknown,
    itemVar: string,
): Inputs {
    const required = new Set(schema?.required || []);
    const empty = Object.keys(schema?.properties || {})
        .filter((k) => isEmptyBinding(inputs[k]) && takesOneValue(schema, k))
        .sort((a, b) => (required.has(b) ? 1 : 0) - (required.has(a) ? 1 : 0));
    const hit = findNestedColumn(empty, itemSample as Record<string, unknown> | null, itemVar);
    return hit ? { [hit.key]: { kind: 'ref', path: hit.path } } : {};
}
