/**
 * The pure half of the "Flatten a list" editor: the draft it edits, the
 * sentences it shows and the patches its controls write. Every count and
 * every column comes from the shared engine (`@shared/expr/flatten.mjs`),
 * the same functions the run uses, so the editor never promises a table the
 * run will not make.
 */
import { GENERIC_KEYS, defaultParents, flattenPlan, flattenRows, flattenSentenceParts, joinKey, normalizeFlattenRoute } from '@shared/expr/flatten.mjs';
import { routeLevels, withSuffix } from '@shared/expr/nested.mjs';
import { humanizeFieldKey } from '../displayHelpers';

export type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;
export interface FlattenField { from: string; to: string; mode: 'copy' | 'fill' }
export interface FlattenParent { overRef: string; itemVar: string; auto?: boolean; fields?: FlattenField[] }
export interface FlattenDraft { arrayRef: string; parents: FlattenParent[] | null; keepEmpty: boolean; label?: string }
export interface LevelOption { path: string; key: string; itemVar: string; count: number; outerCount: number | null }
export interface Candidate { key: string; on: boolean; fill: boolean; long: boolean }

type AnyRecord = Record<string, unknown>;

const clone = (parents: unknown): FlattenParent[] | null =>
    (Array.isArray(parents) ? parents.map(p => ({ ...p, fields: Array.isArray(p?.fields) ? p.fields.map((f: FlattenField) => ({ ...f })) : p?.fields })) : null);

/** The editor's draft of a stored step (formState's extract). */
export function flattenDraft(step: AnyRecord): Omit<FlattenDraft, 'label'> {
    return { arrayRef: typeof step.arrayRef === 'string' ? step.arrayRef : '', parents: clone(step.parents), keepEmpty: !!step.keepEmpty };
}

/** The stored fields a draft writes back (formState's patch); an unplanned step stores no `parents`. */
export function flattenPatch(draft: AnyRecord | FlattenDraft): AnyRecord {
    const parents = clone(draft.parents);
    return { arrayRef: typeof draft.arrayRef === 'string' ? draft.arrayRef : '', parents: parents || undefined, keepEmpty: !!draft.keepEmpty };
}

/** The canonical route, or null while the step has no inner list yet. */
export const routeOf = (arrayRef: string): string | null => normalizeFlattenRoute(arrayRef || '');

/** The outermost list the step works through: the route up to its first `[*]`, or the bare list. */
export function outerListOf(arrayRef: string): string {
    const route = routeOf(arrayRef);
    return route ? defaultParents(route)[0]?.overRef || '' : String(arrayRef || '').trim();
}

export const depthOf = (arrayRef: string): number => { const r = routeOf(arrayRef); return r ? defaultParents(r).length : 0; };

/** The inner lists of records Simple offers as "one row per …" (D11). */
export function levelOptions(source: string, root: unknown): LevelOption[] {
    if (!source || !root) return [];
    return (routeLevels(source, root) as Array<LevelOption & { depth: number; records: boolean }>)
        .filter(l => l.depth === 1 && l.records);
}

export const sourceResolves = (source: string, root: unknown): boolean => !!source && !!root && routeLevels(source, root).length > 0;

const lower = (key: string) => humanizeFieldKey(key).toLowerCase();

/** The data's nouns: `child` ("attachment"), `children`, `parents` (outer list) and one `parent` per level. */
export function nounsOf(arrayRef: string, parents: FlattenParent[] | null) {
    const route = routeOf(arrayRef) || '';
    const parts = flattenSentenceParts({}, { arrayRef: route });
    const levels = route ? defaultParents(route) : [];
    const levelNouns = levels.map((d: FlattenParent, i: number) => lower(parents?.[i]?.itemVar || d.itemVar));
    return { child: parts.child, children: parts.children, parents: parts.parents, levelNouns };
}

/** "A, B and C". */
export function joinWords(words: string[], t: Translate): string {
    if (words.length < 2) return words.join('');
    return `${words.slice(0, -1).join(', ')} ${t('flatten_node.editor.and', 'and')} ${words[words.length - 1]}`;
}

/** The rows the run would make from the sample, with the step as drafted. */
export function sampleRows(root: unknown, draft: FlattenDraft) {
    if (!root || !routeOf(draft.arrayRef)) return null;
    return flattenRows(root, { ...draft, parents: draft.parents || undefined }, { limit: 10000 });
}

