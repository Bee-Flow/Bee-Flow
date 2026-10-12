/**
 * The "run once per item" half of auto-map: a step whose REQUIRED inputs no
 * single upstream value fills, below a step that hands it a LIST whose
 * elements do, is set to run once per element.
 *
 * Which list. A step below "read each mail" sees two: the mails themselves
 * (`steps.read.output.results`, one entry per run) and every attachment of
 * every mail (`…results[*].output.attachments`). "Mark as read" needs a
 * message id; an attachment carries one too, so going by names alone it ran
 * once per ATTACHMENT — twice for a mail with two, never for a mail without.
 * So every list of the nearest step that has lists is scored by how many
 * required inputs its element fills, and on a tie the OUTER list wins: a step
 * only moves into a list inside a list when an input actually needs a field
 * that only the inner element has ("read attachment" needs `attachmentId`).
 *
 * A list inside a list keeps its outer elements (`forEach.parents`, see the
 * runner's forEachScope.js), so an input the inner element lacks can still
 * be read from the element it came from (`loop.result.output.id`).
 *
 * Port of agent-hub `Builder/mapping/autoMapIteration.ts`; pinned by
 * autoMap.lockstep.test.ts.
 */
import { parsePath } from '@/shared/expr';

import { namesRecord, recordIdOf } from './autoMapEntity';
import { foldKey, groupListSources, isRecord, walkDeep } from './deepFields';
import type { ListSource, UpstreamGroup } from './deepFields';
import { isEmptyBinding } from './partitionInputs';
import { matchSchema } from './schemaMatch';
import type { MatchParam } from './schemaMatch';
import { lastPathKey, suggestItemVar, uniqueItemVar } from './upstream/loops';

interface Schema { properties?: Record<string, { type?: unknown; [k: string]: unknown }>; required?: string[] }
interface Cand { key: string; path: string; type: string; sample?: unknown; groupLabel?: string; groupIndex: number; weight: number }
type Binding = { kind: 'ref'; path: string };
export interface ForEachParent { itemVar: string; overRef: string }
export interface IterationMapping { patch: Record<string, Binding>; forEach: { overRef: string; itemVar: string; maxIterations: number; parents?: ForEachParent[] } }

const SECRET_RE = /(password|passwd|secret|token|apikey|api[_-]?key|credential|client[_-]?secret|private[_-]?key)/i;
const ARRAY_NAME_RE = /items|results|rows|records|data|list|messages|emails|events|files|entries|value/i;

