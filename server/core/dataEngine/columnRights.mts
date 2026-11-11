/**
 * COLUMN RIGHTS: which roles may read a field, and which may write it.
 *
 *   field.access = { read?: [roleKey, …], write?: [roleKey, …] }        (optional, schema 3)
 *
 * A field without `access` behaves as it always did: every role that reaches the
 * table reads and writes it. The rules, in full:
 *
 *   - `read` lists the roles that may read the field. Left out: every role. An
 *     empty list: nobody but the owner.
 *   - `write` lists the roles that may write it. Left out, it follows `read`
 *     (a role is never given more to write than to read by omission); with
 *     neither, every role.
 *   - The app OWNER reads and writes every field. Nobody else is implied: the
 *     anonymous `public` role has a field with a list only when the list names it.
 *   - A computed field is hidden from a role when its expression names a field
 *     that is hidden from that role (or cannot be read here to tell), and a lookup
 *     field when the relation it reads through is (columnRightsLinked.mts has the
 *     rest of the rules for lookup, rollup and many-relation fields).
 *
 * ── HOW IT IS ENFORCED ───────────────────────────────────────────────
 *
 * READS, in the query compiler. accessFilter.compileAccessFilter hands every
 * caller the row predicate; for a table that declares column rights it also
 * carries `columns`, the verdict for that role (columnRightsFor). Every compiler
 * that reads rows takes the access filter already, and starts with
 * `scopeColumns(tableMeta, accessFilter)`: the table as that role sees it, the
 * hidden fields gone. From there the compiler's own closed field resolver does
 * the rest, so a hidden field behaves as a field that does not exist:
 *
 *   REFUSED (422 `unknown field: <name>`, the answer for a name that is no field
 *   at all), wherever the request names the field to pick, order or fold rows:
 *   a filter (any operator, a column comparison, inside a group), sort, orderBy,
 *   search.fields, groupBy, an aggregate, groupFilter (through its aggregate), a
 *   relation path (`relation.field`, `relatedField`), an upsert key, and the
 *   filter of a bulk update or delete. Dropping such a clause instead would
 *   answer a different question than the one asked (more rows, other groups),
 *   and a write through that filter would touch rows nobody meant.
 *
 *   LEFT OUT, where the request only says what to return: the record itself
 *   (no `*`: the visible columns by name), `fields`, an expansion's `pick` and
 *   its label, the expansion of a hidden relation, and computed fields. The page
 *   that asks for the field shows it empty for that role, and the read goes on.
 *
 * A table with column rights compiled under an access filter WITHOUT a verdict is
 * refused (scopeColumns throws): a read door that forgot to resolve the rights
 * fails closed instead of reading every column. A system path that reads as the
 * owner says so with accessFilter.OWNER_ACCESS.
 *
 * WRITES, in fieldRules.applyFieldRules (the one place every App Studio write
 * passes before it is compiled), through `writableValues`: a value for a field
 * the role may not write is refused with FieldAccessError (403,
 * `field_not_writable`). On a create an EMPTY value for such a field is left
 * out instead (a form submits null for a field nobody touched), so the field's
 * default applies. Values the server assigns (a dynamic default, a column
 * default, an autonumber, a computed column, the system columns) are filled
 * after this check and are not the viewer's writes. Step writes run as the
 * viewer, so they follow the viewer's rights.
 *
 * LAYER: core/, pure functions of a table descriptor and a role.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Field = {
    key?: string; name?: string; type?: string; unique?: boolean; access?: unknown;
    computed?: { stored?: boolean; expr?: unknown } | null;
    lookup?: { relation?: unknown } | null;
};
type TableMeta = { key?: string; fields?: (Field | null)[] | null; source?: unknown };
type Token = { kind: string; text: string };

const { SYSTEM_COLUMNS, KEY_RE, PUBLIC_ROLE_KEY } = nodeRequire('./dataModel/vocabulary') as {
    SYSTEM_COLUMNS: readonly string[]; KEY_RE: RegExp; PUBLIC_ROLE_KEY: string;
};
const { CompileError } = nodeRequire('./queryCompilerCore') as { CompileError: new (message: string) => Error };
const { isColumnlessLinkField } = nodeRequire('./dataModel/linkedFields') as { isColumnlessLinkField(f: unknown): boolean };
const { lexReadTimeExpr } = nodeRequire('./queryCompilerComputed.mts') as {
    lexReadTimeExpr(expr: string): { tokens: Token[] } | { error: string };
};
const { AccessError } = nodeRequire('./rowFilterSql.mts') as {
    AccessError: new (message: string, status?: number) => Error & { status: number };
};

/** The keys of `field.access`. */
export const FIELD_ACCESS_KEYS: readonly string[] = Object.freeze(['read', 'write']);
/** The most roles one list names (a validity limit, so a constant). */
export const MAX_FIELD_ACCESS_ROLES = 50;

