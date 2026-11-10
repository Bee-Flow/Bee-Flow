/**
 * App Studio builder: a rejected call that used an extension item gets that item's full
 * catalogue entry in its `_fixHint`.
 *
 * The prompt only indexes the entries marked since 3 (builderPrompt/extensionIndex.mts) and
 * asks the model to read the full entry first. A model that skipped that step and got the shape
 * wrong would need a second round to look it up; with the entry in the rejection it can resend
 * the corrected call at once.
 *
 * Which item made the call fail is not known here, so every extension item the rejected call (or
 * the rejected entry of a batch) names is answered, up to a cap. Nothing is added while the
 * catalogue has no extension entry, or when the call names none.
 */

import { extensionItems } from '../catalogTiers.mts';
import type { ExtensionItem } from '../catalogTiers.mts';
import { renderExtensionEntry } from '../builderPrompt/extensionIndex.mts';

type Json = Record<string, unknown>;

/** tool name → the argument that holds its batch form. */
const HINTED_TOOLS: Readonly<Record<string, string>> = Object.freeze({
    app_add_components: 'components',
    app_update_component: 'updates',
    app_set_action: 'actions',
});

const MAX_ENTRIES = 4;
const MAX_ENTRY_CHARS = 3000;
const MAX_DEPTH = 12;
const MAX_VISITS = 4000;

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

interface Lookup {
    types: Map<string, ExtensionItem>;
    kinds: Map<string, ExtensionItem[]>;
    /** `${ownerTable}:${owner}` → field name → the field item and its value items. */
    owned: Map<string, Map<string, ExtensionItem[]>>;
}

function buildLookup(items: readonly ExtensionItem[]): Lookup {
    const lookup: Lookup = { types: new Map(), kinds: new Map(), owned: new Map() };
    for (const item of items) {
        const field = item.key;
        if (item.family === 'componentTypes') lookup.types.set(item.name, item);
        else if (item.family === 'stepKinds' || item.family === 'actionKinds' || item.family === 'bindingKinds') {
            lookup.kinds.set(item.name, [...(lookup.kinds.get(item.name) || []), item]);
        } else if (item.ownerTable && field) {
            const owner = `${item.ownerTable}:${item.owner || ''}`;
            const byField = lookup.owned.get(owner) || new Map<string, ExtensionItem[]>();
            byField.set(field, [...(byField.get(field) || []), item]);
            lookup.owned.set(owner, byField);
        }
    }
    return lookup;
}

/** The items `holder` uses of the fields `owner` has in the extension tier. */
function ownedHits(lookup: Lookup, owner: string, holder: unknown, found: Set<ExtensionItem>): void {
    const byField = lookup.owned.get(owner);
    if (!byField || !isObject(holder)) return;
    for (const [field, items] of byField) {
        if (!Object.hasOwn(holder, field)) continue;
        for (const item of items) {
            // A field item matches by its name; a value item only when that value is what was sent.
            if (item.value === undefined || String(holder[field]) === item.value) found.add(item);
        }
    }
}

function visit(node: unknown, lookup: Lookup, found: Set<ExtensionItem>, budget: { left: number }, depth: number): void {
    if (depth > MAX_DEPTH || budget.left <= 0) return;
    budget.left -= 1;
    if (Array.isArray(node)) {
        for (const child of node) visit(child, lookup, found, budget, depth + 1);
        return;
    }
    if (!isObject(node)) return;
    if (typeof node.type === 'string') {
        const type = lookup.types.get(node.type);
        if (type) found.add(type);
        ownedHits(lookup, `component:${node.type}`, node.props, found);
    }
    if (typeof node.kind === 'string') {
        for (const item of lookup.kinds.get(node.kind) || []) found.add(item);
        ownedHits(lookup, `step:${node.kind}`, node, found);
        ownedHits(lookup, `action:${node.kind}`, node, found);
    }
    ownedHits(lookup, 'knob:', node.style, found);
    for (const child of Object.values(node)) visit(child, lookup, found, budget, depth + 1);
}

/** The type of the component `id` in the draft, for a patch that names no type. */
function typeOfNode(def: unknown, id: unknown): string | null {
    if (typeof id !== 'string' || !id) return null;
    const budget = { left: MAX_VISITS };
    const search = (node: unknown): string | null => {
        if (budget.left <= 0) return null;
        budget.left -= 1;
        if (Array.isArray(node)) {
            for (const child of node) {
                const hit = search(child);
                if (hit) return hit;
            }
            return null;
        }
        if (!isObject(node)) return null;
        if (node.id === id) return typeof node.type === 'string' ? node.type : null;
        return search(node.children) || search(node.sections);
    };
    return search(isObject(def) ? def.screens : null);
}

function usedItems(args: unknown, def: unknown, lookup: Lookup): ExtensionItem[] {
    const found = new Set<ExtensionItem>();
    visit(args, lookup, found, { left: MAX_VISITS }, 0);
    // An app_update_component patch carries { id, props, style } without the type.
    const patches = isObject(args) ? [args, ...(Array.isArray(args.updates) ? args.updates : [])] : [];
    for (const patch of patches) {
        if (!isObject(patch) || typeof patch.type === 'string') continue;
        const type = typeOfNode(def, patch.id);
        if (!type) continue;
        const item = lookup.types.get(type);
        if (item) found.add(item);
        ownedHits(lookup, `component:${type}`, patch.props, found);
    }
    return [...found];
}

function entriesText(items: ExtensionItem[]): string {
    const shown = items.slice(0, MAX_ENTRIES).map((item) => {
        const entry = renderExtensionEntry(item);
        return entry.length > MAX_ENTRY_CHARS ? `${entry.slice(0, MAX_ENTRY_CHARS)}…` : entry;
    });
    const rest = items.slice(MAX_ENTRIES).map((item) => JSON.stringify(item.name));
    const more = rest.length ? ` (+${rest.length} more: app_inspect_catalog {extensions:[${rest.join(', ')}]})` : '';
    return `Catalog entry of the newer item${shown.length > 1 ? 's' : ''} this call uses, check the call against it: ${shown.join(' | ')}${more}`;
}

function append(target: Json, items: ExtensionItem[]): void {
    if (!items.length) return;
    const before = typeof target._fixHint === 'string' && target._fixHint ? `${target._fixHint} ` : '';
    target._fixHint = `${before}${entriesText(items)}`;
}

/**
 * Add the catalogue entries to a rejected result, in place. A whole-call rejection is answered
 * on the result; a batch that partly landed on each failed entry, from that entry's own input.
 */
export function addExtensionEntries(name: string, args: unknown, result: unknown, def: unknown): void {
    const batchArg = Object.hasOwn(HINTED_TOOLS, name) ? HINTED_TOOLS[name] : null;
    if (!batchArg || !isObject(result)) return;
    const failed = Array.isArray(result.failed) ? result.failed.filter(isObject) : [];
    if (!result.error && !failed.length) return;
    const items = extensionItems();
    if (!items.length) return;
    const lookup = buildLookup(items);
    if (result.error) {
        append(result, usedItems(args, def, lookup));
        return;
    }
    const batch = isObject(args) && Array.isArray(args[batchArg]) ? args[batchArg] : [];
    for (const failure of failed) {
        const index = typeof failure.index === 'number' ? failure.index : -1;
        const entry = index >= 0 && index < batch.length ? batch[index] : args;
        append(failure, usedItems(batchArg === 'updates' ? { updates: [entry] } : entry, def, lookup));
    }
}
