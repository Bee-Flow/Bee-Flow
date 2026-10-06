import { parsePath } from '@shared/expr/path.mjs';
import { humanizeFieldKey as humanizeFieldKeyJs } from '../flow/displayHelpers';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { DataSummary } from '../flow/types';
import { isPlainObject, type PlainObject } from './valueHelpers';

const humanizeFieldKey = humanizeFieldKeyJs as (key: string) => string;

/**
 * What a Condition that worked through a list did with it, as numbers the
 * result panel says in one sentence (spec P1/P2) instead of the Count /
 * Input count / Rejected count chips:
 *  - `kept`: a filter (one output) kept `kept` of `total` items;
 *  - `split`: a list switch sent `count` items down each output, in case
 *    order, then Otherwise.
 * Pure; routeSentence turns it into words for RunNote.
 */
export type RouteNote =
    | { kind: 'kept'; kept: number; total: number }
    | { kind: 'split'; parts: RoutePart[]; total: number; fanOut: boolean };

export interface RoutePart {
    name: string;
    count: number;
    /** The catch-all output (`default`), said as "Otherwise". */
    otherwise: boolean;
}

export interface RouteNoteOptions {
    /** The step's output names in the order its cases are written. */
    caseOrder?: string[];
    /** `matchMode: 'all'`: one item can go down several outputs. */
    fanOut?: boolean;
}