const OWNER_ROLE = 'owner';

/** What a role may not read or write of one table. Made by columnRightsFor only. */
export type ColumnVerdict = { readonly table: string; readonly hidden: readonly string[]; readonly readOnly: readonly string[] };

/** Every verdict this module made: scopeColumns accepts no other object. */
const VERDICTS = new WeakSet<object>();

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function fieldsOf(tableMeta: unknown): Field[] {
    const fields = isObject(tableMeta) && Array.isArray(tableMeta.fields) ? tableMeta.fields as (Field | null)[] : [];
    return fields.filter((f): f is Field => isObject(f) && typeof f.key === 'string' && f.key !== '');
}

/** The role list under one key of `field.access`, or null when the field does not declare it. */
function rolesOf(field: Field, key: 'read' | 'write'): string[] | null {
    const access = isObject(field.access) ? field.access : null;
    const list = access ? access[key] : undefined;
    return Array.isArray(list) ? list.filter((r): r is string => typeof r === 'string') : null;
}

/** Does this relation field carry an onDelete rule (dataModel/linkedFields.js)? */
function hasDeleteRule(field: Field): boolean {
    const relation = (field as { relation?: unknown }).relation;
    return isObject(relation) && relation.onDelete !== undefined && relation.onDelete !== null;
}

function declares(field: Field): boolean {
    return rolesOf(field, 'read') !== null || rolesOf(field, 'write') !== null;
}

/** Does any field of this table declare column rights? False for every table made before them. */
export function hasColumnRights(tableMeta: unknown): boolean {
    return fieldsOf(tableMeta).some(declares);
}

const named = (list: string[], role: unknown): boolean => typeof role === 'string' && role !== '' && list.includes(role);

/** The field's own `read` list (not what its expression names). */
function listedForRead(field: Field, role: unknown): boolean {
    if (role === OWNER_ROLE) return true;
    const read = rolesOf(field, 'read');
    return read === null || named(read, role);
}

function listedForWrite(field: Field, role: unknown): boolean {
    if (role === OWNER_ROLE) return true;
    const list = rolesOf(field, 'write') ?? rolesOf(field, 'read');
    return list === null || named(list, role);
}

/** The names a computed expression holds (lower-cased words and quoted names), or null when it cannot be read. */
function namesIn(expr: unknown): Set<string> | null {
    if (typeof expr !== 'string') return null;
    const lexed = lexReadTimeExpr(expr);
    if ('error' in lexed) return null;
    const out = new Set<string>();
    for (const t of lexed.tokens) {
        if (t.kind === 'word') out.add(t.text.toLowerCase());
        else if (t.kind === 'quoted') out.add(t.text);
    }
    return out;
}

/** Field types no person writes: the server computes or reads them. */
const NEVER_WRITTEN: readonly string[] = Object.freeze(['computed', 'autonumber', 'lookup', 'rollup']);

/** The names a derived field reads from its own table: a computed field's expression, a lookup's relation. */
function derivedNames(f: Field): Set<string> | null {
    if (f.type === 'lookup') return new Set(isObject(f.lookup) && typeof f.lookup.relation === 'string' ? [f.lookup.relation] : []);
    return namesIn(f.computed ? f.computed.expr : undefined);
}

/**
 * The field keys `role` may not read: the fields whose `read` list leaves the
 * role out, every computed field whose expression names one of them, and every
 * lookup through one of them (repeated until nothing changes, so a computed
 * field over a computed field follows). Empty for the owner and for a table
 * without column rights.
 */
