/**
 * Auto-map for an input that takes a LIST of one-value things: a COLUMN of an
 * upstream list of records.
 *
 *   messageIds ← steps.search.output.results[*].id   (the id of every result)
 *   emails     ← steps.crm.output.contacts[*].email   (the plural of a field)
 *
 * The other passes never offer a column: `results[*].id` is one value PER ROW,
 * so it must never fill a one-value input (deepFields.groupValueFields leaves
 * columns out on purpose). A list input is the one place a column belongs, and
 * the runtime reads `[*]` as "map and flatten" (shared/expr/path.mjs), so the
 * binding is the list of every row's value.
 *
 * Which column, per still-empty list input K, in the nearest step that has one,
 * an outer list before a list inside a list:
 *   (a) K is the plural of a direct field: `emails` ← email, `ids` ← id,
 *       `fileIds` ← fileId, `entries` ← entry;
 *   (b) K asks for ids of an entity (`messageIds`) and the element IS that
 *       entity (autoMapEntity.ts: the list's name, a type field, a mail's
 *       headers): its own `id`. `addLabelIds` below a list of mails stays empty.
 * A column only when its values fit the input's `items.type` (and its
 * `items.enum`, when there is one).
 *
 * Never a column every run would get whole:
 *   - not for a step that runs once per item (a forEach), and not from before
 *     a Loop whose body the step is in: one run sees one item, a column from
 *     outside is every row, every time (a list INSIDE the item is fine);
 *   - not a back-reference: below ONE mail, its attachments' `messageId` is
 *     that one mail's id N times (or nothing), never a list of mails. A step
 *     that hands over one such record ends the search: its id is one value,
 *     a farther step's list (every search result) is not what it read.
 * autoMapStep decides a forEach BEFORE this pass (autoMapInputs.js).
 *
 * Pure. Mirrored by the phone's bindings/autoMapListInput.ts.
 */
import { appendWildcard, getPath, splitLast } from '@shared/expr/path.mjs';
import { namesRecord, recordIdOf } from './autoMapEntity';
import { firstKeyIsDiagnostic, sampleType, typeCompatible } from './autoMapIteration';
import { asValue, foldKey, groupListSources, isRecord, walkDeep } from './deepFields';
import type { DeepNode, ListSource, UpstreamGroup } from './deepFields';
import { expectedShapeFor } from './listShape';
import { isEmptyBinding } from './partitionInputs';
import { suggestItemVar } from './upstream/loops';
import { isDiagnosticOutputKey } from '../flow/stepPayload';

interface ListProp { type?: unknown; items?: { type?: unknown; enum?: unknown[] } }
interface Schema { properties?: Record<string, ListProp | undefined>; required?: string[] }
type Binding = { kind: 'ref'; path: string };

const SECRET_RE = /(password|passwd|secret|token|apikey|api[_-]?key|credential|client[_-]?secret|private[_-]?key)/i;

/** Is `key` the plural of `field` (folded): `emails`/email, `ids`/id, `addresses`/address, `entries`/entry? */
export function isPluralOf(key: unknown, field: unknown): boolean {
    const k = foldKey(key);
    const f = foldKey(field);
    if (!f || f === k) return false;
    return k === `${f}s` || k === `${f}es` || (f.endsWith('y') && k === `${f.slice(0, -1)}ies`);
}

/** `messageIds` / `message_ids` → 'message'; null when the key does not ask for ids of something. */
export function idsBase(key: unknown): string | null {
    const m = /^(.+?)[_-]?ids$/i.exec(String(key ?? ''));
    return m && m[1] ? m[1] : null;
}

/** The one-value fields of a list's element, in data order: never a list inside it, never a record. */
function columnsOf(s: ListSource): DeepNode[] {
    const out: DeepNode[] = [];
    walkDeep(s.element, appendWildcard(s.path), (n) => {
        if (n.chain.length || n.pair) return;
        const v = asValue(n.value);
        if (isRecord(v) || Array.isArray(v)) return;
        out.push(n);
    });
    return out;
}

/** The lists of records of one group, an outer list before a list inside a list, then the nearer one, then data order. */
function recordSources(g: UpstreamGroup): ListSource[] {
    return groupListSources(g)
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => isRecord(s.element) && !firstKeyIsDiagnostic(g, s.path, isDiagnosticOutputKey))
        .sort((a, b) => (a.s.chain.length - b.s.chain.length) || (a.s.weight - b.s.weight) || (a.i - b.i))
        .map(x => x.s);
}

/** May this sample fill an item of the input: of its type, and one of its allowed values when it has them? */
function fitsItems(items: ListProp['items'], value: unknown): boolean {
    if (!typeCompatible(items?.type, sampleType(value))) return false;
    const allowed = items?.enum;
    if (!Array.isArray(allowed) || !allowed.length) return true;
    const v = asValue(value);
    return v !== null && v !== undefined && allowed.some(e => String(e) === String(v));
}

