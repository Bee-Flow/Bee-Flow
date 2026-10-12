/**
 * "Flatten a list" on the phone, pure: which inner lists a source offers,
 * the words its sentences need, and the draft after a pick. Every plan is
 * written by the shared `flattenPlan` (vendor/flatten.mjs), so the columns the
 * phone stores are the ones the server and the web would store for the same
 * sample. The spec (lists.ts) only wires these to fields.
 */

import type { FormDraft } from '@/features/flow-editor/formState';
import { flattenLevels, flattenNoun, flattenRouteFields, flattenSourceRef, humanizeFieldKey } from '@/features/flow-editor/model';
import {
    childNounOf,
    flattenPlan,
    lastKey,
    nestedRows,
    normalizeFlattenRoute,
    routeLevels,
    splitRoute,
    type FlattenField,
    type FlattenParent,
} from '@/shared/expr';

type Translate = (key: string, fallback: string, params?: Record<string, string | number>) => string;

/** A data key in words, lower case ("attachments", "line items"). */
export const noun = flattenNoun;

/** The stored route, canonical, or '' while no inner list is picked. */
export function routeOf(draft: FormDraft): string {
    return normalizeFlattenRoute(draft.arrayRef) || '';
}

/** The outermost list the step works through (a bare list while no level is picked). */
export const sourceOf = (draft: FormDraft): string => flattenSourceRef(draft);

/** The inner lists of records one level down: what "One row per" can offer (F36). */
export const levelChoices = flattenLevels;

/** The source resolves to a list of items in the sample (so "no inner list" can be said). */
export function sourceHasItems(source: string, root: unknown): boolean {
    const top = source ? routeLevels(source, root)[0] : undefined;
    return !!top && top.count > 0;
}

/** The route is exactly one level deep (the chooser offers only those). */
export const oneDeep = (route: string): boolean => splitRoute(route)?.levels === 1;

function parentsOf(draft: FormDraft): FlattenParent[] {
    return Array.isArray(draft.parents) ? (draft.parents as FlattenParent[]) : [];
}

/** The level nearest the rows: the one the columns sentence and the chips talk about. */
export function nearest(draft: FormDraft): FlattenParent | null {
    const list = parentsOf(draft);
    return list.length ? (list[list.length - 1] as FlattenParent) : null;
}

/** The nouns of the sentences: "messages", "message", "attachments", "attachment". */
export function nouns(draft: FormDraft): { parents: string; parent: string; children: string; child: string } {
    const route = routeOf(draft);
    const source = sourceOf(draft);
    const near = nearest(draft);
    const childKey = route ? lastKey(route) : '';
    return {
        parents: noun(source ? lastKey(source) : ''),
        parent: noun(near?.itemVar || ''),
        children: noun(childKey),
        child: route ? noun(childNounOf(route)) : '',
    };
}

/** A "One row per" option: the singular of its inner list, as the web labels it ("Attachment"). */
export const levelLabel = (path: string): string => humanizeFieldKey(childNounOf(path));

/** The draft with a new route, its plan made afresh (`auto: true`, F37) and a default label renamed. */
export function withRoute(draft: FormDraft, route: string, root: unknown): FormDraft {
    const fields = flattenRouteFields(draft, route, root);
    return fields ? { ...draft, ...fields } : { ...draft, arrayRef: route, parents: [] };
}

/** A new outer list: its first inner list of records, else the bare list (F45, `level_missing`). */
export function withSource(draft: FormDraft, source: unknown, root: unknown): FormDraft {
    const path = typeof source === 'string' ? source.trim() : '';
    if (normalizeFlattenRoute(path)) return withRoute(draft, path, root);
    const first = levelChoices(path, root)[0];
    return first ? withRoute(draft, first.path, root) : { ...draft, arrayRef: path, parents: [] };
}

/** Empty parents in the sample, and how many parents there are (F39). */
export function emptyParents(draft: FormDraft, root: unknown): { emptyCount: number; outerCount: number } {
    const route = routeOf(draft);
    const rows = route ? nestedRows(root, route) : null;
    return rows ? { emptyCount: rows.emptyCount, outerCount: rows.inputCount } : { emptyCount: 0, outerCount: 0 };
}

/** "A, B and C" with the dictionary's "and". */
export function joinWords(words: readonly string[], t: Translate): string {
    if (words.length < 2) return words[0] ?? '';
    const and = t('flatten_node.editor.and', 'and');
    return `${words.slice(0, -1).join(', ')} ${and} ${words[words.length - 1]}`;
}

const copies = (fields: readonly FlattenField[] | undefined) => (fields ?? []).filter((f) => f.mode === 'copy');
const fills = (fields: readonly FlattenField[] | undefined) => (fields ?? []).filter((f) => f.mode === 'fill');

