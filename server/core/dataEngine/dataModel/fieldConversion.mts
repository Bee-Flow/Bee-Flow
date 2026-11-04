/**
 * App Studio data model: converting a field's type in place while the table
 * holds rows.
 *
 * Only a handful of pairs convert without a judgement call, and only those are
 * offered (SAFE_CONVERSIONS): text and select hold the same text, a number
 * turns into its text, a text turns into a number when it IS one, and whole
 * numbers move between the two numeric kinds. Everything else (a date, a
 * relation, a computed field) stays what it was: the builder refuses it and the
 * schema route keeps saving it model-only, as before.
 *
 * A value that does not fit the new type is "unconvertible": text that is not a
 * strict JSON number (after trim; '12,50' and '007' are not), a select value
 * that is not one of the options, a number with a fraction going to whole
 * numbers. The empty string and NULL are empty and become NULL. The planner
 * counts them inside the migration transaction and refuses the save, unless
 * the caller asked to clear them (onUnconvertible: 'clear'), when they become
 * NULL.
 *
 * Postgres converts with ALTER COLUMN TYPE … USING; SQLite (dynamic types, no
 * ALTER COLUMN) swaps through a shadow column. text ⇄ select needs no DDL in
 * either: both are TEXT.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const ddl = nodeRequire('./ddl.js') as {
    qi: (name: string) => string;
    sqlLiteral: (value: unknown, field: unknown, dialect?: string) => string;
    columnType: (field: unknown, dialect?: string) => string;
    uniqueIndexName: (tableId: string, fieldId: string) => string;
};
const { resolveDialect } = nodeRequire('../engineFlag.js') as { resolveDialect: (o: { dialect?: string }) => string };

export interface ConvField {
    id: string;
    key: string;
    type?: string;
    subtype?: string | null;
    options?: unknown[];
    unique?: boolean;
    required?: boolean;
    default?: unknown;
}

export interface Conversion {
    from: string;
    to: string;
    safe: boolean;
}

export type OnUnconvertible = 'refuse' | 'clear';

/** The type as a conversion reads it: a number with subtype integer is its own kind. */
export function logicalType(f: { type?: string; subtype?: string | null } | null | undefined): string {
    if (!f) return '';
    if (f.type === 'number' && f.subtype === 'integer') return 'integer';
    return String(f.type || '');
}

/** The pairs that convert in place (from>to on logicalType). */
export const SAFE_CONVERSIONS: ReadonlySet<string> = new Set([
    'text>select', 'select>text',
    'text>number', 'number>text',
    'text>integer', 'integer>text',
    'integer>number', 'number>integer',
]);

/**
 * The conversion between two versions of one field, or null when its type did
 * not change. A pair outside SAFE_CONVERSIONS comes back with safe:false.
 */
export function fieldConversion(oldF: ConvField | null | undefined, newF: ConvField | null | undefined): Conversion | null {
    if (!oldF || !newF) return null;
    const from = logicalType(oldF);
    const to = logicalType(newF);
    if (from === to) return null;
    return { from, to, safe: SAFE_CONVERSIONS.has(`${from}>${to}`) };
}

/** Option values of a select field (strings or {value,label}). */
export function selectOptionValues(f: ConvField): string[] {
    const out: string[] = [];
    for (const o of Array.isArray(f.options) ? f.options : []) {
        const v = typeof o === 'string' ? o : (o && typeof o === 'object' ? ((o as { value?: unknown }).value ?? (o as { label?: unknown }).label) : null);
        if (typeof v === 'string') out.push(v);
    }
    return out;
}

function lit(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
}

// A strict JSON number after trim; whole numbers up to 15 digits (inside both
// BIGINT and a JavaScript number without loss).
const PG_NUMBER_RE = "'^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?$'";
const PG_INTEGER_RE = "'^-?(0|[1-9][0-9]{0,14})$'";
// The text form of a whole number (a NUMERIC renders 20 as '20' or '20.00').
const PG_WHOLE_RE = "'^-?(0|[1-9][0-9]{0,14})(\\.0+)?$'";