export function hiddenFields(tableMeta: unknown, role: unknown): Set<string> {
    const fields = fieldsOf(tableMeta);
    const hidden = new Set<string>();
    for (const f of fields) if (!listedForRead(f, role)) hidden.add(f.key as string);
    if (hidden.size === 0) return hidden;
    const computed = fields
        .filter((f) => (f.type === 'computed' || f.type === 'lookup') && !hidden.has(f.key as string))
        .map((f) => ({ key: f.key as string, names: derivedNames(f) }));
    for (let grew = true; grew;) {
        grew = false;
        for (const c of computed) {
            if (hidden.has(c.key)) continue;
            // An expression this module cannot read is hidden with the rest: it may name anything.
            if (c.names === null || [...c.names].some((n) => hidden.has(n))) { hidden.add(c.key); grew = true; }
        }
    }
    return hidden;
}

/**
 * May `role` read field `fieldKey` of this table? The one question another read
 * feature asks before it serves a value by a way of its own (a lookup, a
 * rollup). System columns: yes. A name that is no field of the table: no.
 */
export function canReadField(tableMeta: unknown, role: unknown, fieldKey: unknown): boolean {
    if (typeof fieldKey !== 'string' || !fieldKey) return false;
    if (SYSTEM_COLUMNS.includes(fieldKey)) return true;
    if (!fieldsOf(tableMeta).some((f) => f.key === fieldKey)) return false;
    return !hiddenFields(tableMeta, role).has(fieldKey);
}

/** May `role` write field `fieldKey`? (The table's own create/update right is asked elsewhere.) */
export function canWriteField(tableMeta: unknown, role: unknown, fieldKey: unknown): boolean {
    const field = fieldsOf(tableMeta).find((f) => f.key === fieldKey);
    return !!field && listedForWrite(field, role);
}

/**
 * The verdict for (table, role), or null for a table without column rights
 * (then nothing changes anywhere). The owner's verdict is empty, and present:
 * it is the proof that the rights were resolved.
 */
export function columnRightsFor(tableMeta: unknown, role: unknown): ColumnVerdict | null {
    if (!hasColumnRights(tableMeta)) return null;
    const verdict: ColumnVerdict = Object.freeze({
        table: String((tableMeta as TableMeta).key),
        hidden: Object.freeze([...hiddenFields(tableMeta, role)]),
        readOnly: Object.freeze(fieldsOf(tableMeta).filter((f) => !listedForWrite(f, role)).map((f) => f.key as string)),
    });
    VERDICTS.add(verdict);
    return verdict;
}

/** The verdict of a path that reads as the owner or the system, for any table. */
export const ALL_COLUMNS: ColumnVerdict = Object.freeze({ table: '*', hidden: Object.freeze([]), readOnly: Object.freeze([]) });
VERDICTS.add(ALL_COLUMNS);

/**
 * The access of a path that reads and writes as the owner or the system (a
 * sync, a retention job, a row count): every row, every column, of any table.
 */
export const OWNER_ACCESS: Readonly<{ where: string; params: unknown[]; columns: ColumnVerdict }> = Object.freeze({ where: '1=1', params: [], columns: ALL_COLUMNS });

/** The table as the role behind `accessFilter` reads it; `hidden` is null when that is the whole table. */
export type ColumnScope<T> = { tableMeta: T; hidden: ReadonlySet<string> | null };

/**
 * Called first by every compiler that reads rows. A table without column rights
 * comes back as the same object. One with them needs the verdict
 * compileAccessFilter put on the access filter, for this table; anything else
 * is refused, so a read that never resolved the rights reads nothing.
 */
export function scopeColumns<T extends TableMeta>(tableMeta: T, accessFilter: unknown): ColumnScope<T> {
    if (!hasColumnRights(tableMeta)) return { tableMeta, hidden: null };
    const verdict = isObject(accessFilter) ? accessFilter.columns as ColumnVerdict | undefined : undefined;
    if (!verdict || !VERDICTS.has(verdict) || (verdict.table !== '*' && verdict.table !== tableMeta.key)) {
        throw new CompileError(`table "${tableMeta.key}" has fields with column rights, and this read did not resolve them for its viewer`);
    }
    if (verdict.hidden.length === 0) return { tableMeta, hidden: null };
    const hidden = new Set(verdict.hidden);
    const fields = (Array.isArray(tableMeta.fields) ? tableMeta.fields : []).filter((f) => !(f && typeof f.key === 'string' && hidden.has(f.key)));
    return { tableMeta: { ...tableMeta, fields }, hidden };
}

