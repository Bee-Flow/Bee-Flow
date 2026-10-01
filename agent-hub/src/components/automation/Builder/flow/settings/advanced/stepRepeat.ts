// "Run this step separately for each item": the decisions behind the step's
// repeat setting, as plain functions over the settings draft. The section
// (StepRepeatSection.tsx) and the step header (valueSlot/RepeatNotice.tsx)
// draw them; the rewriting itself is the shared mapping core's (repeat.mjs),
// so the web, the phone and the server agree on what a repeat does to a
// step's values.
//
// Every change comes back as a PATCH of draft keys (`{ inputs, repeat, … }`),
// a key that went away as `null`, for the editor to `set` one by one. These
// functions are the only place the web editor turns a per-item run on, off,
// or onto another list; picking a value never does it on the side.

import {
    formatPath, manyItems, renameItemVar, sameSource, sourceFromPath, stopForEach, toggleRepeat,
    toggleRepeatOff, walkPath, walkSource,
} from '@shared/mapping/index.mjs';
import type { MappingSource } from '@shared/mapping/index.mjs';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { humanizeFieldKey } from '../../displayHelpers';
import { collectArrayPaths } from '../../../mapping/upstream';
import { buildPatch, extractFormState } from '../formState';

export interface LegacyForEach { overRef?: string; itemVar?: string; maxIterations?: number }
export interface StepRepeat { over: MappingSource; max?: number }

/**
 * The settings draft of a step (flow/settings/formState.js). `forEach` and
 * `repeat` are read through forEachOf / repeatOf: a draft is whatever the
 * step held, so neither is trusted to have its shape.
 */
export type Draft = Record<string, unknown>;

export function forEachOf(draft: Draft | null | undefined): LegacyForEach | null {
    const fe = draft?.forEach;
    return fe && typeof fe === 'object' && !Array.isArray(fe) ? fe as LegacyForEach : null;
}

export function repeatOf(draft: Draft | null | undefined): StepRepeat | null {
    const r = draft?.repeat as StepRepeat | null | undefined;
    return r && typeof r === 'object' && r.over && typeof r.over === 'object' ? r : null;
}

export type Patch = Record<string, unknown>;

export type RepeatError = 'already_repeating' | 'legacy_for_each' | 'invalid_source';
export type RenameError = 'invalid_name' | 'name_in_use';

const renameError = (e: string): RenameError => (e === 'name_in_use' ? 'name_in_use' : 'invalid_name');

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The draft keys `after` changed, a key it no longer has (or holds as
 * undefined) as null. `type` is not a draft key.
 */
export function changedKeys(before: Draft, after: Record<string, unknown>): Patch {
    const patch: Patch = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (k === 'type') continue;
        const next = after[k] === undefined ? null : after[k];
        const prev = before[k] === undefined ? null : before[k];
        if (!same(prev, next)) patch[k] = next;
    }
    return patch;
}

/**
 * The step a draft stands for, in its STORED shape. A draft is not always
 * that: a slide keeps its chart as chartLabels / chartValues / chartData
 * (text) and its stats as one string, and the core (repeat.mjs) only knows
 * the stored fields (chart.labels, stats). Rewriting the draft as it is
 * left `loop.<old>` behind in exactly those values.
 */
const asStep = (draft: Draft, stepType: string): Record<string, unknown> => {
    const step = { type: stepType };
    return { ...draft, ...(buildPatch(step, draft) as Record<string, unknown>), ...step };
};

/**
 * What the core changed, as draft keys: the stored step before and after,
 * both read back into a draft, so whatever the round trip itself normalizes
 * is the same on both sides and only the core's own change is left.
 */
const draftPatch = (before: Record<string, unknown>, after: Record<string, unknown>): Patch => (
    changedKeys(extractFormState(before) as Draft, extractFormState(after) as Record<string, unknown>)
);

/**
 * Repeat the step over `over`. Picks of that list (and legacy refs that read
 * every item of it) start reading the current item; `each` says how many
 * values do so afterwards. Refused when the step already repeats over a
 * DIFFERENT list (`already_repeating`): one step goes per item of one list,
 * and re-pointing it would silently break the values that read the first.
 */
