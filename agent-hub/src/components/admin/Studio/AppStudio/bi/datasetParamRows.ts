import type { TableColumn } from '../inspector/aiFieldMatching';

/**
 * The dataset builder's parameter rows, and how they become a saved
 * descriptor (server/appStudio/datasetParams.mts holds the contract).
 *
 * One row is one filter whose value the binding supplies: "region is <region>".
 * It becomes a declaration in `descriptor.params` plus a filter clause whose
 * value is `{ param: name }`. A descriptor without rows is returned as the same
 * object, so a view saved without parameters is byte for byte what it was.
 *
 * The live preview cannot send values, so it runs each parameter at its
 * default, and without its filter when it has none.
 */

/** One parameter as the builder edits it. */
export interface ParamRow {
    name: string;
    field: string;
    op: string;
    /** As typed: '' means no default. */
    defaultValue: string;
    /** No value means no rows, instead of "ignore this filter". */
    required: boolean;
}

/** What a row can be wrong about, for the message under it. */
export type ParamProblem = 'name' | 'duplicate' | 'field' | 'default';

export type ParamType = 'text' | 'number' | 'boolean' | 'date';

/** Ops a single typed value cannot drive (no value, or a list or a pair). */
const NOT_FOR_PARAMS = new Set(['isNull', 'isNotNull', 'in', 'between']);

export function isParamOp(op: string) {
    return !NOT_FOR_PARAMS.has(op);
}

/** The declared type follows the column the parameter filters. */
export function paramTypeFor(fieldType: string | undefined): ParamType {
    if (fieldType === 'number') return 'number';
    if (fieldType === 'bool') return 'boolean';
    if (fieldType === 'date' || fieldType === 'datetime') return 'date';
    return 'text';
}

/** A letter or _, then letters, digits or _, at most 40 (the server's isParamName). */
export function isParamName(name: string) {
    if (!name || name.length > 40) return false;
    for (let i = 0; i < name.length; i += 1) {
        const c = name.charCodeAt(i);
        const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
        if (!(letter || (i > 0 && c >= 48 && c <= 57))) return false;
    }
    return true;
}

/** The typed default, `undefined` for none, or null when it does not fit the type. */
function defaultFor(row: ParamRow, type: ParamType): unknown {
    const raw = row.defaultValue.trim();
    if (!raw) return undefined;
    if (type === 'number') {
        const n = Number(raw.replace(',', '.'));
        return Number.isFinite(n) ? n : null;
    }
    if (type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : null;
    if (type === 'date') return Number.isNaN(Date.parse(raw)) ? null : raw;
    return raw;
}

/** What is wrong with each row, by index (no entry: nothing). */
export function paramProblems(rows: ParamRow[], fields: TableColumn[]): Record<number, ParamProblem> {
    const out: Record<number, ParamProblem> = {};
    const seen = new Set<string>();
    rows.forEach((row, i) => {
        const field = fields.find((f) => f.key === row.field);
        if (!isParamName(row.name)) out[i] = 'name';
        else if (seen.has(row.name)) out[i] = 'duplicate';
        else if (!field || !row.op) out[i] = 'field';
        else if (defaultFor(row, paramTypeFor(field.type)) === null) out[i] = 'default';
        seen.add(row.name);
    });
    return out;
}

type Descriptor = { filters?: unknown[]; [key: string]: unknown };

/**
 * The descriptor to save and the one to preview. Rows are assumed checked
 * (paramProblems empty); with no rows both are the descriptor itself.
 */
export function applyParamRows<D extends Descriptor>(descriptor: D, rows: ParamRow[], fields: TableColumn[]): { saved: D; preview: D } {
    if (!rows.length) return { saved: descriptor, preview: descriptor };
    const params: Array<Record<string, unknown>> = [];
    const savedClauses: Array<Record<string, unknown>> = [];
    const previewClauses: Array<Record<string, unknown>> = [];
    for (const row of rows) {
        const type = paramTypeFor(fields.find((f) => f.key === row.field)?.type);
        const dflt = defaultFor(row, type);
        params.push({ name: row.name, ...(type !== 'text' ? { type } : {}), ...(dflt !== undefined && dflt !== null ? { default: dflt } : {}) });
        savedClauses.push({ field: row.field, op: row.op, value: { param: row.name }, ...(row.required ? { required: true } : {}) });
        if (dflt !== undefined && dflt !== null) previewClauses.push({ field: row.field, op: row.op, value: dflt });
    }
    const filters = Array.isArray(descriptor.filters) ? descriptor.filters : [];
    return {
        saved: { ...descriptor, params, filters: [...filters, ...savedClauses] },
        preview: { ...descriptor, filters: [...filters, ...previewClauses] },
    };
}
