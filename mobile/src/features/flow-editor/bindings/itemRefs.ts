/**
 * The references a step's fields hold to its item (`loop.result.subject`, in
 * a ref, a `{{ }}` placeholder, an expression, or a Loop body's plain
 * strings), and moving them when the step runs over another list.
 *
 * Pure; read and written with the runtime grammar (pathTokens.ts).
 *
 * Port of agent-hub `Builder/mapping/itemRefs.ts`; deepen.lockstep.test.ts holds the two together.
 */
import { formatPath, readPath, scanTemplate } from '@/shared/expr';

import { foldKey, isRecord } from './deepFields';
import { canonical, keyOf, lastKeyOf, listLevels, parse, suffixText } from './pathTokens';
import type { Tok } from './pathTokens';
import { suggestItemVar, uniqueItemVar } from './upstream/loops';

export interface ForEachParent { itemVar: string; overRef: string }
export interface ForEachConfig { overRef?: string; itemVar?: string; maxIterations?: number; parents?: ForEachParent[]; [k: string]: unknown }

export type Binding = { kind?: string; path?: string; value?: unknown };

/** Rewrite every `loop.…` path inside a text (an expression, a placeholder) that `fn` maps. */
export function rewritePathsInText(text: string, fn: (tokens: Tok[]) => string | null): string {
    let out = '';
    let i = 0;
    const re = /(^|[^A-Za-z0-9_$.\]"'])loop\./g;
    let m: RegExpExecArray | null;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- no quantifier (start or one character, then the literal loop.) and each exec resumes past the previous match: linear
    while ((m = re.exec(text)) !== null) {
        const start = m.index + (m[1] || '').length;
        const r = readPath(text, start) as { tokens: Tok[]; end: number } | null;
        if (!r) continue;
        const next = fn(r.tokens);
        if (next === null) continue;
        out += text.slice(i, start) + next;
        i = r.end;
        re.lastIndex = r.end;
    }
    return out + text.slice(i);
}

export type PathFn = (tokens: Tok[]) => string | null;
export type Rewrite = { value: unknown; changed: boolean };
export const same = (value: unknown): Rewrite => ({ value, changed: false });

function rewriteTemplate(binding: Binding & { value: string }, fn: PathFn): Rewrite {
    let changed = false;
    const parts = scanTemplate(binding.value) as { type: string; value?: string; raw?: string; inner?: string }[];
    const value = parts.map((p) => {
        if (p.type === 'text') return p.value || '';
        const inner = p.inner || '';
        const next = rewritePathsInText(inner, fn);
        if (next === inner) return p.raw || '';
        changed = true;
        return (p.raw || '').replace(inner, next);
    }).join('');
    return changed ? { value: { ...binding, value }, changed } : same(binding);
}

/** One binding, or a bare map / list of them (a Tables row's `values`), with `fn` applied to every path. */
export function rewriteBinding(b: unknown, fn: PathFn): Rewrite {
    if (Array.isArray(b) || (isRecord(b) && typeof b.kind !== 'string')) {
        let changed = false;
        const entries = Object.entries(b as object).map(([k, v]) => {
            const r = rewriteBinding(v, fn);
            changed = changed || r.changed;
            return [k, r.value] as const;
        });
        if (!changed) return same(b);
        return { value: Array.isArray(b) ? entries.map(e => e[1]) : Object.fromEntries(entries), changed };
    }
    if (!isRecord(b)) return same(b);
    const binding = b as Binding;
    if (binding.kind === 'ref' && typeof binding.path === 'string') {
        const t = parse(binding.path);
        const next = t ? fn(t) : null;
        return next === null ? same(b) : { value: { ...binding, path: next }, changed: true };
    }
    if (typeof binding.value !== 'string') return same(b);
    if (binding.kind === 'template') return rewriteTemplate(binding as Binding & { value: string }, fn);
    if (binding.kind !== 'expr') return same(b);
    const value = rewritePathsInText(binding.value, fn);
    return value === binding.value ? same(b) : { value: { ...binding, value }, changed: true };
}

/** Every string under `value` (not only bindings) with `fn` applied to its `loop.…` paths: a Loop body's conditions and titles are plain strings. */
export function rewriteStrings(value: unknown, fn: PathFn): Rewrite {
    if (typeof value === 'string') {
        const next = value.includes('loop.') ? rewritePathsInText(value, fn) : value;
        return next === value ? same(value) : { value: next, changed: true };
    }
    if (!Array.isArray(value) && !isRecord(value)) return same(value);
    const asBinding = rewriteBinding(value, fn);
    if (asBinding.changed || (isRecord(value) && typeof value.kind === 'string')) return asBinding;
    let changed = false;
    const entries = Object.entries(value as object).map(([k, v]) => {
        const r = rewriteStrings(v, fn);
        changed = changed || r.changed;
        return [k, r.value] as const;
    });
    if (!changed) return same(value);
    return { value: Array.isArray(value) ? entries.map(e => e[1]) : Object.fromEntries(entries), changed };
}

/**
 * The step now runs over a different list: point what read the old item
 * (`loop.result.subject`) at the new item where the new item has that field
 * (`loop.mail.subject`, matched in any spelling). `slots` names, per top-level
 * key of `value` (an input, or a body step by its id), what moved and what
 * has no counterpart; the latter is left as it was, so the validator and the
 * editor flag it rather than it silently reading nothing.
 * `strings: true` also rewrites plain strings (a Loop body's conditions).
 */
export function renameItemRefs<T>(
    value: T, { from: fromVar, to: toVar, element: newElement }: { from: string; to: string; element: unknown }, { strings = false }: { strings?: boolean } = {},
): { value: T; moved: string[]; orphans: string[] } {
    const keys = isRecord(newElement) ? Object.keys(newElement) : [];
    const moved = new Set<string>();
    const orphans = new Set<string>();
    let slot = '';
    const fn: PathFn = (tokens) => {
        if (keyOf(tokens[0]) !== 'loop' || keyOf(tokens[1]) !== fromVar) return null;
        const rest = tokens.slice(2);
        const first = rest[0];
        const name = typeof keyOf(first) === 'string' ? (keyOf(first) as string) : null;
        const hit = name === null ? null : keys.find(k => k === name) ?? keys.find(k => foldKey(k) === foldKey(name));
        if (first && (first.type !== 'prop' || hit == null)) { orphans.add(slot); return null; }
        const next = first ? `loop.${toVar}${suffixText([{ type: 'prop', key: hit as string }, ...rest.slice(1)])}` : `loop.${toVar}`;
        if (next === formatPath(tokens)) return null;
        moved.add(slot);
        return next;
    };
    const rewrite = (v: unknown) => (strings ? rewriteStrings(v, fn) : rewriteBinding(v, fn));
    if (!isRecord(value) && !Array.isArray(value)) return { value, moved: [], orphans: [] };
    const out = Object.entries(value as object).map(([k, v]) => {
        slot = Array.isArray(value) && isRecord(v) && typeof v.id === 'string' ? v.id : k;
        return [k, rewrite(v).value] as const;
    });
    const next = (Array.isArray(value) ? out.map(e => e[1]) : Object.fromEntries(out)) as T;
    return { value: next, moved: [...moved], orphans: [...orphans] };
}

/** Slots of `value` (top-level keys; body steps by id) that read any of `vars`. */
function slotsReading(value: unknown, vars: string[]): string[] {
    if (!vars.length || (!isRecord(value) && !Array.isArray(value))) return [];
    const out: string[] = [];
    for (const [k, v] of Object.entries(value as object)) {
        let reads = false;
        rewriteStrings(v, (t) => { if (keyOf(t[0]) === 'loop' && vars.includes(String(keyOf(t[1])))) reads = true; return null; });
        if (reads) out.push(Array.isArray(value) && isRecord(v) && typeof v.id === 'string' ? v.id : k);
    }
    return out;
}

/**
 * A per-item step (or a Loop) is pointed at another list. Returns the new
 * `{ overRef, itemVar, parents }` and the step's fields to go with it:
 *
 *   - a list INSIDE the current one (`results[*].output.attachments` while it
 *     ran over `results`) keeps the current item as a parent under its own
 *     name: every field keeps reading what it read (as in a deepen);
 *   - any other list renames the item after it, and fields that read the old
 *     item read the same-named field of the new one (`moved`); a field the new
 *     item does not have is left as it was and reported (`orphans`).
 *
 * `strings` rewrites plain strings too (a Loop body); `container` is a Loop,
 * which keeps no outer items. Pure, for Undo.
 */
export function rebaseForEach<T>(
    fe: { overRef?: string; itemVar?: string; parents?: ForEachParent[] } | null | undefined,
    { path: newPath, element: newElement }: { path: string; element: unknown },
    bindings: T,
    { strings = false, container = false }: { strings?: boolean; container?: boolean } = {},
): { forEach: { overRef: string; itemVar: string; parents: ForEachParent[] | undefined }; bindings: T; moved: string[]; orphans: string[] } {
    const old = scopeOf(fe);
    const t = parse(String(newPath || '').trim());
    const overRef = t ? (formatPath(t) as string) : newPath;
    if (!t || overRef === old.canon) return { forEach: { overRef, itemVar: old.itemVar, parents: old.given }, bindings, moved: [], orphans: [] };
    // A Loop container binds only its own item (execLoop has no parents), so
    // its body always follows the item to the new list.
    const parents = container ? [] : levelParents(t, old.canon, old.itemVar, old.parents);
    const itemVar = uniqueItemVar(suggestItemVar(lastKeyOf(t)), parents.map(p => p.itemVar));
    const keptVars = new Set([...parents.map(p => p.itemVar), itemVar]);
    // The old item kept as a parent: every field still reads what it read.
    const r = parents.some(p => p.itemVar === old.itemVar)
        ? { value: bindings, moved: [] as string[], orphans: [] as string[] }
        : renameItemRefs(bindings, { from: old.itemVar, to: itemVar, element: newElement }, { strings });
    const dropped = old.parents.map(p => p.itemVar).filter(v => !keptVars.has(v));
    const orphans = [...new Set([...r.orphans, ...slotsReading(r.value, dropped)])];
    return { forEach: { overRef, itemVar, parents: parents.length ? parents : undefined }, bindings: r.value, moved: r.moved, orphans };
}

function scopeOf(fe: { overRef?: string; itemVar?: string; parents?: ForEachParent[] } | null | undefined) {
    const parents = Array.isArray(fe?.parents) ? fe.parents : [];
    return { itemVar: fe?.itemVar || 'item', canon: canonical(String(fe?.overRef || '')), parents, given: fe?.parents };
}

/** The outer lists of a list path as parents; a level the step already ran over keeps the name it had. */
function levelParents(t: Tok[], oldCanon: string | null, oldVar: string, oldParents: ForEachParent[]): ForEachParent[] {
    const names: string[] = [];
    return listLevels(t).map((level) => {
        const kept = level === oldCanon ? oldVar : oldParents.find(p => canonical(p.overRef) === level)?.itemVar;
        const itemVar = kept && !names.includes(kept) ? kept : uniqueItemVar(suggestItemVar(lastKeyOf(parse(level) || [])), names);
        names.push(itemVar);
        return { itemVar, overRef: level };
    });
}