/** How many fields the child rows carry in the sample (the "{n} fields" of F38). */
function childFieldCount(draft: FormDraft, root: unknown): number {
    const route = routeOf(draft);
    const rows = route ? nestedRows(root, route, { limit: 200 }) : null;
    const keys = new Set<string>();
    for (const r of rows?.rows ?? []) {
        if (r.item && typeof r.item === 'object' && !Array.isArray(r.item)) Object.keys(r.item).forEach((k) => keys.add(k));
    }
    return keys.size;
}

/** F38: "Each row has the attachment's 7 fields, plus From, To, Subject and Date from its message." */
export function columnsSentence(draft: FormDraft, root: unknown, t: Translate): string {
    if (!routeOf(draft)) return '';
    const n = nouns(draft);
    const count = childFieldCount(draft, root);
    const head = count > 0
        ? t('flatten_node.editor.columns', "Each row has the {child}'s {n} fields", { child: n.child, n: count })
        : t('flatten_node.editor.columns_own', "Each row has the {child}'s own fields", { child: n.child });
    const levels = [...parentsOf(draft)].reverse();
    const clauses = levels
        .map((level) => ({ level, names: copies(level.fields).map((f) => humanizeFieldKey(f.to)) }))
        .filter((c) => c.names.length)
        .map((c) => t('flatten_node.editor.columns_from', 'plus {fields} from its {parent}', { fields: joinWords(c.names, t), parent: noun(c.level.itemVar) }));
    if (!clauses.length) return `${head}. ${t('flatten_node.editor.columns_nothing', 'Nothing is copied from its {parent}.', { parent: n.parent })}`;
    return `${head}, ${clauses.join(', ')}.`;
}

/** The muted line under F38: what was left out, and what already comes with each child. */
export function columnsNote(draft: FormDraft, root: unknown, t: Translate): string {
    const route = routeOf(draft);
    if (!route) return '';
    const n = nouns(draft);
    const plan = flattenPlan(root, route);
    const copied = (level: number, key: string) => (parentsOf(draft)[level]?.fields ?? []).some((f) => f.from === key);
    const longs = plan.left
        .filter((l) => l.reason === 'long_text' && !copied(l.level, l.key))
        .map((l) => `${humanizeFieldKey(l.key)} (${t('flatten_node.editor.reason_long', 'long text')})`);
    const filled = parentsOf(draft).flatMap((p) => fills(p.fields)).map((f) => humanizeFieldKey(f.to));
    const parts = [
        longs.length ? t('flatten_node.editor.left_out', 'Left out: {fields}.', { fields: joinWords(longs, t) }) : '',
        filled.length ? t('flatten_node.editor.already_on', '{fields} already come with each {child}.', { fields: joinWords(filled, t), child: n.child }) : '',
    ];
    return parts.filter(Boolean).join(' ');
}

/** One chip per field the nearest level may copy (F42 as chips). */
export interface FieldChip {
    key: string;
    reason: 'copy' | 'fill' | 'long_text';
}

/** Every key the nearest level offers: planned copies and fills, the candidates not picked, and the long text. */
export function fieldChips(draft: FormDraft, root: unknown): FieldChip[] {
    const route = routeOf(draft);
    if (!route) return [];
    const plan = flattenPlan(root, route);
    const last = plan.parents.length - 1;
    const out = new Map<string, FieldChip['reason']>();
    for (const f of nearest(draft)?.fields ?? []) out.set(f.from, f.mode);
    for (const f of plan.parents[last]?.fields ?? []) if (!out.has(f.from)) out.set(f.from, f.mode);
    for (const l of plan.left) if (l.level === last && l.reason === 'long_text' && !out.has(l.key)) out.set(l.key, 'long_text');
    return [...out].map(([key, reason]) => ({ key, reason }));
}

/** The keys copied today: the chips that are on. */
export function copiedKeys(draft: FormDraft): string[] {
    return (nearest(draft)?.fields ?? []).map((f) => f.from);
}

/** The draft after the chips change: kept entries stay as they are, new ones are named by the plan; `auto: false`. */
export function withKeptFields(draft: FormDraft, keys: unknown, root: unknown): FormDraft {
    const route = routeOf(draft);
    const list = parentsOf(draft);
    const near = nearest(draft);
    if (!route || !near) return draft;
    const chosen = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
    const planned = flattenPlan(root, route, { keepFields: chosen }).parents.at(-1)?.fields ?? [];
    const byFrom = new Map((near.fields ?? []).map((f) => [f.from, f]));
    const fields: FlattenField[] = [];
    for (const key of chosen) {
        const entry = byFrom.get(key) ?? planned.find((f) => f.from === key);
        if (entry && !fields.some((f) => f.to === entry.to)) fields.push(entry);
    }
    for (const f of planned) if (f.mode === 'fill' && !fields.some((x) => x.from === f.from)) fields.push(f);
    const parents = [...list.slice(0, -1), { ...near, auto: false, fields }];
    return { ...draft, parents };
}