/** The fresh plan for a route from the sample, as stored `parents`. */
export const freshPlan = (root: unknown, route: string): FlattenParent[] => flattenPlan(root, route).parents as FlattenParent[];

/** The left-out long-text keys the draft does not copy after all, plus every fill entry, as the muted line's parts. */
export function leftOutParts(root: unknown, draft: FlattenDraft) {
    const route = routeOf(draft.arrayRef);
    if (!route) return { long: [] as string[], fills: [] as string[] };
    const plan = flattenPlan(root, route);
    const copied = (level: number, key: string) => (draft.parents?.[level]?.fields || []).some(f => f.from === key);
    const long = (plan.left as Array<{ level: number; key: string; reason: string }>)
        .filter(l => l.reason === 'long_text' && !copied(l.level, l.key)).map(l => l.key);
    const fills = (draft.parents || []).flatMap(p => (p.fields || []).filter(f => f.mode === 'fill').map(f => f.to));
    return { long: [...new Set(long)], fills };
}

/** "The message's Date is called Message date, because …" for every copy entry the plan had to rename (F40). */
export function clashNotes(draft: FlattenDraft, t: Translate): string[] {
    const { child, levelNouns } = nounsOf(draft.arrayRef, draft.parents);
    return (draft.parents || []).flatMap((p, level) => (p.fields || [])
        .filter(f => f.mode === 'copy' && f.to !== f.from && !GENERIC_KEYS.has(f.from.toLowerCase()))
        .map(f => t('flatten_node.editor.clash', 'The {parent}\'s {field} is called {renamed}, because each {child} has its own {field}.', {
            parent: levelNouns[level], field: humanizeFieldKey(f.from), renamed: humanizeFieldKey(f.to), child,
        })));
}

/** "Each row has the attachment's 7 fields, plus From, To, Subject and Date from its message." (F38) */
export function columnsSentence(draft: FlattenDraft, childFieldCount: number, t: Translate): string {
    const { child, levelNouns } = nounsOf(draft.arrayRef, draft.parents);
    // No sample rows yet (the step before has not run): no count to promise.
    const head = childFieldCount > 0
        ? t('flatten_node.editor.columns', 'Each row has the {child}\'s {n} fields', { child, n: childFieldCount })
        : t('flatten_node.editor.columns_own', 'Each row has the {child}\'s own fields', { child });
    const clauses = (draft.parents || []).map((p, level) => ({ level, copies: (p.fields || []).filter(f => f.mode === 'copy') }))
        .reverse()
        .filter(c => c.copies.length)
        .map(c => t('flatten_node.editor.columns_from', 'plus {fields} from its {parent}', {
            fields: joinWords(c.copies.map(f => humanizeFieldKey(f.to)), t), parent: levelNouns[c.level],
        }));
    if (clauses.length) return `${head}, ${clauses.join(', ')}.`;
    const nearest = levelNouns[levelNouns.length - 1] || '';
    return `${head}. ${t('flatten_node.editor.columns_nothing', 'Nothing is copied from its {parent}.', { parent: nearest })}`;
}

/** Whether a label is still one the editor wrote, so a level change may rename it. */
export function isDefaultLabel(label: string | undefined, arrayRef: string, t: Translate): boolean {
    const text = String(label || '').trim();
    if (!text || text === 'Flatten a list' || text === t('automations.node.flatten.defaultLabel', 'Flatten a list')) return true;
    const { child } = nounsOf(arrayRef, null);
    return !!child && (text === `One row per ${child}` || text === t('flatten_node.card.title', 'One row per {child}', { child }));
}

/** Picking a route (a level, or a source): the route, a fresh auto plan, and a new label while the old one is a default (F37). */
export function routePatch(draft: FlattenDraft, path: string, root: unknown, t: Translate): Partial<FlattenDraft> {
    const route = routeOf(path);
    if (!route) return { arrayRef: path, parents: null };
    const patch: Partial<FlattenDraft> = { arrayRef: route, parents: freshPlan(root, route) };
    if (isDefaultLabel(draft.label, draft.arrayRef, t)) {
        patch.label = t('flatten_node.card.title', 'One row per {child}', { child: nounsOf(route, null).child });
    }
    return patch;
}

