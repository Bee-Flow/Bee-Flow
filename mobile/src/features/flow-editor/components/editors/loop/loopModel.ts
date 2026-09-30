/**
 * A loop's list and its item name — the pure half of the web's LoopOverPicker
 * (Builder/mapping/LoopOverPicker.jsx): the upstream lists it can repeat over
 * (the same collectArrayPaths the source-list picker uses, so the two never
 * disagree), what picking one does to the item's name, and how a typed name
 * is kept a valid identifier.
 */

import { collectArrayPaths, previewValue, walkPath, type StepLabelMap, type VariableGroup } from '@/features/flow-editor/bindings';
import { readablePath } from '@/features/flow-editor/components/outline/readableText';
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
 * A path as a person reads it: the step's name and the field ("Search ▸
 * Results") — the words the loop's card and the canvas use (outline
 * readableText), without the ‹ › a line of text needs around them.
 */
export function friendlyPath(path: string, labels: StepLabelMap, t: Translate | null = null): string {
    return readablePath(path, labels, t).replace(/[‹›]/g, '');
}

/** The lists a loop can repeat over, each with how many items the sample holds. */
export function loopLists(groups: readonly VariableGroup[], sampleRoot: unknown, labels: StepLabelMap, t: Translate | null = null): LoopList[] {
    return collectArrayPaths([...groups], sampleRoot).map((f) => {
        const resolved = sampleRoot ? walkPath(f.path, sampleRoot) : undefined;
        const preview = Array.isArray(resolved)
            ? t
                ? t('routines.canvas.result.items', '{n} items', { n: resolved.length })
                : `${resolved.length} items`
            : previewValue(resolved !== undefined ? resolved : f.sample, 24);
        return { path: f.path, key: f.key, label: friendlyPath(f.path, labels, t), preview };
    });
}

/** Picking a list: the item takes the list's natural name unless someone already named it. */
export function pickLoopList(draft: FormDraft, path: string, suggestedVar: string): FormDraft {
    const current = typeof draft.itemVar === 'string' ? draft.itemVar : '';
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
