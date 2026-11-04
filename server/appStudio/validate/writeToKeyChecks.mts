/**
 * App Studio validator — writeTo.upsertKey and writeTo.replaceWhere on ai_extract / file_intake /
 * dataset_query (package 5, moved out of validate/actions.js and validate.js).
 *
 *   upsertKey     the columns that together say which row a written row IS: 1..5 distinct
 *                 columns of the table, not computed, each written by the mapping or the
 *                 constants (a key nobody writes matches nothing and every run doubles the
 *                 table again). A date constant in the key is a warning (a stamp never matches).
 *   replaceWhere  the rows to delete before writing: the same clause grammar as a filter-mode
 *                 delete_record, and never empty (that would replace the whole table).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type FieldTypes = Map<string, Map<string, string>>;
type Ctx = { pushE: (f: Finding) => void; pushW: (f: Finding) => void; dataFieldTypes?: FieldTypes | null };
type Obj = Record<string, unknown>;

const { LIMITS } = nodeRequire('../componentSpecs/limits') as { LIMITS: Record<string, number> };
const refs = (): { checkFieldRef(tableId: unknown, col: string, path: string, ctx: Ctx, label: string, o: { codePrefix: string; allowSystem: boolean }): void } => nodeRequire('./refs');
const stepDataChecks = (): { checkWriteFilter(filter: unknown, path: string, tableId: unknown, ctx: Ctx, label: string): void } => nodeRequire('./stepDataChecks');

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o: Obj, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * opts.dataModel → Map(tableId → Map(fieldKey → type)), for the checks that need the column's
 * type (a computed column in writeTo.upsertKey, a date stamp in the key). null without a model.
 */
export function buildFieldTypes(dataModel: unknown): FieldTypes | null {
    if (dataModel === undefined) return null;
    const map: FieldTypes = new Map();
    const tables = isObject(dataModel) && Array.isArray(dataModel.tables) ? dataModel.tables : [];
    for (const t of tables) {
        if (!isObject(t) || typeof t.id !== 'string' || !t.id) continue;
        const types = new Map<string, string>();
        for (const f of (Array.isArray(t.fields) ? t.fields : [])) {
            if (isObject(f) && typeof f.key === 'string' && f.key && typeof f.type === 'string') types.set(f.key, f.type);
        }
        map.set(t.id, types);
    }
    return map;
}

/** The model field `col` of table `tableId`, or null. */
function tableField(ctx: Ctx, tableId: unknown, col: string): { type: string } | null {
    const types = ctx && ctx.dataFieldTypes && typeof tableId === 'string' ? ctx.dataFieldTypes.get(tableId) : null;
    const type = types ? types.get(col) : undefined;
    return type ? { type } : null;
}

const invalid = (path: string, message: string, hint: string): Finding => ({ code: 'action.ai_writeto_invalid', severity: 'error', path, message, hint });

export function validateAiWriteToKey(kind: string, value: Obj, path: string, ctx: Ctx): void {
    const { pushE, pushW } = ctx;
    if (value.upsertKey === undefined) return;
    const at = `${path}.upsertKey`;
    const key = value.upsertKey;
    if (!Array.isArray(key) || !key.length || key.some((c) => typeof c !== 'string' || !c)) {
        pushE(invalid(at, '`writeTo.upsertKey` must be a list of 1 to 5 column keys.', 'E.g. ["po_number", "line"]; omit it to always insert.'));
        return;
    }
    if (key.length > LIMITS.MAX_UPSERT_KEY_COLUMNS || new Set(key).size !== key.length) {
        pushE(invalid(at, `\`writeTo.upsertKey\` must name at most ${LIMITS.MAX_UPSERT_KEY_COLUMNS} distinct columns (has ${key.length}).`, 'List each identifying column once.'));
        return;
    }
    if (value.upsertOn !== undefined) {
        pushE(invalid(`${path}.upsertOn`, '`writeTo.upsertOn` and `writeTo.upsertKey` cannot both be set.', 'Put the upsertOn column into upsertKey and remove upsertOn.'));
    }
    const mapping = isObject(value.mapping) ? value.mapping : {};
    const constants = isObject(value.constants) ? value.constants : {};
    const autoMapped = kind === 'ai_extract' && !Object.keys(mapping).length;
    (key as string[]).forEach((col, i) => {
        refs().checkFieldRef(value.tableId, col, `${at}[${i}]`, ctx, `Step "${kind}" writeTo.upsertKey`, { codePrefix: 'step', allowSystem: false });
        const field = tableField(ctx, value.tableId, col);
        if (field && field.type === 'computed') {
            pushE(invalid(`${at}[${i}]`, `\`writeTo.upsertKey\` names the computed column "${col}", which is never written.`, 'Key on a column the step writes.'));
            return;
        }
        if (!has(mapping, col) && !has(constants, col) && !autoMapped) {
            pushE(invalid(`${at}[${i}]`, `\`writeTo.upsertKey\` names "${col}", which neither the mapping nor the constants write.`, 'Map a field to that column, or key on a column the step fills.'));
            return;
        }
        if (has(constants, col) && field && (field.type === 'date' || field.type === 'datetime')) {
            pushW({ code: 'action.ai_writeto_key_stamp', severity: 'warning', path: `${at}[${i}]`, message: `\`writeTo.upsertKey\` includes the date constant "${col}": a stamp like now differs on every run, so no row is ever matched.`, hint: 'Leave stamps out of the key.' });
        }
    });
}

export function validateAiWriteToReplace(kind: string, value: Obj, path: string, ctx: Ctx): void {
    if (value.replaceWhere === undefined) return;
    stepDataChecks().checkWriteFilter(value.replaceWhere, `${path}.replaceWhere`, value.tableId, ctx, `Step "${kind}" writeTo.replaceWhere`);
}
