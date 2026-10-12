/**
 * "Run once per attachment instead of once per email": a step that already
 * runs once per item, given a value from a list INSIDE that item.
 *
 * The step reads Gmail results one by one (`loop.result`); each result holds
 * `attachments`. Dropping "Attachments ▸ Attachment id" on a field that takes
 * one id means one run per attachment, across every email: the runtime
 * flattens `results[*].output.attachments` into one list, so the step's
 * forEach moves to that list and the field reads the new item.
 *
 * The step's other fields read the EMAIL (`loop.result.id`), and keep doing
 * so: the forEach records the list it ran over before as a parent
 * (`forEach.parents`, outermost first), and the runner binds, for every
 * attachment, `loop.result` to the email that attachment came from
 * (core/automationRunner/forEachScope.js). Nothing is rebound to a field of
 * the attachment that merely shares a name — an order's `id` is not its line
 * item's `id`. Only fields that read a column of the very list the step moved
 * to (`loop.result.attachments[*].filename`) move with it, to
 * `loop.attachment.filename`.
 *
 * Any depth: `loop.order.line_items[*].properties[*].value` moves the step to
 * every property of every line item, and keeps both the order and the line
 * item. Keys that are not identifiers (`["line-items"]`) work the same: paths
 * are read and written with the runtime grammar (shared/expr/path.mjs).
 *
 * Pure: the editors apply it through their own setters.
 */
import { appendKey, appendWildcard, formatPath, getPath, walkTokens } from '@shared/expr/path.mjs';
import { foldKey, isRecord, listSources, mergeElementSamples } from './deepFields';
import { rewriteBinding } from './itemRefs';
import type { ForEachConfig, ForEachParent } from './itemRefs';
import { isWild, joinRel, keyOf, lastKeyOf, parse, relText, relTokens, sameTok, suffixText } from './pathTokens';
import type { Tok } from './pathTokens';
import { suggestItemVar, uniqueItemVar } from './upstream/loops';

export type { ForEachConfig, ForEachParent } from './itemRefs';
export { rebaseForEach, renameItemRefs } from './itemRefs';
export { innerForEachPick, relativeToItem } from './innerList';
export { joinRel } from './pathTokens';

export interface DeepenPlan {
    /** The item variable the step runs over now (`result`). */
    fromVar: string;
    /** The list inside that item, relative to it (`attachments`, `line_items[*].properties`, `["line-items"]`). */
    listTail: string;
    /** What follows inside one element of that list (`.attachmentId`, `["unit price"]`), '' for the whole element. */
    fieldTail: string;
    /** The new item variable (`attachment`). */
    itemVar: string;
    /** Lists passed on the way down (`line_items` for `line_items[*].properties`): each keeps its element bound. */
    between: { itemVar: string; tail: string }[];
}

/**
 * Is `path` a value from a list inside the step's current item
 * (`loop.result.attachments[*].attachmentId`)? Only for the step's OWN item
 * variable: a `loop.x` of an enclosing Loop is not this step's to move.
 * `taken` are other names in use (the step's parents), so the new item never
 * shadows one of them.
 */
export function nestedListPick(path: string, currentVar: string | null | undefined, taken: string[] = []): DeepenPlan | null {
    if (!currentVar || typeof path !== 'string') return null;
    const t = parse(path.trim());
    if (!t || t.length < 4 || keyOf(t[0]) !== 'loop' || t[1]?.type !== 'prop' || keyOf(t[1]) !== currentVar) return null;
    const rel = t.slice(2);
    let last = -1;
    rel.forEach((tok, i) => { if (isWild(tok)) last = i; });
    // No list, or the item itself is the list (`loop.batch[*]`): nothing to move into.
    if (last <= 0) return null;
    const listTokens = rel.slice(0, last);
    if (isWild(listTokens[0])) return null;
    const names = [currentVar, ...taken];
    const between: { itemVar: string; tail: string }[] = [];
    listTokens.forEach((tok, i) => {
        if (!isWild(tok)) return;
        const name = uniqueItemVar(suggestItemVar(lastKeyOf(listTokens.slice(0, i))), names);
        names.push(name);
        between.push({ itemVar: name, tail: relText(listTokens.slice(0, i)) });
    });
    const itemVar = uniqueItemVar(suggestItemVar(lastKeyOf(listTokens)), names);
    return { fromVar: currentVar, listTail: relText(listTokens), fieldTail: suffixText(rel.slice(last + 1)), itemVar, between };
}

