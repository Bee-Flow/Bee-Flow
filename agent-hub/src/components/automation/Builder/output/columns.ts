import { humanizeFieldKey as humanizeFieldKeyJs } from '../flow/displayHelpers';
import { kindOfValue as kindOfValueJs } from '../mapping/fieldKinds';
import { isPlainObject } from './valueHelpers';

/**
 * The column model of the step drawer's output table (artboards 4b and 4d):
 * which columns a list of records has, what each one holds, which of them are
 * technical, and which handful to show before anyone touches the picker.
 *
 * Pure and React-free so the suggestion rules are tested on their own.
 */

const humanizeFieldKey = humanizeFieldKeyJs as (key: string) => string;
const kindOfValue = kindOfValueJs as (v: unknown) => string;

export type ColKind = 'text' | 'number' | 'yesno' | 'date' | 'group' | 'table' | 'list' | 'file' | 'unknown';
export type ColRole = 'name' | 'number' | 'date' | 'amount' | 'status' | null;

export interface OutputColumn {
    /** Path relative to a row: `supplier`, or `supplier.name` once split. */
    key: string;
    /** "Supplier", or "Supplier › Name" for a split group's field. */
    label: string;
    kind: ColKind;
    technical: boolean;
    role: ColRole;
    /** Fields in a group column; null for anything else. */
    groupSize: number | null;
    /** The group a split column came from. */
    parent: string | null;
    /** A per-item step's column (perItem.ts): an output field, Result, Incoming or Problem. */
    perItem?: 'output' | 'result' | 'item' | 'problem';
}

/** What the person chose in the column picker, remembered per step. */
export interface ColumnPrefs {
    /** Shown columns, in order. Null = the suggestion. */
    shown: string[] | null;
    /** Group columns split into one column per field. */
    split: string[];
}

export const EMPTY_PREFS: ColumnPrefs = { shown: null, split: [] };

/** Rows sampled to learn the columns: enough for a shape, cheap on 5 000 rows. */
export const SAMPLE_ROWS = 200;

const norm = (k: string) => k.toLowerCase().replace(/[\s_\-.]/g, '');

const TECH_EXACT = new Set([
    'id', 'uuid', 'guid', 'etag', 'tenant', 'tenantid', 'orgid', 'hash', 'checksum', 'md5',
    'sha', 'sha1', 'sha256', 'revision', 'rev', 'createdat', 'updatedat', 'kind', 'provider',
    'object', 'permissions', 'resourcetype', 'mountpoint', 'mimetypeid', 'storageid', 'fileid',
    'nodeid', 'ownerid', 'userid', 'objectid', 'parentid', 'cursor', 'raw', 'headers',
]);

/**
 * Is this a column nobody reads, the plumbing an API hands back beside the
 * answer? `id`, `etag`, `tenant`, `created_at`, `…_id`, `fooId`, `_private`.
 */
export function isTechnicalKey(key: string): boolean {
    const k = String(key);
    if (!k) return false;
    if (k.startsWith('_') || k.startsWith('@') || k.startsWith('$')) return true;
    if (TECH_EXACT.has(norm(k))) return true;
    if (/_id$/i.test(k) || /[a-z]Id$/.test(k) || /^tenant/i.test(k)) return true;
    return false;
}

const NAME_KEYS = new Set(['name', 'title', 'subject', 'filename', 'displayname', 'fullname', 'label', 'basename', 'naam', 'titel']);

/** What a column is FOR, as far as the default selection cares. */
export function roleOf(key: string, kind: ColKind): ColRole {
    const n = norm(key.split('.').pop() || key);
    if (NAME_KEYS.has(n)) return 'name';
    if (/(number|nr|no|nummer|reference|ref|code)$/.test(n) && (kind === 'text' || kind === 'number')) return 'number';
    if (/^(status|state|stage|phase)$/.test(n)) return 'status';
    if (kind === 'date' || /(date|datum|modified|deadline|due)$/.test(n)) return 'date';
    if (kind === 'number' && /(amount|total|price|sum|cost|value|size|bytes|bedrag|totaal|prijs)$/.test(n)) return 'amount';
    return null;
}

function kindOfColumn(values: unknown[]): ColKind {
    const tally = new Map<string, number>();
    for (const v of values) {
        if (v === null || v === undefined || v === '') continue;
        const k = kindOfValue(v);
        tally.set(k, (tally.get(k) || 0) + 1);
    }
    let best: string = 'unknown';
    let top = 0;
    for (const [k, n] of tally) if (n > top) { best = k; top = n; }
    return (best === 'choice' ? 'text' : best) as ColKind;
}

/** Every key of these records, in the order the data first shows it. */
export function keysInOrder(objects: Record<string, unknown>[]): string[] {
    const seen: string[] = [];
    const has = new Set<string>();
    for (const o of objects) for (const k of Object.keys(o)) if (!has.has(k)) { has.add(k); seen.push(k); }
    return seen;
}

function column(key: string, label: string, values: unknown[], parent: string | null): OutputColumn {
    const kind = kindOfColumn(values);
    const groups = kind === 'group' ? values.filter(isPlainObject) : [];
    return {
        key,
        label,
        kind,
        technical: isTechnicalKey(key.split('.').pop() || key),
        role: roleOf(key, kind),
        groupSize: kind === 'group' ? keysInOrder(groups).length : null,
        parent,
    };
}