/** What RunNote needs from the step to say a route note: the unit and the outputs. */
export interface RouteContext extends RouteNoteOptions {
    /** "messages", "attachments", or "items" when unknown (P3). */
    unit: string;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** A filter's output: `{ items, inputCount, rejectedCount }`. */
function keptNote(o: PlainObject): RouteNote | null {
    if (!Array.isArray(o.items) || !isCount(o.inputCount) || !isCount(o.rejectedCount)) return null;
    // From the counts, not items.length: a stored output may hold a cut list.
    return { kind: 'kept', kept: Math.max(0, o.inputCount - o.rejectedCount), total: o.inputCount };
}

/** Per output: `counts`, else the length of each `matchesByCase` list. */
function countsOf(o: PlainObject): Record<string, number> | null {
    if (isPlainObject(o.counts)) {
        const entries = Object.entries(o.counts).filter(([, n]) => isCount(n)) as Array<[string, number]>;
        return Object.fromEntries(entries);
    }
    if (isPlainObject(o.matchesByCase)) {
        const entries = Object.entries(o.matchesByCase).filter(([, v]) => Array.isArray(v));
        return Object.fromEntries(entries.map(([k, v]) => [k, (v as unknown[]).length]));
    }
    return null;
}

/** A list switch's output: `{ mode: 'collection', counts | matchesByCase, total }`. */
function splitNote(o: PlainObject, { caseOrder = [], fanOut = false }: RouteNoteOptions): RouteNote | null {
    if (o.mode !== 'collection' || !isCount(o.total)) return null;
    const counts = countsOf(o);
    if (!counts) return null;
    const names = [...caseOrder.filter(n => n !== 'default'), ...Object.keys(counts).filter(n => n !== 'default' && !caseOrder.includes(n))];
    const parts: RoutePart[] = names.map(name => ({ name, count: counts[name] ?? 0, otherwise: false }));
    if (counts.default !== undefined) parts.push({ name: 'default', count: counts.default, otherwise: true });
    return { kind: 'split', parts, total: o.total, fanOut };
}

/** The route note of a step's recorded output, or null when it is not a filter or list-switch output. */
export function routeNoteOf(value: unknown, options: RouteNoteOptions = {}): RouteNote | null {
    if (!isPlainObject(value)) return null;
    return keptNote(value) ?? splitNote(value, options);
}

/**
 * The last named key of a list path, after the step's `output`:
 * `steps.r.output.messages[*].attachments` → "attachments". Null when the
 * path names no key of its own (a step's whole output).
 */
export function listUnitKey(arrayRef: unknown): string | null {
    if (typeof arrayRef !== 'string' || !arrayRef) return null;
    // parsePath answers null for a path it cannot read.
    const tokens = parsePath(arrayRef) as Array<{ type: string; key?: unknown }> | null;
    if (!tokens) return null;
    const outputAt = tokens.map(tk => tk.key).lastIndexOf('output');
    const props = tokens.slice(outputAt >= 0 ? outputAt + 1 : 1)
        .filter(tk => tk.type === 'prop' && typeof tk.key === 'string');
    const last = props[props.length - 1];
    return last ? (last.key as string) : null;
}

/** P3: the unit a route note counts in, "messages", or "items" when the list has no name. */
export function routeUnit(arrayRef: unknown, t: TranslateFn): string {
    const key = listUnitKey(arrayRef);
    const word = key ? humanizeFieldKey(key).toLowerCase() : '';
    return word || t('condition_node.run.unit_items', 'items');
}

/**
 * The route context of a step that works through a list (a filter, or a
 * switch with `arrayRef`), or null for any other step.
 */
export function routeContextOf(step: PlainObject | null | undefined, t: TranslateFn): RouteContext | null {
    if (!step || typeof step.arrayRef !== 'string') return null;
    if (step.type !== 'filter' && step.type !== 'switch') return null;
    const cases = Array.isArray(step.cases) ? step.cases : [];
    const caseOrder = cases
        .map(c => (isPlainObject(c) && typeof c.name === 'string' ? c.name : ''))
        .filter(Boolean);
    return { unit: routeUnit(step.arrayRef, t), caseOrder, fanOut: step.matchMode === 'all' };
}

/**
 * A Condition's route in words (P1/P2): "Kept 3 of 4 messages", or
 * "pdf 4 · word 2 · Otherwise 4 (11 attachments in all)".
 */
export function routeSentence(note: RouteNote, unit: string, t: TranslateFn): string {
    if (note.kind === 'kept') {
        return note.kept === 0
            ? t('condition_node.run.kept_none', 'Kept none of {total} {unit}', { total: note.total, unit })
            : t('condition_node.run.kept', 'Kept {kept} of {total} {unit}', { kept: note.kept, total: note.total, unit });
    }
    const parts = note.parts
        .map(p => `${p.otherwise ? t('condition_node.otherwise.label', 'Otherwise') : p.name} ${p.count}`)
        .join(' · ');
    const line = t('condition_node.run.split', '{parts} ({total} {unit} in all)', { parts, total: note.total, unit });
    return note.fanOut
        ? `${line} · ${t('condition_node.run.split_fanout', 'one item can go down several outputs')}`
        : line;
}

/**
 * How much a Condition's run came to, in the words of its unit, for the
 * status strip, the header pill and the In → Out line: "11 attachments" for
 * a list switch (whose output is one record of internals, which the generic
 * summary counts as "1 record"). Null when the value is not a list-switch
 * output: the generic summary already counts a filter's kept items right.
 */
export function routeSummaryOf(value: unknown, route: RouteContext | null | undefined, t: TranslateFn): DataSummary | null {
    if (!route) return null;
    const note = routeNoteOf(value, route);
    if (!note || note.kind !== 'split') return null;
    const label = t('condition_node.run.total', '{total} {unit}', { total: note.total, unit: route.unit });
    return { count: note.total, kind: 'records', label };
}

/**
 * What a list switch passed on, as the result panel shows it: its outputs in
 * case order with Otherwise last (`matchesByCase`), at their own path, rather
 * than the record of internals around them (mode, branch, counts). Null for
 * any other output, and for a list switch whose recording holds no rows.
 */
export function routeOutputsOf(value: unknown, route: RouteContext | null | undefined): PlainObject | null {
    if (!route || !isPlainObject(value)) return null;
    const note = routeNoteOf(value, route);
    const byCase = value.matchesByCase;
    if (!note || note.kind !== 'split' || !isPlainObject(byCase)) return null;
    const names = [...note.parts.map(p => p.name), ...Object.keys(byCase)];
    const entries = [...new Set(names)].filter(n => Array.isArray(byCase[n])).map(n => [n, byCase[n]] as const);
    return entries.length ? Object.fromEntries(entries) : null;
}