/** `loop.<fromVar>` + the list it moves to: the inner list, flattened, at design time. */
export function innerListPath(plan: DeepenPlan): string {
    return joinRel(`loop.${plan.fromVar}`, plan.listTail);
}

/**
 * Does each element the overRef yields come from SPREADING a list (so the
 * next level needs its own `[*]`)? `orders[*].line_items` yields line items
 * spread out of each order's list; `results[*].output` yields one record per
 * result. Decided from the data when there is some, else from what is known.
 */
function itemsAreSpread(fe: ForEachConfig, tokens: Tok[], root: unknown): boolean {
    let lastWild = -1;
    tokens.forEach((tok, i) => { if (isWild(tok)) lastWild = i; });
    if (lastWild < 0) return true;                      // a plain list: its elements need `[*]`
    if (lastWild === tokens.length - 1) return false;   // `x[*]`: already the elements
    if (root != null) {
        const lists: unknown = walkTokens(tokens.slice(0, lastWild), root);
        const rows = Array.isArray(lists) ? lists : [];
        for (const row of rows.slice(0, 50)) {
            const v: unknown = walkTokens(tokens.slice(lastWild + 1), row);
            if (Array.isArray(v)) return true;
            if (v !== undefined) return false;
        }
    }
    // A step moved down before always ends on a list.
    if (Array.isArray(fe.parents) && fe.parents.length) return true;
    // The per-item envelope: `results[*].output` / `results[*].item` is one record per run.
    const tail = tokens.slice(lastWild + 1);
    if (tail.length === 1 && (keyOf(tail[0]) === 'output' || keyOf(tail[0]) === 'item')) return false;
    return true;
}

/**
 * The forEach that runs over the nested list, flattened across every item of
 * the current one, with the current list (and any list passed on the way
 * down) kept as a parent. `root` (the preview sample) settles how the levels
 * join when the overRef alone cannot.
 */
export function deepenedForEach(fe: ForEachConfig | null | undefined, plan: DeepenPlan, root: unknown = null): ForEachConfig {
    const over = String(fe?.overRef || '').trim();
    const overTokens = parse(over);
    const listT = relTokens(plan.listTail);
    if (!overTokens || !listT) {
        // Not a path we can read: the old textual join, no parents.
        const overRef = over.includes('[*]') ? joinRel(over, plan.listTail) : joinRel(`${over}[*]`, plan.listTail);
        return { ...(fe || {}), overRef, itemVar: plan.itemVar };
    }
    const head: Tok[] = itemsAreSpread(fe || {}, overTokens, root) ? [...overTokens, { type: 'wild' }] : overTokens;
    const overRef = formatPath([...head, ...listT]) as string;
    const before = Array.isArray(fe?.parents) ? fe.parents.filter(p => p && p.itemVar && p.overRef) : [];
    const parents: ForEachParent[] = [...before, { itemVar: fe?.itemVar || 'item', overRef: formatPath(overTokens) as string }];
    let k = 0;
    listT.forEach((tok, i) => {
        if (!isWild(tok)) return;
        const level = plan.between[k++];
        if (level) parents.push({ itemVar: level.itemVar, overRef: formatPath([...head, ...listT.slice(0, i)]) as string });
    });
    return { ...(fe || {}), overRef, itemVar: plan.itemVar, parents };
}

/**
 * The new path for a ref that reads a column of the list the step moved to
 * (`loop.result.attachments[*].filename` → `loop.attachment.filename`), or
 * null when the ref reads something else (it keeps its meaning: the old item
 * stays bound as a parent).
 */
function movedPath(tokens: Tok[], plan: DeepenPlan, listT: Tok[]): string | null {
    if (tokens.length < 3 + listT.length || keyOf(tokens[0]) !== 'loop' || keyOf(tokens[1]) !== plan.fromVar) return null;
    for (let i = 0; i < listT.length; i++) if (!sameTok(tokens[2 + i], listT[i])) return null;
    if (!isWild(tokens[2 + listT.length])) return null;
    return `loop.${plan.itemVar}${suffixText(tokens.slice(3 + listT.length))}`;
}