export function planRepeat(draft: Draft, stepType: string, over: MappingSource, max?: number):
    { patch: Patch; each: number } | { error: RepeatError } {
    const before = asStep(draft, stepType);
    const res = toggleRepeat(before, over, max === undefined ? undefined : { max });
    if ('error' in res) return { error: res.error };
    return { patch: draftPatch(before, res.step as Record<string, unknown>), each: res.each };
}

/** Stop repeating: the values that read the current item read the whole list again. */
export function planRepeatOff(draft: Draft, stepType: string): { patch: Patch } {
    const before = asStep(draft, stepType);
    const { step } = toggleRepeatOff(before);
    return { patch: draftPatch(before, step as Record<string, unknown>) };
}

/**
 * Move the repeat to another list: off over the old one, on over the new
 * one. Only the section does this, where the author picks the list itself.
 */
export function planRepeatSwitch(draft: Draft, stepType: string, over: MappingSource):
    { patch: Patch; each: number } | { error: RepeatError } {
    const current = repeatOf(draft)?.over;
    if (!current || sameSource(current, over)) return planRepeat(draft, stepType, over, repeatOf(draft)?.max);
    const before = asStep(draft, stepType);
    const { step: off } = toggleRepeatOff(before);
    const res = toggleRepeat(off, over, { max: repeatOf(draft)?.max ?? undefined });
    if ('error' in res) return { error: res.error };
    return { patch: draftPatch(before, res.step as Record<string, unknown>), each: res.each };
}

/** A legacy "run once per item" off; `orphaned` when some values cannot follow (texts, formulas). */
export function planForEachOff(draft: Draft, stepType: string): { patch: Patch; orphaned: boolean } {
    const before = asStep(draft, stepType);
    const res = stopForEach(before);
    return { patch: draftPatch(before, res.step as Record<string, unknown>), orphaned: !!res.orphaned?.length };
}

/**
 * A legacy forEach pointed at another list and/or its item renamed. A rename
 * rewrites every `loop.<old>` this step reads, so its values keep their item.
 */
export function planForEachChange(draft: Draft, stepType: string, change: { overRef?: string; itemVar?: string }):
    { patch: Patch } | { error: RenameError } {
    const fe = forEachOf(draft) || {};
    const before = asStep(draft, stepType);
    const stored = (before.forEach || null) as LegacyForEach | null;
    let step: Record<string, unknown> = { ...before, forEach: { ...fe, ...stored, ...('overRef' in change ? { overRef: change.overRef } : null) } };
    const from = fe.itemVar || 'item';
    if (change.itemVar !== undefined && change.itemVar !== from) {
        const res = renameItemVar(step, change.itemVar);
        if ('error' in res) return { error: renameError(res.error) };
        step = res.step as Record<string, unknown>;
    }
    return { patch: draftPatch(before, step) };
}

/** A loop step's item renamed, with every `loop.<old>` in its body. */
export function planLoopItemRename(draft: Draft, itemVar: string): { patch: Patch } | { error: RenameError } {
    const res = renameItemVar({ ...draft, type: 'loop' }, itemVar);
    if ('error' in res) return { error: renameError(res.error) };
    return { patch: changedKeys(draft, res.step as Record<string, unknown>) };
}

// ── words ────────────────────────────────────────────────────────────────

type StepLabels = Map<string, string> | null | undefined;

/** "Order lines from Get orders": the list a step repeats over, in the author's words. */
export function listLabel(source: MappingSource | null, stepLabelById: StepLabels, t: TranslateFn): string {
    if (!source) return t('mapping.repeat.a_list', 'a list');
    const keys = source.path.filter((s): s is string => typeof s === 'string');
    const last = keys[keys.length - 1];
    const list = last ? humanizeFieldKey(last) : t('mapping.repeat.everything', 'everything');
    if (source.root === 'steps') {
        const step = stepLabelById?.get(source.id) || humanizeFieldKey(source.id);
        return t('mapping.repeat.list_from_step', '{list} from {step}', { list, step });
    }
    if (source.root === 'trigger' || source.root === 'run') return t('mapping.repeat.list_from_trigger', '{list} from the trigger', { list });
    if (source.root === 'loop') return t('mapping.repeat.list_of_item', '{list} of the current item', { list });
    return list;
}

/** The list a legacy forEach names, as a Source (null when it names none). */
export function legacySource(overRef: unknown): MappingSource | null {
    return sourceFromPath(overRef) as MappingSource | null;
}