/** Every column of a list of records, split groups replaced by their fields. */
export function discoverColumns(rows: unknown[], split: readonly string[] = []): OutputColumn[] {
    const objects = rows.slice(0, SAMPLE_ROWS).filter(isPlainObject);
    const out: OutputColumn[] = [];
    for (const key of keysInOrder(objects)) {
        const values = objects.map(o => o[key]);
        const base = column(key, humanizeFieldKey(key), values, null);
        if (base.kind === 'group' && split.includes(key)) {
            const groups = values.filter(isPlainObject);
            for (const child of keysInOrder(groups)) {
                out.push(column(
                    `${key}.${child}`,
                    `${humanizeFieldKey(key)} › ${humanizeFieldKey(child)}`,
                    groups.map(g => g[child]),
                    key,
                ));
            }
            continue;
        }
        out.push(base);
    }
    return out;
}

/** Listed in the picker, never pinned or suggested: a per-item step's item, unless it is the rows' name. */
export function isAside(c: OutputColumn | undefined): boolean {
    return !!c && c.perItem === 'item' && c.role !== 'name';
}

/**
 * The column that stays pinned on the left: a name, else a number, else the
 * first text. Never a per-item step's Problem column: it is empty on every
 * row that worked, and the rows would be named "Row n".
 */
export function nameColumn(cols: OutputColumn[]): OutputColumn | null {
    const visible = cols.filter(c => !isAside(c) && c.perItem !== 'problem');
    const pool = visible.filter(c => !c.technical);
    const from = pool.length ? pool : (visible.length ? visible : cols);
    return from.find(c => c.role === 'name')
        || from.find(c => c.role === 'number')
        || from.find(c => c.kind === 'text')
        || from[0]
        || null;
}

const leafOf = (key: string) => (key.split('.').pop() || key).replace(/\[[^\]]*\]/g, '');

/**
 * Who a record is from or about: the column a person looks for right after
 * its name. APIs put it anywhere — Microsoft Graph lists a mail's `from` after
 * a dozen flags and ids — so it is picked by name, not by position.
 */
const HEADLINE_KEYS = new Set(['from', 'sender', 'author', 'owner', 'customer', 'requester', 'assignee', 'organizer', 'createdby', 'contact', 'client', 'supplier', 'vendor']);

/**
 * The default columns, at most `max`: the name or number column first, then
 * a per-item step's Problem column, a date, an amount, a status, every field
 * a next step uses and who it is from or about, filled up with the remaining
 * readable columns in the data's own order. Technical and aside columns
 * never make the suggestion.
 */
export function suggestColumns(cols: OutputColumn[], { max = 7, usedFields = [] }: { max?: number; usedFields?: readonly string[] } = {}): string[] {
    const first = nameColumn(cols);
    if (!first) return [];
    const visible = cols.filter(c => !isAside(c));
    const pool = visible.filter(c => !c.technical);
    const readable = pool.length ? pool : visible;
    const picks = new Set<string>([first.key]);
    const used = new Set(usedFields.map(norm));
    const priority = [
        readable.find(c => c.perItem === 'problem'),
        readable.find(c => c.role === 'date'),
        readable.find(c => c.role === 'amount'),
        readable.find(c => c.role === 'status'),
        ...readable.filter(c => used.has(norm(leafOf(c.key)))),
        readable.find(c => HEADLINE_KEYS.has(norm(leafOf(c.key)))),
    ];
    for (const c of priority) if (c && picks.size < max) picks.add(c.key);
    for (const c of readable) if (picks.size < max) picks.add(c.key);
    const rest = readable.filter(c => c.key !== first.key && picks.has(c.key));
    const problems = rest.filter(c => c.perItem === 'problem');
    return [first, ...problems, ...rest.filter(c => c.perItem !== 'problem')].map(c => c.key);
}

/** Keys only the per-item envelope itself had: a flattened per-item table never has a column by these names. */
const ENVELOPE_ONLY = new Set(['index', 'status', 'errorClass', 'attempts']);

/**
 * Was this choice saved before a per-item step's rows were flattened
 * (`['status', 'index', 'item', 'output', 'error']`)? It names a key only the
 * envelope had, or it keeps none of the step's own output columns: either
 * way it would show just "Incoming" (and "Problem").
 */
function isEnvelopeChoice(shown: readonly string[], kept: readonly string[], byKey: Map<string, OutputColumn>): boolean {
    const perItem = (k: string) => byKey.get(k)?.perItem;
    if (!kept.some(k => perItem(k))) return false;
    if (shown.some(k => ENVELOPE_ONLY.has(k))) return true;
    return !kept.some(k => perItem(k) === 'output' || perItem(k) === 'result');
}

/**
 * The person's own choice minus the columns the data no longer has; null when
 * nothing of it is left, or when it is a per-item step's stale envelope
 * choice (isEnvelopeChoice).
 */
export function keptChoice(cols: OutputColumn[], prefs: ColumnPrefs): string[] | null {
    if (!prefs.shown || !prefs.shown.length) return null;
    const byKey = new Map(cols.map(c => [c.key, c]));
    const kept = prefs.shown.filter(k => byKey.has(k));
    return kept.length && !isEnvelopeChoice(prefs.shown, kept, byKey) ? kept : null;
}

/** The columns on screen: the person's own choice when there is one (keptChoice), else the suggestion. */
export function resolveShown(cols: OutputColumn[], prefs: ColumnPrefs, opts: { max?: number; usedFields?: readonly string[] } = {}): string[] {
    return keptChoice(cols, prefs) ?? suggestColumns(cols, opts);
}
