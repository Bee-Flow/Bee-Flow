import { appendKey, splitLast } from '@shared/expr/path.mjs';
import { readableValue } from '../mapping/upstream/fieldTree';
import { recordName } from './cellSummary';
import { SAMPLE_ROWS, discoverColumns, isTechnicalKey, keysInOrder, type OutputColumn } from './columns';
import { isForEachEnvelope } from './envelope';
import { getByDotted, isPlainObject, type PlainObject } from './valueHelpers';

/**
 * The rows of a step that ran once per item, `{ index, item, output, status }`,
 * read as a table of what the step RETURNED: every output field its own
 * column ("Subject", never "Output › Subject"), the item it ran for one
 * column aside ("Incoming"), and a "Problem" column when an item failed.
 * `index`, `status`, `errorClass` and `attempts` are never columns.
 *
 * A thin adapter in front of discoverColumns: rows that are not per-item get
 * exactly what discoverColumns gives. Pure, React-free and without words:
 * the labels of the item, result and problem columns are placeholders that
 * useOutputColumns replaces through t().
 */

const isPerItemMemo = new WeakMap<readonly unknown[], boolean>();

/** Does this list hold the per-item envelope? Memoised on the array itself. */
export function isPerItemRows(rows: unknown[]): boolean {
    if (!Array.isArray(rows)) return false;
    const known = isPerItemMemo.get(rows);
    if (known !== undefined) return known;
    const objects = rows.slice(0, SAMPLE_ROWS).filter(isPlainObject);
    const answer = isForEachEnvelope(objects, keysInOrder(objects));
    isPerItemMemo.set(rows, answer);
    return answer;
}

const hasText = (v: unknown) => v != null && v !== '';

/** Did this item fail? The runner marks it `status: 'error'` with an `error` message. */
function failed(row: PlainObject): boolean {
    return row.status === 'error' || hasText(row.error);
}

/** The output fields as columns, or one "Result" column when the outputs are not records. */
function outputColumns(sample: PlainObject[]): OutputColumn[] {
    const outputs = sample.map(r => readableValue(r.output));
    const present = outputs.filter(o => o != null);
    const records = present.filter(isPlainObject);
    if (records.length > 0 && records.length * 2 >= present.length) {
        return discoverColumns(records).map(c => ({ ...c, key: appendKey('output', c.key), parent: null, perItem: 'output' as const }));
    }
    const [result] = discoverColumns(outputs.map(output => ({ output })));
    return [{ ...result, perItem: 'result' }];
}

/**
 * "Incoming": aside, unless the step returned one plain value per item (the
 * Result case), which has nothing to name its rows by. A record output names
 * them itself: nameColumn picks its name, number or first readable field
 * (an invoice reads as its number), never the whole item.
 */
function itemColumn(sample: PlainObject[], outputs: OutputColumn[]): OutputColumn {
    const [item] = discoverColumns(sample.map(r => ({ item: r.item })));
    const resultOnly = outputs.length === 1 && outputs[0].perItem === 'result';
    return { ...item, role: resultOnly ? 'name' : item.role, perItem: 'item' };
}

function problemColumn(): OutputColumn {
    return { key: 'error', label: 'error', kind: 'text', technical: false, role: null, groupSize: null, parent: null, perItem: 'problem' };
}

/**
 * The columns of a list of rows. Per-item rows flatten as described above
 * (`split` does not apply to them); any other rows are discoverColumns'.
 */
export function columnsOf(rows: unknown[], split: readonly string[]): OutputColumn[] {
    if (!isPerItemRows(rows)) return discoverColumns(rows, split);
    const sample = rows.slice(0, SAMPLE_ROWS).filter(isPlainObject);
    const outputs = outputColumns(sample);
    const cols = [...outputs, itemColumn(sample, outputs)];
    if (sample.some(failed)) cols.push(problemColumn());
    return cols;
}

/**
 * One cell's value. The pinned cell of a failed per-item row has no output to
 * read, so it reads the item's field of the same name (the attachment's
 * filename), else the item's own name: the row stays recognisable.
 */
export function cellOf(row: unknown, col: OutputColumn, pinned: boolean): unknown {
    const value = getByDotted(row, col.key);
    if (!pinned || (col.perItem !== 'output' && col.perItem !== 'result')) return value;
    if (!isPlainObject(row) || row.output != null || !('item' in row)) return value;
    const last = splitLast(col.key)?.last;
    const own = last == null ? undefined : getByDotted(row.item, appendKey('', String(last)));
    return hasText(own) ? own : recordName(row.item);
}

/** A failure message without the tool name the runner puts in front of it. */
export function problemText(message: unknown): string {
    const raw = isPlainObject(message) && typeof message.message === 'string' ? message.message : message;
    return raw == null ? '' : String(raw).replace(/^[a-z0-9_]+ failed: /i, '');
}

export interface DetailParts {
    /** The failure message of a failed row (possibly empty); null when it worked. */
    problem: string | null;
    /** The output's readable fields, keyed by field name; their path is appendKey(base, key). */
    main: [string, unknown][];
    base: 'output';
    /** The output itself when it is not a record; undefined when there is none to show. */
    result: unknown | undefined;
    /** The item this row ran for. */
    incoming: unknown;
    /** The output's technical fields, then `errorClass` and `attempts` of a failed row. */
    technical: [string, unknown][];
}

/** What the details of one per-item row list. `index` and `status` never appear. */
export function detailParts(row: PlainObject): DetailParts {
    const broke = failed(row);
    const out = readableValue(row.output);
    const fields = isPlainObject(out) ? Object.entries(out) : [];
    const extra: [string, unknown][] = broke
        ? (['errorClass', 'attempts'] as const).filter(k => row[k] !== undefined).map(k => [k, row[k]])
        : [];
    return {
        problem: broke ? problemText(row.error) : null,
        main: fields.filter(([k]) => !isTechnicalKey(k)),
        base: 'output',
        result: isPlainObject(out) || (broke && out == null) ? undefined : out,
        incoming: row.item,
        technical: [...fields.filter(([k]) => isTechnicalKey(k)), ...extra],
    };
}

export interface RunNote {
    ran: number;
    failed: number;
    /** How many items ran before the step stopped at its limit; null when it did not. */
    cappedAt: number | null;
    /** How many items there were altogether, when the runner said so. */
    total: number | null;
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * The one-line run summary of a per-item step's value
 * (`{ iterations, succeeded, failed, results[, truncated, totalItems] }`).
 * Null for anything without succeeded/failed numbers beside its results: a
 * Loop container or an ordinary list keeps its own fields.
 */
export function runNoteOf(value: unknown): RunNote | null {
    if (!isPlainObject(value) || !Array.isArray(value.results)) return null;
    const { succeeded, failed: broke, iterations, truncated, totalItems } = value;
    if (!isCount(succeeded) || !isCount(broke)) return null;
    const ran = isCount(iterations) ? iterations : succeeded + broke;
    return {
        ran,
        failed: broke,
        cappedAt: truncated === true ? ran : null,
        total: isCount(totalItems) ? totalItems : null,
    };
}