type Related<T> = Record<string, { tableMeta: T; accessFilter: unknown; hidden?: ReadonlySet<string> }>;

/**
 * The related tables of a read (expand, relation.field, relatedField), each as
 * its own access filter's role reads it, with `hidden` beside a table that lost
 * fields. The same object when no related table is restricted.
 */
export function scopeRelated<T extends TableMeta, R extends Related<T> | undefined>(related: R): R {
    if (!related) return related;
    let out: Related<T> | null = null;
    for (const [key, target] of Object.entries(related)) {
        if (!target || !isObject(target.tableMeta)) continue;
        const scoped = scopeColumns(target.tableMeta, target.accessFilter);
        if (!scoped.hidden) continue;
        out = out || { ...related };
        out[key] = { ...target, tableMeta: scoped.tableMeta, hidden: scoped.hidden };
    }
    return (out || related) as R;
}

type ReadShape = { related?: Related<TableMeta>; hidden?: ReadonlySet<string> };

/**
 * The `read` argument of a record list (relationRead.mts) for a scoped table:
 * its related tables scoped, and the main table's hidden fields beside them so
 * `fields` and `expand` leave those out. The same value when nothing is hidden anywhere.
 */
export function scopeRead<R extends ReadShape | undefined>(read: R, hidden: ReadonlySet<string> | null): R {
    if (!read) return read;
    const related = scopeRelated(read.related);
    if (related === read.related && !hidden) return read;
    return { ...read, related, ...(hidden ? { hidden } : {}) };
}

/**
 * The columns a restricted read selects in place of `*`: the system columns and every visible
 * field that has a column (not a read-time computed field, nor a lookup, rollup or many
 * relation: linkedRead.mts fills those after the list).
 */
export function visibleColumns(scoped: TableMeta): string[] {
    const out: string[] = [...SYSTEM_COLUMNS];
    for (const f of fieldsOf(scoped)) {
        if (f.type === 'computed' && !(f.computed && f.computed.stored === true)) continue;
        if (isColumnlessLinkField(f)) continue;
        if (!out.includes(f.key as string)) out.push(f.key as string);
    }
    return out;
}

// ── Writes ──────────────────────────────────────────────────────────

/** A write of a field the viewer's role may not write: 403, `field_not_writable`, `fields` the keys. */
export class FieldAccessError extends AccessError {
    code: string;
    fields: string[];

    constructor(labels: string[], fields: string[]) {
        super(`You do not have permission to change ${labels.map((l) => `"${l}"`).join(', ')}.`, 403);
        this.name = 'FieldAccessError';
        this.code = 'field_not_writable';
        this.fields = fields;
    }
}

const isEmptyValue = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * The values `role` may write, before anything the server fills is added.
 * Throws FieldAccessError for a value of a field the role may not write; on a
 * create an empty value for such a field is left out. The same object when
 * nothing is left out, and always for a table without column rights.
 */
export function writableValues<T>(tableMeta: unknown, role: unknown, values: T, op: 'create' | 'update'): T {
    if (!isObject(values) || role === OWNER_ROLE || !hasColumnRights(tableMeta)) return values;
    const byKey = new Map(fieldsOf(tableMeta).map((f) => [f.key as string, f]));
    const dropped = new Set<string>();
    const refused: Field[] = [];
    for (const key of Object.keys(values)) {
        const field = byKey.get(key);
        // Not a field the caller can write at all: the compiler skips or refuses it by its own rule.
        if (!field || NEVER_WRITTEN.includes(field.type as string)) continue;
        if (listedForWrite(field, role)) continue;
        if (op === 'create' && isEmptyValue(values[key])) dropped.add(key);
        else refused.push(field);
    }
    if (refused.length) {
        throw new FieldAccessError(refused.map((f) => (typeof f.name === 'string' && f.name ? f.name : f.key as string)), refused.map((f) => f.key as string));
    }
    if (dropped.size === 0) return values;
    return Object.fromEntries(Object.entries(values).filter(([k]) => !dropped.has(k))) as T;
}