function isPg(dialect?: string): boolean {
    return resolveDialect({ dialect }) === 'pg';
}

/**
 * The column as text. On Postgres the column's storage type can differ from the
 * model's (a type change used to save model-only), so every predicate reads the
 * text form; a TEXT column reads the same.
 */
function asText(c: string, pg: boolean): string {
    return pg ? `(${c})::text` : c;
}

/** The column holds a value (not NULL, not blank text). */
function textPresent(c: string, pg: boolean): string {
    return pg ? `NULLIF(btrim(${asText(c, pg)}), '') IS NOT NULL` : `(${c} IS NOT NULL AND trim(${c}) <> '')`;
}

/** The (present) text value is a number of the target kind. */
function textIsNumber(c: string, to: string, pg: boolean): string {
    if (pg) return `btrim(${asText(c, pg)}) ~ ${to === 'integer' ? PG_INTEGER_RE : PG_NUMBER_RE}`;
    // ELSE '': a NULL here would turn NOT (… IN …) into NULL and hide the value.
    const jt = `CASE WHEN json_valid(trim(${c})) THEN json_type(trim(${c})) ELSE '' END`;
    return to === 'integer'
        ? `(${jt} = 'integer' AND length(ltrim(trim(${c}), '-')) <= 15)`
        : `(${jt} IN ('integer', 'real'))`;
}

/**
 * The predicate of the rows whose value cannot convert, or null when every
 * value converts (number → text, integer → number, select → text).
 */
export function unconvertibleWhere(conv: Conversion, col: string, newF: ConvField, dialect?: string): string | null {
    const pg = isPg(dialect);
    const c = ddl.qi(col);
    const pair = `${conv.from}>${conv.to}`;
    if (pair === 'text>select') {
        const opts = selectOptionValues(newF);
        const t = asText(c, pg);
        const present = `(${c} IS NOT NULL AND ${t} <> '')`;
        return opts.length ? `${present} AND ${t} NOT IN (${opts.map(lit).join(', ')})` : present;
    }
    if (pair === 'text>number' || pair === 'text>integer') {
        return `${textPresent(c, pg)} AND NOT ${textIsNumber(c, conv.to, pg)}`;
    }
    if (pair === 'number>integer') {
        // Postgres: the text form against a whole-number pattern, never numeric
        // math on a column that may not be NUMERIC; blank text is empty.
        return pg
            ? `${textPresent(c, pg)} AND NOT (btrim(${asText(c, pg)}) ~ ${PG_WHOLE_RE})`
            : `${c} IS NOT NULL AND (typeof(${c}) NOT IN ('integer', 'real') OR ${c} <> CAST(${c} AS INTEGER) OR abs(${c}) >= 1e15)`;
    }
    return null;
}

/** The new value of one row (unconvertible → NULL), as an SQL expression over the old column. */
export function convertedValueSql(conv: Conversion, col: string, newF: ConvField, dialect?: string): string {
    const pg = isPg(dialect);
    const c = ddl.qi(col);
    const bad = unconvertibleWhere(conv, col, newF, dialect);
    const guard = (expr: string) => (bad ? `CASE WHEN ${bad} THEN NULL ELSE ${expr} END` : expr);
    switch (`${conv.from}>${conv.to}`) {
        case 'text>number':
            return `CASE WHEN NOT ${textPresent(c, pg)} THEN NULL ELSE ${guard(pg ? `btrim(${asText(c, pg)})::numeric` : `CAST(trim(${c}) AS REAL)`)} END`;
        case 'text>integer':
            return `CASE WHEN NOT ${textPresent(c, pg)} THEN NULL ELSE ${guard(pg ? `btrim(${asText(c, pg)})::bigint` : `CAST(trim(${c}) AS INTEGER)`)} END`;
        case 'number>text':
            // SQLite renders a whole REAL as '20.0'; the text a person typed was '20'.
            return pg ? `${c}::text`
                : `CASE WHEN typeof(${c}) = 'real' AND abs(${c}) < 1e15 AND ${c} = CAST(${c} AS INTEGER) THEN CAST(CAST(${c} AS INTEGER) AS TEXT) ELSE CAST(${c} AS TEXT) END`;
        case 'integer>text':
            return pg ? `${c}::text` : `CAST(${c} AS TEXT)`;
        case 'integer>number':
            return pg ? `${c}::numeric` : `CAST(${c} AS REAL)`;
        case 'number>integer':
            return pg
                ? `CASE WHEN NOT ${textPresent(c, pg)} THEN NULL ELSE ${guard(`btrim(${asText(c, pg)})::numeric::bigint`)} END`
                : guard(`CAST(${c} AS INTEGER)`);
        default:
            // text ⇄ select: the same text.
            return guard(c);
    }
}

