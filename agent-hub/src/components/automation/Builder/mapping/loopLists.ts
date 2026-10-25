/**
 * The pure half of LoopOverPicker: which lists a Loop / per-item step may
 * repeat over, and what picking one does to the step.
 */
import { getPath } from '@shared/expr/path.mjs';
import { groupListSources, mergeElementSamples } from './deepFields';
import { rebaseForEach } from './deepenForEach';
import type { ForEachParent } from './deepenForEach';
import { collectArrayPaths } from './upstream';
import { lastPathKey } from './upstream/loops';
import type { Group } from './upstream/upstream.types';

export interface LoopListChoice { key: string; path: string; sample: unknown }

/**
 * Every list the step may run over: the upstream lists at any depth (a Stripe
 * event's `data.object.lines.data`, Graph's `value` inside a JSON text body),
 * never the step's OWN item (`loop.<itemVar>` and the outer items it keeps):
 * that does not exist yet when the list is read, so a forEach over it always
 * ran zero times.
 */
export function loopListChoices(groups: Group[] | null | undefined, previewSample: unknown): LoopListChoice[] {
    const usable = (groups || []).filter(g => !g.ownItem);
    const out: LoopListChoice[] = [];
    const seen = new Set<string>();
    const collect = collectArrayPaths;
    for (const f of collect(usable, previewSample)) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        out.push({ key: f.key, path: f.path, sample: f.sample });
    }
    for (const g of usable) {
        for (const s of groupListSources(g)) {
            if (seen.has(s.path) || s.path === g.basePath) continue;
            seen.add(s.path);
            out.push({ key: s.key || lastPathKey(s.path), path: s.path, sample: s.element == null ? [] : [s.element] });
        }
    }
    return out;
}

export interface LoopScope { overRef: string; itemVar: string; parents?: ForEachParent[] }
export interface LoopListPick<T> {
    patch: { overRef: string; itemVar: string; parents: ForEachParent[] | undefined };
    /** The step's fields after the move; undefined when they need no change (or cannot be rebound). */
    bindings: T | undefined;
    note: { item: string; kept: string | null; moved: string[]; orphans: string[] } | null;
}

/**
 * Point the step at `path`. With `bindings` (its inputs, or a Loop's body —
 * `container`) the fields follow (deepenForEach.rebaseForEach). Without them a named item
 * keeps its name — renaming it would leave every field reading nothing — and
 * the validator flags a field the new item does not have.
 */
export function pickLoopList<T>(
    scope: LoopScope,
    choice: { path: string; sample?: unknown },
    { previewSample = null, bindings, container = false, definition = null }: { previewSample?: unknown; bindings?: T; container?: boolean; definition?: unknown } = {},
): LoopListPick<T> {
    // Plain strings too: a step's prompt or title is text with `{{ }}` in it.
    const r = rebaseForEach(scope, { path: choice.path, element: elementFor(choice, previewSample) }, bindings ?? ({} as T), { strings: true, container, definition });
    const canRebind = bindings !== undefined;
    const keepsOld = (r.forEach.parents || []).some(p => p.itemVar === scope.itemVar);
    const itemVar = canRebind || keepsOld || !isNamed(scope.itemVar) ? r.forEach.itemVar : scope.itemVar;
    const patch = { overRef: r.forEach.overRef, itemVar, parents: r.forEach.parents };
    if (patch.overRef === scope.overRef) return { patch, bindings: undefined, note: null };
    const { rebound, moved, orphans } = reboundParts(canRebind, r, bindings);
    return { patch, bindings: rebound, note: { item: itemVar, kept: keepsOld ? scope.itemVar : null, moved, orphans } };
}

/** What the field rebinding changed: the new bindings (undefined when untouched), what moved, and what could not. */
function reboundParts<T>(canRebind: boolean, r: { bindings: T; moved: string[]; orphans: string[] }, bindings: T | undefined) {
    if (!canRebind) return { rebound: undefined, moved: [] as string[], orphans: [] as string[] };
    return { rebound: r.bindings !== bindings ? r.bindings : undefined, moved: r.moved, orphans: r.orphans };
}

const isNamed = (v: string | undefined) => !!v && v !== 'item';

/** One element of the picked list: from the preview data when it resolves, else from the choice's sample. */
function elementFor(choice: { path: string; sample?: unknown }, previewSample: unknown): unknown {
    const fromRoot = previewSample ? getPath(previewSample, choice.path) : undefined;
    const list = Array.isArray(fromRoot) ? fromRoot : choice.sample;
    // A column's sample may already be one element rather than the list.
    return Array.isArray(list) ? mergeElementSamples(list) : list;
}
