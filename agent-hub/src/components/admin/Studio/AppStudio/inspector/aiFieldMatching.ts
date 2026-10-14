/**
 * Pure helpers behind the AI action editors (AiActionEditors.jsx): how a form
 * field becomes a binding, and how an ai_extract output schema lines up with the
 * columns of the data table it writes to.
 *
 * The matching rules live here rather than in the editor because the executor
 * applies the same idea server-side (actionExecutor.resolveWriteMapping: an
 * output field with no explicit mapping goes to the column of the same name).
 * Keep the two honest about each other.
 */

const FORM_FIELD_RE = /^form\.([A-Za-z_$][\w$]*)$/;

/** The columns of a data table, as far as this module reads them. */
export interface ColumnLike {
    key: string;
    name?: string;
    type: string;
    required?: boolean;
    options?: Array<string | { value?: string }>;
}

/** One field of an ai_extract output schema. */
export interface SchemaField {
    name: string;
    type: string | undefined;
    description: string;
    required: boolean;
}

/**
 * `formula` is the only binding kind that both passes validation (BINDING_KINDS
 * has no `field`) and resolves a raw form value server-side.
 */
export const bindingForField = (name: string | null | undefined): { kind: 'formula'; expr: string } | null => (name ? { kind: 'formula', expr: `form.${name}` } : null);

export const fieldNameFromBinding = (b: { kind?: string; expr?: unknown } | null | undefined): string => {
    if (b && b.kind === 'formula' && typeof b.expr === 'string') {
        const m = b.expr.match(FORM_FIELD_RE);
        return m ? m[1] : '';
    }
    return '';
};

export const sanitizeVarName = (v: string): string => v.replace(/[^A-Za-z0-9_]/g, '').slice(0, 60);

/**
 * Data-table column type (dataModel.FIELD_TYPES) → AI schema field type.
 * Columns absent from this map are ones the AI cannot sensibly fill on its own —
 * `relation` needs a record id, `file` needs an upload, `computed` is
 * server-managed — so they are never derived into a schema.
 */
const COLUMN_SCHEMA_TYPE: Record<string, string> = {
    text: 'string', richtext: 'string', select: 'string',
    number: 'number', date: 'date', datetime: 'date',
    bool: 'boolean', multiselect: 'array',
};

/** Columns a write may target: everything except the server-managed computed ones. */
export const writableColumns = <C extends ColumnLike>(columns: C[] | null | undefined): C[] => (Array.isArray(columns) ? columns : []).filter((c) => c && c.key && c.type !== 'computed');

export const extractableColumns = <C extends ColumnLike>(columns: C[] | null | undefined): C[] => (Array.isArray(columns) ? columns : []).filter((c) => c && c.key && COLUMN_SCHEMA_TYPE[c.type]);

/** "Invoice Number" / "invoiceNumber" / "invoice_number" all normalize alike. */
const normalizeName = (s: string | undefined): string => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * One output field per extractable column of the table — the column's own name
 * (and, for select columns, its allowed values) becomes the description, which
 * is what steers the AI at extraction time. Schema names allow 60 chars where
 * table keys allow 63, hence the slice.
 */
export function schemaFromColumns(columns: ColumnLike[] | null | undefined): SchemaField[] {
    const out: SchemaField[] = [];
    const seen = new Set<string>();
    for (const c of extractableColumns(columns)) {
        const name = String(c.key).slice(0, 60);
        if (seen.has(name)) continue;
        seen.add(name);
        const options: string[] = Array.isArray(c.options) ? c.options.map((o) => (typeof o === 'string' ? o : o?.value)).filter((v): v is string => Boolean(v)) : [];
        const label = c.name && c.name !== c.key ? c.name : '';
        const description = options.length
            ? `${label || name}. One of: ${options.join(', ')}`.slice(0, 500)
            : label;
        out.push({ name, type: COLUMN_SCHEMA_TYPE[c.type], description, required: !!c.required });
        if (out.length >= 40) break;  // validate.js caps an aiSchema at 40 fields
    }
    return out;
}

/**
 * { column: fieldName } for every output field that names a column — exactly, or
 * once case and punctuation are normalized away, or by the column's display
 * name. Fields with no matching column (and columns with no field) are simply
 * left out, so a partial match still writes the columns it did match.
 */
export function autoMapping(
    schemaFields: Array<{ name?: string }> | null | undefined,
    columns: ColumnLike[] | null | undefined,
): Record<string, string> {
    const cols = writableColumns(columns);
    const byKey = new Map<string, ColumnLike>(cols.map((c): [string, ColumnLike] => [c.key, c]));
    const byNorm = new Map<string, ColumnLike>();
    for (const c of cols) {
        for (const alias of [c.key, c.name]) {
            const n = normalizeName(alias);
            if (n && !byNorm.has(n)) byNorm.set(n, c);
        }
    }
    const mapping: Record<string, string> = {};
    const taken = new Set<string>();
    for (const f of (Array.isArray(schemaFields) ? schemaFields : [])) {
        if (!f?.name) continue;
        const hit = byKey.get(f.name) || byNorm.get(normalizeName(f.name));
        if (!hit || taken.has(hit.key)) continue;
        taken.add(hit.key);
        mapping[hit.key] = f.name;
    }
    return mapping;
}

/**
 * A schema still carrying only placeholder names ("field1") that nobody has
 * described yet — worth replacing outright with the table's real columns.
 */
export const isUntouchedSchema = (fields: Array<{ name?: string; description?: string }> | null | undefined): boolean => (Array.isArray(fields) ? fields : [])
    .every((f) => /^field\d*$/.test(f?.name || '') && !String(f?.description || '').trim());