/** Is this record the entity `base` names: its own `<base>Id`, or its own `id` with that entity's names or headers? */
function isEntityRecord(base: string, record: unknown, names: unknown[]): boolean {
    if (!isRecord(record)) return false;
    const fields: DeepNode[] = [];
    walkDeep(record, '$', (n) => {
        const v = asValue(n.value);
        if (!n.chain.length && !n.pair && n.weight === 1 && !isRecord(v) && !Array.isArray(v)) fields.push(n);
    });
    const ownRef = foldKey(`${base}Id`);
    if (fields.some(n => foldKey(n.key) === ownRef)) return true;
    const id = recordIdOf(fields, '$', record, names);
    return !!id && namesRecord(base, id.words);
}

/** Does the list sit inside ONE `base` record (the step's output, or the outer element of a list inside a list)? */
function insideEntity(base: string, g: UpstreamGroup, s: ListSource): boolean {
    const parent = splitLast(s.path)?.parent ?? '';
    const level = s.chain[s.chain.length - 1];
    const at = level ? appendWildcard(level.path) : (g.basePath || '');
    const value = level ? level.element : g.sample;
    const names = level ? [splitLast(level.path)?.last] : [];
    if (parent === at) return isEntityRecord(base, value, names);
    if (!parent.startsWith(at)) return false;
    return isEntityRecord(base, getPath({ $: value }, `$${parent.slice(at.length)}`), names);
}

/**
 * The column of one list for `key`: the plural of a field (never a
 * back-reference to the one record the list sits in), else the element's own
 * id when it is the entity asked for.
 */
function sourceColumn(key: string, items: ListProp['items'], { g, s }: { g: UpstreamGroup; s: ListSource }, used: Set<string>): string | null {
    const base = idsBase(key);
    const cols = columnsOf(s).filter(n => !used.has(n.path) && fitsItems(items, n.value));
    const backRef = (n: DeepNode) => !!base && foldKey(n.key) === foldKey(`${base}Id`) && insideEntity(base, g, s);
    const plural = cols.find(n => n.weight === 1 && isPluralOf(key, n.key) && !backRef(n));
    if (plural) return plural.path;
    if (!base) return null;
    const id = recordIdOf(cols, appendWildcard(s.path), s.element, [s.key, suggestItemVar(s.key)]);
    return id && namesRecord(base, id.words) ? id.field.path : null;
}

/** A Loop body's current item (or batch): one run of the body sees one, a list from before the loop is every row. */
function isLoopScope(g: UpstreamGroup): boolean {
    const base = g.basePath || '';
    return g.kind === 'loop' && (/^loop\.[^.[\]]+$/.test(base) || base === 'item');
}

/**
 * The nearest group's first fitting column for `key`. The search stops at a
 * Loop's current item, and at a step that hands over ONE record of the entity
 * `<entity>Ids` asks for (a read mail: its id is one value).
 */
function nearestColumn(key: string, items: ListProp['items'], groups: UpstreamGroup[], used: Set<string>): string | null {
    const base = idsBase(key);
    for (let gi = groups.length - 1; gi >= 0; gi--) {
        const g = groups[gi];
        if (!g || g.ownItem) continue;
        for (const s of recordSources(g)) {
            const path = sourceColumn(key, items, { g, s }, used);
            if (path) return path;
        }
        if (isLoopScope(g) || (base && isEntityRecord(base, g.sample, []))) return null;
    }
    return null;
}

/** A list input nothing filled yet (not this pass, not the author) and not a secret. */
function isOpenListInput(key: string, prop: ListProp | undefined, patch: Record<string, Binding>, existing: Record<string, unknown>): boolean {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- SECRET_RE is an alternation of short literals whose only quantifier is an optional [_-]: bounded work per position, linear
    return !patch[key] && isEmptyBinding(existing[key]) && !SECRET_RE.test(key) && expectedShapeFor(prop) === 'list';
}

/**
 * Add a column binding to `patch` for every still-empty list input (`type:
 * 'array'`) a column fits, sharing `used` with the other passes. Runs after
 * the name tiers (an upstream list with the input's own name wins) and before
 * schema matching. `off` while autoMapStep decides whether the step runs once
 * per item: a step that does never gets a column.
 */
export function listColumnPatch(
    { keys, schema, existing, groups, used, maxPerStep = 12, off = false }: {
        keys: string[];
        schema: Schema | null | undefined;
        existing: Record<string, unknown>;
        groups: UpstreamGroup[] | null | undefined;
        used: Set<string>;
        maxPerStep?: number;
        off?: boolean;
    },
    patch: Record<string, Binding>,
): void {
    const properties = schema?.properties;
    const list = groups || [];
    if (off || !properties || list.some(g => g?.ownItem)) return;
    for (const key of keys) {
        if (Object.keys(patch).length >= maxPerStep) return;
        const prop = properties[key];
        if (!isOpenListInput(key, prop, patch, existing)) continue;
        const path = nearestColumn(key, prop?.items, list, used);
        if (!path) continue;
        patch[key] = { kind: 'ref', path };
        used.add(path);
    }
}