/** How many items the step would run for on the sample in hand, or null. */
export function repeatCount(draft: Draft, previewSample: unknown): number | null {
    if (!previewSample) return null;
    const over = repeatOf(draft)?.over;
    if (over) {
        const { items } = manyItems(walkSource(over as never, previewSample as object));
        return items.length || null;
    }
    const overRef = forEachOf(draft)?.overRef;
    if (typeof overRef === 'string' && overRef) {
        const list = walkPath(overRef, previewSample);
        return Array.isArray(list) ? list.length : null;
    }
    return null;
}

/** Why an item name was not taken, in the author's words. */
export function renameRefusal(error: RenameError, t: TranslateFn): string {
    return error === 'name_in_use'
        ? t('mapping.repeat.item_name_in_use', 'Another item is already called that here. Choose a different name.')
        : t('mapping.repeat.item_name_invalid', 'A name uses letters, digits and _ only, and does not start with a digit.');
}

/** A refusal in the author's words. */
export function repeatRefusal(error: RepeatError, current: string, t: TranslateFn): string {
    if (error === 'already_repeating') return t('mapping.repeat.refused_already', 'This step already runs separately for each item in {list}.', { list: current });
    if (error === 'legacy_for_each') return t('mapping.repeat.refused_legacy', 'This step already runs once per item the older way. Turn that off first.');
    return t('mapping.repeat.refused_invalid', 'That list cannot be repeated over.');
}

// ── which lists ───────────────────────────────────────────────────────────

interface UpstreamField { key: string; path: string; sample?: unknown; perIteration?: boolean }
interface UpstreamGroup { id: string; basePath?: string; forEach?: boolean; fields?: UpstreamField[] }

export interface RepeatChoice { key: string; path: string; source: MappingSource }

/**
 * The lists this step could repeat over, nearest step first: every list an
 * earlier step hands on, and the entries of a step that itself ran per item
 * (its `results`). A per-item column of such a step is not a list anybody
 * means, and the step's own current item is not offered.
 */
export function repeatChoices(groups: UpstreamGroup[], previewSample: unknown): RepeatChoice[] {
    const own = (g: UpstreamGroup) => /__foreach$/.test(g.id);
    const usable = (groups || []).filter(g => !own(g));
    const columns = new Set(usable.flatMap(g => (g.fields || []).filter(f => f.perIteration).map(f => f.path)));
    const out: RepeatChoice[] = [];
    const seen = new Set<string>();
    const push = (key: string, path: string) => {
        const source = legacySource(path);
        if (!source) return;
        const id = JSON.stringify(source);
        if (seen.has(id)) return;
        seen.add(id);
        out.push({ key, path, source });
    };
    // Nearest step first: the list the author just made is the likely one.
    for (const g of usable.slice().reverse()) {
        if (g.forEach && g.basePath) push('results', `${g.basePath}.results`);
        for (const f of collectArrayPaths([g] as never, previewSample as never) as UpstreamField[]) {
            if (!columns.has(f.path)) push(f.key, f.path);
        }
    }
    return out;
}

/** The path a Source is stored as in a legacy forEach (for the formula field). */
export function sourcePath(source: MappingSource | null): string {
    return (source && formatPath(source as never)) || '';
}

/** Does this draft run once per item, the new way or the older one? */
export function perItemIsSet(draft: Draft | null | undefined): boolean {
    return !!(repeatOf(draft) || forEachOf(draft));
}

/**
 * The repeat toggle offered beside a pick (PickOptions › Advanced): repeat
 * the step over the list the picked value comes from. The same rules as the
 * section, so a second, different list is refused with the sentence the
 * author reads, never re-pointed.
 */
export function repeatShortcut(draft: Draft, stepType: string, over: MappingSource, stepLabelById: StepLabels, t: TranslateFn):
    { patch: Patch; each: number } | { message: string } {
    const res = planRepeat(draft, stepType, over, repeatOf(draft)?.max);
    if ('error' in res) {
        const current = repeatOf(draft)?.over || legacySource(forEachOf(draft)?.overRef);
        return { message: repeatRefusal(res.error, listLabel(current || null, stepLabelById, t), t) };
    }
    return res;
}
