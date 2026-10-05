/**
 * "Run once per attachment instead of once per email": a step that already
 * runs once per item, given a value from a list INSIDE that item.
 *
 * The step reads Gmail results one by one (`loop.result`); each result holds
 * `attachments`. Dropping "Attachments ▸ Attachment id" on a field that takes
 * one id means one run per attachment, across every email: the runtime
 * flattens `results[*].output.attachments` into one list (bind.walkPath), so
 * the step's forEach moves to that list and the field reads the new item.
 * The step's other fields read the old item (`loop.result.id`); each moves to
 * the field of the new item it names (a `messageId` slot takes the
 * attachment's `messageId`), or, failing that, the same key. What has no
 * counterpart is reported, never silently pointed at nothing.
 *
 * Pure: the editors apply it through their own setters.
 */
import { suggestItemVar } from './upstream/loops';

export interface ForEachConfig { overRef?: string; itemVar?: string; maxIterations?: number; [k: string]: unknown }

export interface DeepenPlan {
    /** The item variable the step runs over now (`result`). */
    fromVar: string;
    /** The list inside that item, relative to it (`attachments`, `output.attachments`). */
    listTail: string;
    /** What follows inside one element of that list (`.attachmentId`), '' for the whole element. */
    fieldTail: string;
    /** The new item variable (`attachment`). */
    itemVar: string;
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';

/**
 * Is `path` a value from a list inside the step's current item
 * (`loop.result.attachments[*].attachmentId`)? Only for the step's OWN item
 * variable: a `loop.x` of an enclosing Loop is not this step's to move.
 */
export function nestedListPick(path: string, currentVar: string | null | undefined): DeepenPlan | null {
    if (!currentVar || typeof path !== 'string') return null;
    const m = new RegExp(`^loop\\.(${IDENT})\\.((?:${IDENT}\\.)*${IDENT})\\[\\*\\](.*)$`).exec(path.trim());
    if (!m || m[1] !== currentVar) return null;
    // One level of nesting: a list inside the list's element is a later step.
    if (m[3].includes('[*]')) return null;
    const last = m[2].split('.').pop() || 'item';
    let itemVar = suggestItemVar(last).replace(/[^A-Za-z0-9_]/g, '') || 'item';
    if (itemVar === currentVar) itemVar = `${itemVar}_item`;
    return { fromVar: currentVar, listTail: m[2], fieldTail: m[3], itemVar };
}

/** The forEach that runs over the nested list, flattened across every item of the current one. */
export function deepenedForEach(fe: ForEachConfig | null | undefined, plan: DeepenPlan): ForEachConfig {
    const over = String(fe?.overRef || '').trim();
    // `results[*].output` is already a flattened list: append the key.
    // `results` is a list: flatten it first.
    const overRef = over.includes('[*]') ? `${over}.${plan.listTail}` : `${over}[*].${plan.listTail}`;
    return { ...(fe || {}), overRef, itemVar: plan.itemVar };
}

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

type Binding = { kind?: string; path?: string; value?: unknown };

/**
 * Point the step's references to the old item at the new one. `newItem` is a
 * sample of one element of the nested list. Returns the rewritten inputs and
 * the slots that had no counterpart.
 */
export function rebindToNewItem(
    inputs: Record<string, unknown> | null | undefined,
    plan: DeepenPlan,
    newItem: Record<string, unknown> | null | undefined,
): { inputs: Record<string, unknown>; orphans: string[] } {
    const keys = newItem && typeof newItem === 'object' ? Object.keys(newItem) : [];
    const has = (k: string) => keys.includes(k);
    const oldRe = new RegExp(`\\bloop\\.${plan.fromVar}\\.(${IDENT})`, 'g');
    const orphans: string[] = [];
    const out: Record<string, unknown> = {};
    for (const [slot, raw] of Object.entries(inputs || {})) {
        const b = raw as Binding;
        if (b && typeof b === 'object' && b.kind === 'ref' && typeof b.path === 'string' && b.path.startsWith(`loop.${plan.fromVar}.`)) {
            const rest = b.path.slice(`loop.${plan.fromVar}.`.length);
            const bySlot = keys.find(k => norm(k) === norm(slot));
            const first = rest.split(/[.[]/)[0];
            if (bySlot) out[slot] = { ...b, path: `loop.${plan.itemVar}.${bySlot}` };
            else if (has(first)) out[slot] = { ...b, path: `loop.${plan.itemVar}.${rest}` };
            else { out[slot] = b; orphans.push(slot); }
            continue;
        }
        if (b && typeof b === 'object' && (b.kind === 'template' || b.kind === 'expr') && typeof b.value === 'string' && oldRe.test(b.value)) {
            oldRe.lastIndex = 0;
            let missing = false;
            const value = b.value.replace(oldRe, (whole, k: string) => {
                if (has(k)) return `loop.${plan.itemVar}.${k}`;
                missing = true;
                return whole;
            });
            out[slot] = { ...b, value };
            if (missing) orphans.push(slot);
            continue;
        }
        out[slot] = raw;
    }
    return { inputs: out, orphans };
}

/**
 * Auto-map's version of the drag: for the still-empty `keys` of a step that
 * runs per item, a column of a list inside that item named like the key
 * (`attachmentId` → `attachments[*].attachmentId`). First key, first list
 * wins; null when there is none.
 */
export function findNestedColumn(
    keys: string[],
    itemSample: Record<string, unknown> | null | undefined,
    itemVar: string,
): { key: string; path: string; element: Record<string, unknown> } | null {
    if (!itemSample || typeof itemSample !== 'object') return null;
    for (const key of keys) {
        for (const [listKey, v] of Object.entries(itemSample)) {
            if (!Array.isArray(v)) continue;
            const element = v.find(x => x && typeof x === 'object' && !Array.isArray(x)) as Record<string, unknown> | undefined;
            if (!element) continue;
            const col = Object.keys(element).find(k => norm(k) === norm(key));
            if (col && /^[A-Za-z_][A-Za-z0-9_]*$/.test(listKey) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) {
                return { key, path: `loop.${itemVar}.${listKey}[*].${col}`, element };
            }
        }
    }
    return null;
}