export function sampleType(v: unknown): string {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

/** JSON-Schema property type vs a sample's type. Permissive when unknown. */
export function typeCompatible(propType: unknown, candType: string): boolean {
    if (!propType || !candType || candType === 'null') return true;
    let pt = propType;
    if (Array.isArray(pt)) pt = pt.find(t => t !== 'null') || pt[0];
    if (pt === 'integer') pt = 'number';
    if (pt === 'string') return ['string', 'number', 'boolean'].includes(candType);
    return pt === candType;
}

/** `messageId` / `message_id` → 'message'; null when the key isn't id-suffixed. */
export function idAffinityBase(key: string): string | null {
    const m = /^(.+?)[_]?id$/i.exec(String(key || ''));
    return m && m[1] ? m[1] : null;
}

/** The fields of one element under `loop.<name>`, nearest (fewest meaningful levels) first. */
function elementCandidates(element: unknown, itemVar: string, groupIndex: number): Cand[] {
    const out: (Cand & { i: number })[] = [];
    let i = 0;
    walkDeep(element, `loop.${itemVar}`, (n) => {
        if (n.chain.length) return;
        out.push({ key: n.key, path: n.path, type: sampleType(n.value), sample: n.value, groupLabel: itemVar, groupIndex, weight: n.weight, i: i++ });
    });
    return out.sort((a, b) => (a.weight - b.weight) || (a.i - b.i)).map(({ i: _i, ...c }) => c);
}

interface Scored { patch: Record<string, Binding>; required: number; source: ListSource; itemVar: string; parents: ForEachParent[] }

/** A record's own `id` and what that record is (autoMapEntity.ts). */
interface RecordId { field: Cand; words: Set<string> }

/** The names of a list's levels (outer lists first, then its own item), their candidates and their ids. */
function sourceCandidates(source: ListSource, definition: unknown): { itemVar: string; parents: ForEachParent[]; own: Cand[]; outer: Cand[]; ids: RecordId[] } {
    const names: string[] = [];
    const parents: ForEachParent[] = source.chain.map((level) => {
        const itemVar = uniqueItemVar(suggestItemVar(lastPathKey(level.path)), names);
        names.push(itemVar);
        return { itemVar, overRef: level.path };
    });
    // After a flatten (or a filter over one) the rows are named by what they are (F47).
    const itemVar = uniqueItemVar(suggestItemVar(source.key || lastPathKey(source.path), definition as never, source.path), names);
    const own = elementCandidates(source.element, itemVar, source.chain.length + 1);
    const levels = source.chain.map((level, li) => elementCandidates(level.element, parents[li]?.itemVar || 'item', li + 1));
    // Each element's own `id`, innermost first, with what it is: the names it
    // goes by (the list it comes from, its item variable) and its record.
    const ids: RecordId[] = [];
    const ownId = recordIdOf(own, `loop.${itemVar}`, source.element, [source.key, itemVar]);
    if (ownId) ids.push(ownId);
    for (let li = source.chain.length - 1; li >= 0; li--) {
        const level = source.chain[li];
        const parentVar = parents[li]?.itemVar || 'item';
        const id = level ? recordIdOf(levels[li] || [], `loop.${parentVar}`, level.element, [lastPathKey(level.path), parentVar]) : null;
        if (id) ids.push(id);
    }
    return { itemVar, parents, own, outer: levels.flat(), ids };
}

/**
 * Exact name, then any spelling, then `<entity>Id` ↔ the `id` of the element
 * that IS that entity (each id once), for every free key. A Slack post's
 * channelId below a list of mails is not a mail's id.
 */
function nameMatches({ keys, schema }: { keys: string[]; schema: Schema }, candidates: Cand[], ids: RecordId[], free: (k: string) => boolean): Record<string, Binding> {
    const properties = schema.properties || {};
    const patch: Record<string, Binding> = {};
    const used = new Set<string>();
    for (const key of keys.filter(free)) {
        const propType = properties[key]?.type;
        const fits = (c: Cand) => !used.has(c.path) && typeCompatible(propType, c.type);
        const match = candidates.find(c => fits(c) && c.key === key) || candidates.find(c => fits(c) && foldKey(c.key) === foldKey(key))
            || ids.find(r => fits(r.field) && namesRecord(idAffinityBase(key), r.words))?.field;
        if (!match) continue;
        patch[key] = { kind: 'ref', path: match.path };
        used.add(match.path);
    }
    return patch;
}

/**
 * Fill the inputs from one list's element (and its outer elements): names
 * first, then schema matching. Null when no REQUIRED input is filled.
 */
function matchSource(source: ListSource, schema: Schema, existing: Record<string, unknown>, definition: unknown): Scored | null {
    const properties = schema.properties || {};
    const required = new Set(schema.required || []);
    const { itemVar, parents, own, outer, ids } = sourceCandidates(source, definition);
    const candidates = [...own, ...outer];
    if (!candidates.length) return null;
    const keys = Object.keys(properties).sort((a, b) => (required.has(b) ? 1 : 0) - (required.has(a) ? 1 : 0));
    const free = (k: string) => isEmptyBinding(existing[k]) && !SECRET_RE.test(k);
    const patch = nameMatches({ keys, schema }, candidates, ids, free);
    const used = new Set(Object.values(patch).map(b => b.path));
    const left = keys.filter(k => !patch[k] && free(k));
    for (const r of matchSchema(left.map(k => ({ key: k, ...(properties[k] || {}) }) as MatchParam), candidates, used)) {
        patch[r.key] = { kind: 'ref', path: r.path };
        used.add(r.path);
    }
    const filled = Object.keys(patch).filter(k => required.has(k)).length;
    return filled ? { patch, required: filled, source, itemVar, parents } : null;
}

/** Better = more required inputs filled; then the outer list; then the nearer, named, earlier one. */
function better(a: Scored, b: Scored | null, order: Map<ListSource, number>): boolean {
    if (!b) return true;
    if (a.required !== b.required) return a.required > b.required;
    if (a.source.chain.length !== b.source.chain.length) return a.source.chain.length < b.source.chain.length;
    if (a.source.weight !== b.source.weight) return a.source.weight < b.source.weight;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- ARRAY_NAME_RE is an alternation of short literals with no quantifier: bounded work per position, linear
    const an = ARRAY_NAME_RE.test(a.source.key) ? 0 : 1;
    const bn = ARRAY_NAME_RE.test(b.source.key) ? 0 : 1;
    if (an !== bn) return an < bn;
    return (order.get(a.source) ?? 0) < (order.get(b.source) ?? 0);
}

/** `isDiagnostic(kind, key)` keeps a Code step's `logs` out; `definition` names a flatten's rows (F47). */
interface IterationContext { isDiagnostic?: (kind: string | undefined, key: string) => boolean; definition?: unknown }

/**
 * Only from a declared schema with REQUIRED inputs, only for inputs the
 * single-value pass left empty, and only when a required input is filled per
 * item. The nearest step with a usable list wins. `isDiagnostic(kind, key)`
 * keeps a Code step's `logs` out (flow/stepPayload.ts).
 */
export function tryIterationMapping(
    schema: Schema | null | undefined,
    existingInputs: Record<string, unknown> | null | undefined,
    groups: UpstreamGroup[] | null | undefined,
    ctx: IterationContext = {},
): IterationMapping | null {
    if (!schema?.properties || !(schema.required || []).length) return null;
    const list = groups || [];
    for (let gi = list.length - 1; gi >= 0; gi--) {
        const g = list[gi];
        const best = g && !g.ownItem ? bestSource(g, schema, existingInputs || {}, ctx) : null;
        if (!best) continue;
        const forEach: IterationMapping['forEach'] = { overRef: best.source.path, itemVar: best.itemVar, maxIterations: 100 };
        if (best.parents.length) forEach.parents = best.parents;
        return { patch: best.patch, forEach };
    }
    return null;
}

/** The best list of one group for these inputs, or null when none fills a required one. */
function bestSource(g: UpstreamGroup, schema: Schema, existing: Record<string, unknown>, { isDiagnostic = () => false, definition = null }: IterationContext): Scored | null {
    const sources = groupListSources(g).filter(s => isRecord(s.element) && !firstKeyIsDiagnostic(g, s.path, isDiagnostic));
    const order = new Map(sources.map((s, i) => [s, i]));
    let best: Scored | null = null;
    for (const s of sources) {
        const m = matchSource(s, schema, existing, definition);
        if (m && better(m, best, order)) best = m;
    }
    return best;
}

/** Is the first key of `path` below the group's base one of its step's diagnostics (a Code step's `logs`)? */
export function firstKeyIsDiagnostic(group: UpstreamGroup, path: string, isDiagnostic: (kind: string | undefined, key: string) => boolean): boolean {
    const base = (parsePath(group.basePath || '') || []) as { key?: unknown }[];
    const t = (parsePath(path) || []) as { key?: unknown }[];
    const first = t[base.length]?.key;
    return typeof first === 'string' && isDiagnostic(group.kind, first);
}