export interface ConversionDdlInput {
    table: { id: string; key: string };
    oldF: ConvField;
    newF: ConvField;
    conv: Conversion;
    onUnconvertible?: OnUnconvertible;
    dialect?: string;
}

/**
 * The statements that convert one column in place. The column already carries
 * the NEW key (renames run first). Values that cannot convert become NULL; in
 * refuse mode the planner's probe refuses the whole save before COMMIT.
 */
export function conversionDdl({ table, oldF, newF, conv, onUnconvertible = 'refuse', dialect }: ConversionDdlInput): string[] {
    const pg = isPg(dialect);
    const t = ddl.qi(table.key);
    const c = ddl.qi(newF.key);
    const pair = `${conv.from}>${conv.to}`;
    if (pair === 'text>select' || pair === 'select>text') {
        // Same storage. Only the clear mode touches rows.
        const bad = unconvertibleWhere(conv, newF.key, newF, dialect);
        return bad && onUnconvertible === 'clear' ? [`UPDATE ${t} SET ${c} = NULL WHERE ${bad}`] : [];
    }
    const value = convertedValueSql(conv, newF.key, newF, dialect);
    const hasDefault = newF.default !== undefined && newF.default !== null;
    if (pg) {
        const out = [
            `ALTER TABLE ${t} ALTER COLUMN ${c} DROP DEFAULT`,
            // Requiredness lives in the app; a NOT NULL could refuse a cleared value.
            `ALTER TABLE ${t} ALTER COLUMN ${c} DROP NOT NULL`,
            `ALTER TABLE ${t} ALTER COLUMN ${c} TYPE ${ddl.columnType(newF, 'pg')} USING (${value})`,
        ];
        if (hasDefault) out.push(`ALTER TABLE ${t} ALTER COLUMN ${c} SET DEFAULT ${ddl.sqlLiteral(newF.default, newF, 'pg')}`);
        return out;
    }
    // SQLite: a shadow column takes the converted values, then takes the name.
    const shadow = ddl.qi(`_cv_${newF.id}`);
    const uq = ddl.qi(ddl.uniqueIndexName(table.id, newF.id));
    const out: string[] = [];
    if (oldF.unique) out.push(`DROP INDEX IF EXISTS ${uq}`);
    out.push(
        `ALTER TABLE ${t} ADD COLUMN ${shadow} ${ddl.columnType(newF, 'sqlite')}${hasDefault ? ` DEFAULT ${ddl.sqlLiteral(newF.default, newF, 'sqlite')}` : ''}`,
        `UPDATE ${t} SET ${shadow} = ${value}`,
        `ALTER TABLE ${t} DROP COLUMN ${c}`,
        `ALTER TABLE ${t} RENAME COLUMN ${shadow} TO ${c}`,
    );
    if (newF.unique) out.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${uq} ON ${t} (${c})`);
    return out;
}

/**
 * Does a computed expression read the column `key`? String literals are
 * stripped first; an over-approximation only costs an extra recompute.
 */
export function exprMentions(expr: unknown, key: string): boolean {
    if (typeof expr !== 'string' || !key) return false;
    const stripped = expr.replace(/'(?:[^']|'')*'/g, "''");
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_])"?${esc}"?($|[^A-Za-z0-9_])`).test(stripped);
}
