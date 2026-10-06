/**
 * A loop's list and its item name — the pure half of the web's LoopOverPicker
 * (Builder/mapping/LoopOverPicker.jsx, loopLists.ts): the upstream lists it can
 * repeat over (the same collectArrayPaths the source-list picker uses, plus
 * lists at any depth), what picking one does to the item's name and to the
 * steps inside, and how a typed name is kept a valid identifier.
 */

import { collectArrayPaths, previewValue, walkPath, type StepLabelMap, type VariableGroup } from '@/features/flow-editor/bindings';
import { rebaseForEach } from '@/features/flow-editor/bindings/deepenForEach';
import { groupListSources, mergeElementSamples } from '@/features/flow-editor/bindings/deepFields';
import { listPathLabel } from '@/features/flow-editor/bindings/listPathLabel';
import { lastPathKey } from '@/features/flow-editor/bindings/upstream/loops';
import type { FormDraft } from '@/features/flow-editor/formState';
import type { Translate } from '@/features/flow-editor/model';

export interface LoopList {
    path: string;
    key: string;
    /** "Search ▸ Results", as the list reads. */
    label: string;
    /** "10 items", or a short example. */
    preview: string;
}

/**
 * A path as a person reads it: the step's name and every key on the way
 * ("Inbox ▸ Value ▸ Attachments (inside each row)"), never `[*]` or a dot —
 * the web LoopOverPicker's label (listPathLabel).
 */
export function friendlyPath(path: string, labels: StepLabelMap, t: Translate | null = null): string {
    return listPathLabel(path, labels, t as Parameters<typeof listPathLabel>[2]);
}

/**
 * The lists a loop can repeat over — at any depth, also inside JSON text —
 * never a step's own item (it does not exist yet when the list is read).
 */
function listChoices(groups: readonly VariableGroup[], sampleRoot: unknown): { path: string; key: string; sample: unknown }[] {
    const usable = groups.filter((g) => !(g as VariableGroup & { ownItem?: boolean }).ownItem);
    const out: { path: string; key: string; sample: unknown }[] = [];
    const seen = new Set<string>();
    for (const f of collectArrayPaths([...usable], sampleRoot)) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        out.push({ path: f.path, key: f.key, sample: f.sample });
    }
    for (const g of usable) {
        for (const s of groupListSources(g)) {
            if (seen.has(s.path) || s.path === g.basePath) continue;
            seen.add(s.path);
            out.push({ path: s.path, key: s.key || lastPathKey(s.path), sample: s.element == null ? [] : [s.element] });
        }
    }
    return out;
}

/** "1 item", "3 items". */
function countLabel(n: number, t: Translate | null): string {
    if (n === 1) return t ? t('automations.builder.one_item', '1 item') : '1 item';
    return t ? t('automations.canvas.result.items', '{n} items', { n }) : `${n} items`;
}

/** The lists a loop can repeat over, each with how many items the sample holds. */
export function loopLists(groups: readonly VariableGroup[], sampleRoot: unknown, labels: StepLabelMap, t: Translate | null = null): LoopList[] {
    return listChoices(groups, sampleRoot).map((f) => {
        const resolved = sampleRoot ? walkPath(f.path, sampleRoot) : undefined;
        const preview = Array.isArray(resolved) ? countLabel(resolved.length, t) : previewValue(resolved !== undefined ? resolved : f.sample, 24);
        return { path: f.path, key: f.key, label: friendlyPath(f.path, labels, t), preview };
    });
}

export interface LoopListPick {
    /** What to write: the list, the item's name and — when they had to follow — the steps inside. */
    patch: FormDraft;
    /** Steps inside that read a field the new item does not have (left as they were). */
    orphans: string[];
}

/**
 * Picking a list (the web's pickLoopList): the item takes the list's name,
 * and the steps inside that read the old item read the same-named field of
 * the new one. A list inside the current one keeps nothing to rename. Without
 * steps inside, a named item keeps its name.
 */
export function pickLoopListFull(draft: FormDraft, path: string, sampleRoot: unknown = null): LoopListPick {
    const itemVar = typeof draft.itemVar === 'string' && draft.itemVar ? draft.itemVar : 'item';
    const scope = { overRef: typeof draft.overRef === 'string' ? draft.overRef : '', itemVar };
    const body = Array.isArray(draft.body) ? (draft.body as unknown[]) : undefined;
    const fromRoot = sampleRoot ? walkPath(path, sampleRoot) : undefined;
    const element = Array.isArray(fromRoot) ? mergeElementSamples(fromRoot) : null;
    const r = rebaseForEach(scope, { path, element }, body ?? [], { strings: true, container: true });
    const keepName = !body && itemVar !== 'item';
    const patch: FormDraft = { overRef: path, itemVar: keepName ? itemVar : r.forEach.itemVar };
    if (body && r.bindings !== body) patch.body = r.bindings;
    return { patch, orphans: body ? r.orphans : [] };
}

/** Picking a list: the item takes the list's natural name unless someone already named it (no steps inside to follow). */
export function pickLoopList(draft: FormDraft, path: string, suggestedVar: string): FormDraft {
    const current = typeof draft.itemVar === 'string' ? draft.itemVar : '';
    if (Array.isArray(draft.body) && draft.body.length) return pickLoopListFull(draft, path).patch;
    return { overRef: path, itemVar: !current || current === 'item' ? suggestedVar || 'item' : current };
}

/** An item name as typed, kept an identifier; empty is `item`. */
export function sanitizeItemVar(raw: string): string {
    return typedItemVar(raw) || 'item';
}

/** The name as it is being typed: letters, digits and _ only, and empty allowed (the save stores "item"). */
export function typedItemVar(raw: string): string {
    return raw.replace(/[^A-Za-z0-9_]/g, '');
}