/**
 * The step's fields after the move. A field that read the old item keeps
 * reading it — the old item stays bound as a parent — so it is left exactly
 * as it is. A field that read a column of the list the step moved to now
 * reads that column of the new item (`moved`). `orphans` lists the fields
 * that read the old item while it can NOT be kept (the step's list is not a
 * path a parent can be taken from); the caller shows them.
 * `newItem` is accepted for callers that pass one; it is not needed.
 */
export function rebindToNewItem(
    inputs: Record<string, unknown> | null | undefined,
    plan: DeepenPlan,
    _newItem?: Record<string, unknown> | null,
    fe: ForEachConfig | null = null,
): { inputs: Record<string, unknown>; orphans: string[]; moved: string[] } {
    const listT = relTokens(plan.listTail) || [];
    const keepsParent = !fe || !!parse(String(fe.overRef || ''));
    const out: Record<string, unknown> = {};
    const moved: string[] = [];
    const orphans: string[] = [];
    for (const [slot, raw] of Object.entries(inputs || {})) {
        const r = rewriteBinding(raw, (tokens) => movedPath(tokens, plan, listT));
        out[slot] = r.value;
        if (r.changed) moved.push(slot);
        if (!keepsParent) {
            let reads = false;
            rewriteBinding(r.value, (tokens) => { if (keyOf(tokens[0]) === 'loop' && keyOf(tokens[1]) === plan.fromVar) reads = true; return null; });
            if (reads) orphans.push(slot);
        }
    }
    return { inputs: out, orphans, moved };
}

/**
 * Is `fieldValue` a copy of a value the item itself carries (an attachment's
 * `messageId` is its email's `id`)? Then the field names the PARENT, and a
 * step that needs it should read the item, not move into the list.
 */
function echoesItem(itemSample: Record<string, unknown>, fieldValue: unknown, fieldKey: string): boolean {
    // Only values that look like an identity: a field named `…Id` / `…_id`,
    // or a long string or a large number. A short code equal to something on
    // the item ("en", 1) is a coincidence, not a link.
    const named = /^id$/i.test(fieldKey) || /[a-z0-9]I[dD]$/.test(fieldKey) || /[_-]id$/i.test(fieldKey);
    const idLike = (typeof fieldValue === 'string' && fieldValue.length >= (named ? 1 : 6))
        || (typeof fieldValue === 'number' && (named || Math.abs(fieldValue) >= 1000));
    if (!idLike) return false;
    const seen: unknown[] = [];
    const collect = (o: unknown, depth: number) => {
        if (!isRecord(o) || depth > 2) return;
        for (const v of Object.values(o)) {
            if (isRecord(v)) collect(v, depth + 1);
            else if (!Array.isArray(v)) seen.push(v);
        }
    };
    collect(itemSample, 0);
    return seen.some(v => v === fieldValue);
}

/**
 * Auto-map's version of the drag: for the still-empty `keys` of a step that
 * runs per item, a column of a list inside that item named like the key
 * (`attachmentId` → `attachments[*].attachmentId`), at any depth and for any
 * key spelling. The first key that has one wins; the shallowest list first.
 * A column that only repeats a value of the item itself (an attachment's
 * `messageId`) is no reason to move: the step needs the item there. Null
 * when there is none.
 */
export function findNestedColumn(
    keys: string[],
    itemSample: Record<string, unknown> | null | undefined,
    itemVar: string,
): { key: string; path: string; element: Record<string, unknown> } | null {
    if (!isRecord(itemSample)) return null;
    const base = `loop.${itemVar}`;
    const lists = listSources(itemSample, base)
        .filter(s => s.path !== base && isRecord(s.element))
        .sort((a, b) => (a.chain.length - b.chain.length) || (a.weight - b.weight) || (a.depth - b.depth));
    for (const key of keys) {
        const want = foldKey(key);
        for (const s of lists) {
            const element = s.element as Record<string, unknown>;
            const col = Object.keys(element).find(k => foldKey(k) === want);
            if (!col || echoesItem(itemSample, element[col], col)) continue;
            return { key, path: appendKey(appendWildcard(s.path), col), element };
        }
    }
    return null;
}

/** One element of the list a plan moves to, for previews; null when the sample has none. */
export function newItemSample(plan: DeepenPlan, sampleRoot: unknown): Record<string, unknown> | null {
    const el = mergeElementSamples(getPath(sampleRoot, innerListPath(plan)));
    return isRecord(el) ? el : null;
}