/** A source list picked in Simple: its first inner list of records when it has one, else the bare list. */
export function sourcePatch(draft: FlattenDraft, source: string, root: unknown, t: Translate): Partial<FlattenDraft> {
    const first = levelOptions(source, root)[0];
    return routePatch(draft, first ? first.path : source, root, t);
}

/** The level's ticks (F42): every planned key, then every candidate and long-text key not planned. */
export function candidatesOf(root: unknown, draft: FlattenDraft, level: number): Candidate[] {
    const route = routeOf(draft.arrayRef);
    if (!route) return [];
    const plan = flattenPlan(root, route);
    const stored = draft.parents?.[level]?.fields || [];
    const out: Candidate[] = stored.map(f => ({ key: f.from, on: true, fill: f.mode === 'fill', long: false }));
    const seen = new Set(out.map(c => c.key));
    const add = (key: string, long: boolean) => { if (!seen.has(key)) { seen.add(key); out.push({ key, on: false, fill: false, long }); } };
    for (const f of (plan.parents[level]?.fields || []) as FlattenField[]) add(f.from, false);
    for (const l of plan.left as Array<{ level: number; key: string; reason: string }>) if (l.level === level && l.reason === 'long_text') add(l.key, true);
    return out;
}

/** One key ticked on or off at one level; any change by hand ends `auto` (F42). */
export function toggleField(draft: FlattenDraft, level: number, key: string, on: boolean, childKeys: string[]): FlattenParent[] {
    const parents = clone(draft.parents) || [];
    const p = parents[level];
    if (!p) return parents;
    const fields = (p.fields || []).filter(f => f.from !== key);
    if (on) {
        const taken = new Set([...childKeys, ...parents.flatMap(x => (x.fields || []).map(f => f.to))]);
        const base = GENERIC_KEYS.has(key.toLowerCase()) ? joinKey(p.itemVar, key) : key;
        const first = taken.has(base) && base === key ? joinKey(p.itemVar, key) : base;
        fields.push({ from: key, to: withSuffix(first, (k: string) => taken.has(k)), mode: 'copy' });
    }
    parents[level] = { ...p, auto: false, fields };
    return parents;
}

/** Plan fields for a level that has none, and append new candidates to an auto level (F6, F43). */
export function refreshPlan(root: unknown, draft: FlattenDraft): { parents: FlattenParent[]; added: string[] } | null {
    const route = routeOf(draft.arrayRef);
    if (!route || !root) return null;
    const levels = defaultParents(route).length;
    const prior = draft.parents && draft.parents.length === levels ? draft.parents : null;
    if (prior && prior.every(p => Array.isArray(p.fields) && p.auto === false)) return null;
    const next = flattenPlan(root, route, { prior }).parents as FlattenParent[];
    if (!next.some(p => p.fields?.length)) return null;
    const merged = next.map((p, i) => (prior?.[i]?.auto === false && Array.isArray(prior[i].fields) ? prior[i] : p));
    const before = new Set((prior || []).flatMap(p => (p.fields || []).map(f => f.from)));
    const added = merged.flatMap(p => (p.fields || []).filter(f => !before.has(f.from)).map(f => f.from));
    const hadFields = !!prior && prior.every(p => Array.isArray(p.fields));
    if (hadFields && !added.length) return null;
    return { parents: merged, added: hadFields ? added : [] };
}

/** The distinct own keys of the sample's child rows (the "{n} fields" of F38). */
export function childKeysOf(rows: AnyRecord[] | undefined, draft: FlattenDraft): string[] {
    const planned = new Set((draft.parents || []).flatMap(p => (p.fields || []).filter(f => f.mode === 'copy').map(f => f.to)));
    const keys = new Set<string>();
    for (const row of rows || []) for (const k of Object.keys(row)) if (!planned.has(k)) keys.add(k);
    return [...keys];
}

/** Whether the outer list's step has a run or a pinned sample (the counts say "last run"). */
export function sampleFromRunOf(groups: Array<{ basePath?: string; hasRealData?: boolean }> | null | undefined, arrayRef: string): boolean {
    const outer = outerListOf(arrayRef);
    return (groups || []).some(g => !!g.hasRealData && !!g.basePath && outer.startsWith(g.basePath));
}
