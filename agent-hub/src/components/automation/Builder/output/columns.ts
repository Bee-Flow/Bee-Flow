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
const SAMPLE_ROWS = 200;

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

function keysInOrder(objects: Record<string, unknown>[]): string[] {
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

/** The column that stays pinned on the left: a name, else a number, else the first text. */
export function nameColumn(cols: OutputColumn[]): OutputColumn | null {
    const pool = cols.filter(c => !c.technical);
    const from = pool.length ? pool : cols;
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
 * a date, an amount, a status, every field a next step uses and who it is
 * from or about, filled up
 * with the remaining readable columns in the data's own order. Technical
 * columns never make the suggestion.
 */
export function suggestColumns(cols: OutputColumn[], { max = 7, usedFields = [] }: { max?: number; usedFields?: readonly string[] } = {}): string[] {
    const first = nameColumn(cols);
    if (!first) return [];
    const pool = cols.filter(c => !c.technical);
    const readable = pool.length ? pool : cols;
    const picks = new Set<string>([first.key]);
    const used = new Set(usedFields.map(norm));
    const priority = [
        readable.find(c => c.role === 'date'),
        readable.find(c => c.role === 'amount'),
        readable.find(c => c.role === 'status'),
        ...readable.filter(c => used.has(norm(leafOf(c.key)))),
        readable.find(c => HEADLINE_KEYS.has(norm(leafOf(c.key)))),
    ];
    for (const c of priority) if (c && picks.size < max) picks.add(c.key);
    for (const c of readable) if (picks.size < max) picks.add(c.key);
    return [first.key, ...readable.filter(c => c.key !== first.key && picks.has(c.key)).map(c => c.key)];
}

/**
 * The columns on screen: the person's own choice when there is one (minus
 * columns the data no longer has), else the suggestion.
 */
export function resolveShown(cols: OutputColumn[], prefs: ColumnPrefs, opts: { max?: number; usedFields?: readonly string[] } = {}): string[] {
    if (prefs.shown && prefs.shown.length) {
        const known = new Set(cols.map(c => c.key));
        const kept = prefs.shown.filter(k => known.has(k));
        if (kept.length) return kept;
    }
    return suggestColumns(cols, opts);
}