// ── Save-time checks ────────────────────────────────────────────────

function roleListErrors(list: unknown, at: string): string[] {
    if (!Array.isArray(list)) return [`${at} must be a list of role keys`];
    if (list.length > MAX_FIELD_ACCESS_ROLES) return [`${at} names more than ${MAX_FIELD_ACCESS_ROLES} roles`];
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const role of list) {
        if (typeof role !== 'string' || !KEY_RE.test(role)) errors.push(`${at} holds ${JSON.stringify(role)}, which is not a role key`);
        else if (role === OWNER_ROLE) errors.push(`${at} names "owner": the owner always has every field, leave it out`);
        else if (seen.has(role)) errors.push(`${at} names "${role}" twice`);
        else seen.add(role);
    }
    return errors;
}

/** The shape of one field's `access`; silent for a field without it. */
export function fieldAccessErrors(field: unknown, at: string): string[] {
    if (!isObject(field) || field.access === undefined) return [];
    const access = field.access;
    if (!isObject(access)) return [`${at}.access must be an object { read?, write? }`];
    const errors: string[] = [];
    const extra = Object.keys(access).filter((k) => !FIELD_ACCESS_KEYS.includes(k));
    if (extra.length) errors.push(`${at}.access has unknown keys: ${extra.join(', ')}`);
    if (access.read === undefined && access.write === undefined) errors.push(`${at}.access needs read or write (remove access to give every role the field)`);
    for (const key of FIELD_ACCESS_KEYS) if (access[key] !== undefined) errors.push(...roleListErrors(access[key], `${at}.access.${key}`));
    if (access.write !== undefined && NEVER_WRITTEN.includes(field.type as string)) {
        errors.push(`${at}.access.write does not apply: a ${field.type} field is never written`);
    }
    return errors;
}

/**
 * What column rights need of the table as a whole:
 *   - not on a linked Studio table: its rows are read with the datatable's own
 *     descriptor, which does not carry these lists, so the rights would not hold;
 *   - not `unique` on a field some role may write and not read: the refusal of a
 *     value that exists would tell that role which values the field holds;
 *   - no `read` list on a relation with an onDelete rule: a refused delete, or the
 *     records it changes, would tell a role that may not read the relation which
 *     records point at the one deleted.
 * `warnings` name a role the model does not declare (it gives nobody the field);
 * `roles` is the model's own `roles` list, and a model without one is not asked.
 */
export function tableColumnRightsFindings(table: unknown, at: string, roles: unknown): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!hasColumnRights(table)) return { errors, warnings };
    const roleKeys = Array.isArray(roles)
        ? roles.map((r) => (isObject(r) ? r.key : undefined)).filter((k): k is string => typeof k === 'string')
        : null;
    const t = table as TableMeta;
    if (t.source !== undefined && t.source !== null) {
        errors.push(`${at} is a linked Studio table: column rights (field.access) are not available on it. Set the rights on the Studio table, or copy the rows into a table of this app`);
        return { errors, warnings };
    }
    for (const f of fieldsOf(table)) {
        if (!declares(f)) continue;
        const read = rolesOf(f, 'read');
        const write = rolesOf(f, 'write');
        if (f.unique === true && read !== null && write !== null) {
            const blind = write.filter((r) => !read.includes(r));
            if (blind.length) errors.push(`${at} field "${f.key}" is unique, and ${blind.map((r) => `"${r}"`).join(', ')} may write it without reading it: a refused duplicate would tell which values exist. Let the role read the field, take it out of write, or drop unique`);
        }
        if (read !== null && hasDeleteRule(f)) {
            errors.push(`${at} field "${f.key}" follows a delete rule (onDelete), and only some roles may read it: whether a delete is refused or changes other records would tell those roles which records point where. Let every role read the relation, or drop the delete rule`);
        }
        if (!roleKeys) continue;
        for (const role of new Set([...(read || []), ...(write || [])])) {
            if (role !== PUBLIC_ROLE_KEY && !roleKeys.includes(role)) warnings.push(`${at} field "${f.key}" names the role "${role}", which this app does not have`);
        }
    }
    return { errors, warnings };
}
