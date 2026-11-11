/**
 * Argument checks and result shaping for the Frappe CRM tools
 * (frappeCrmTools.mts). Every check is a plain string operation: record names,
 * field names, filter values and write values are shape-checked here before
 * they go into a path, a query parameter or a request body.
 */

import { DOCTYPES, DEFAULT_LIMIT, MAX_TEXT_CHARS, WRITABLE_FIELDS, getMaxPageSize, getMaxOutputChars, type DocKind } from './frappeCrmToolDefs.mts';

export type ToolArgs = Record<string, unknown>;
export type Filter = [string, string, string];

const MAX_NAME_CHARS = 140;
const MAX_FILTER_CHARS = 140;
const MAX_FIELD_CHARS = 64;
const MAX_FIELDS = 50;
const MAX_SHORT_VALUE_CHARS = 1000;
const LONG_TEXT_FIELDS = new Set(['content', 'description', 'lost_notes']);
const NUMBER_FIELDS = new Set(['annual_revenue', 'deal_value', 'expected_deal_value', 'probability']);
const ORDERS = new Set(['modified desc', 'modified asc', 'creation desc', 'creation asc']);
// Frappe's bookkeeping on every document and child row: noise for a model.
const INTERNAL_KEYS = new Set(['doctype', 'docstatus', 'idx', 'parent', 'parentfield', 'parenttype']);

export const DEFAULT_FIELDS: Record<DocKind, readonly string[]> = {
    lead: ['name', 'lead_name', 'first_name', 'last_name', 'organization', 'email', 'mobile_no', 'status', 'lead_owner', 'modified'],
    deal: ['name', 'organization', 'status', 'deal_value', 'currency', 'expected_closure_date', 'deal_owner', 'lead_name', 'email', 'modified'],
    contact: ['name', 'full_name', 'first_name', 'last_name', 'email_id', 'mobile_no', 'company_name', 'modified'],
    organization: ['name', 'organization_name', 'website', 'industry', 'territory', 'no_of_employees', 'modified'],
    task: ['name', 'title', 'status', 'priority', 'due_date', 'assigned_to', 'reference_doctype', 'reference_docname', 'modified'],
    note: ['name', 'title', 'content', 'owner', 'reference_doctype', 'reference_docname', 'modified'],
    lead_status: ['name', 'type', 'position', 'color'],
    deal_status: ['name', 'type', 'position', 'probability', 'color'],
};

// ─── Argument checks (plain string operations) ─────────────────

export class ArgError extends Error {}

export function hasControlChar(text: string): boolean {
    for (let i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
}

/** A record name as it may go into a path: 1-140 characters, no control characters, not only dots. */
export function parseRecordName(value: unknown, label = 'name'): string {
    if (typeof value !== 'string' && typeof value !== 'number') throw new ArgError(`${label} is required.`);
    const name = String(value).trim();
    if (!name) throw new ArgError(`${label} is required.`);
    if (name.length > MAX_NAME_CHARS) throw new ArgError(`${label} is too long (max ${MAX_NAME_CHARS} characters).`);
    if (hasControlChar(name)) throw new ArgError(`${label} contains characters a record name cannot have.`);
    if (name.split('').every((ch) => ch === '.')) throw new ArgError(`${label} is not a valid record name.`);
    return name;
}

/** The URL path of one record, every variable part encoded. */
export function recordPath(kind: DocKind, name: string): string {
    return `/api/resource/${encodeURIComponent(DOCTYPES[kind])}/${encodeURIComponent(name)}`;
}

export function optionalFilterText(value: unknown, label: string): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' && typeof value !== 'number') throw new ArgError(`${label} must be text.`);
    const text = String(value).trim();
    if (!text) return undefined;
    if (text.length > MAX_FILTER_CHARS) throw new ArgError(`${label} is too long (max ${MAX_FILTER_CHARS} characters).`);
    if (hasControlChar(text)) throw new ArgError(`${label} contains control characters.`);
    return text;
}

/** A Frappe field name: lower-case letters, digits and underscores, starting with a letter or underscore. */
export function isFieldName(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FIELD_CHARS) return false;
    for (let i = 0; i < value.length; i += 1) {
        const c = value.charCodeAt(i);
        const letter = c >= 0x61 && c <= 0x7a;
        const digit = c >= 0x30 && c <= 0x39;
        if (!(letter || c === 0x5f || (digit && i > 0))) return false;
    }
    return true;
}

export function parseFields(value: unknown, kind: DocKind): string[] {
    if (value === undefined || value === null) return [...DEFAULT_FIELDS[kind]];
    if (!Array.isArray(value)) throw new ArgError('fields must be a list of field names.');
    if (value.length > MAX_FIELDS) throw new ArgError(`fields holds at most ${MAX_FIELDS} names.`);
    for (const f of value) {
        if (!isFieldName(f)) throw new ArgError('fields may only hold lower-case Frappe field names (letters, digits, underscore).');
    }
    return [...new Set(['name', ...(value as string[])])];
}

/** limit: default 20, capped by FRAPPE_CRM_MAX_PAGE_SIZE. */
export function clampLimit(value: unknown): number {
    const max = getMaxPageSize();
    const n = Number(value);
    const wanted = Number.isInteger(n) && n > 0 ? n : DEFAULT_LIMIT;
    return Math.min(wanted, max);
}

export function parseOffset(value: unknown): number {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : 0;
}

export function parseOrder(value: unknown): string {
    if (value === undefined || value === null || value === '') return 'modified desc';
    if (typeof value !== 'string' || !ORDERS.has(value)) throw new ArgError('order_by is one of "modified desc", "modified asc", "creation desc" or "creation asc".');
    return value;
}

export function parseRecordType(value: unknown): 'lead' | 'deal' {
    if (value === 'lead' || value === 'deal') return value;
    throw new ArgError('record_type is "lead" or "deal".');
}

// ─── Result shaping ────────────────────────────────────────────

export function shapeValue(value: unknown): unknown {
    if (typeof value === 'string' && value.length > MAX_TEXT_CHARS) return `${value.slice(0, MAX_TEXT_CHARS)}…`;
    return value;
}

/** One document: Frappe's bookkeeping keys and `_`-keys dropped, long text cut, child rows shaped the same way. */
export function shapeDoc(doc: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!doc || typeof doc !== 'object') return out;
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
        if (k.startsWith('_') || INTERNAL_KEYS.has(k)) continue;
        out[k] = Array.isArray(v) ? v.map((row) => (row && typeof row === 'object' ? shapeDoc(row) : shapeValue(row))) : shapeValue(v);
    }
    return out;
}

/** Keep as many rows as fit the output budget. */
export function budgetRows(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; overBudget: boolean } {
    const max = getMaxOutputChars();
    if (!Number.isFinite(max)) return { rows, overBudget: false };
    let used = 2;
    const kept: Record<string, unknown>[] = [];
    for (const row of rows) {
        const size = JSON.stringify(row).length + 1;
        if (used + size > max) return { rows: kept, overBudget: true };
        used += size;
        kept.push(row);
    }
    return { rows: kept, overBudget: false };
}

/** A whole document within the output budget: child tables are left out first. */
export function budgetDoc(doc: Record<string, unknown>): Record<string, unknown> {
    const max = getMaxOutputChars();
    if (!Number.isFinite(max) || JSON.stringify(doc).length <= max) return doc;
    const out: Record<string, unknown> = {};
    const omitted: string[] = [];
    for (const [k, v] of Object.entries(doc)) {
        if (Array.isArray(v)) omitted.push(k);
        else out[k] = v;
    }
    out._omitted = omitted.length
        ? `Child tables left out to keep the answer small: ${omitted.join(', ')}.`
        : 'The record is larger than the output budget.';
    return out;
}

export function dataOf(answer: unknown): unknown {
    return answer && typeof answer === 'object' && 'data' in answer ? (answer as { data: unknown }).data : undefined;
}

// ─── Write values ──────────────────────────────────────────────

/** One field value for a write: text (trimmed, bounded) or a number. */
export function writeValue(field: string, value: unknown): string | number {
    if (NUMBER_FIELDS.has(field)) {
        const n = typeof value === 'number' ? value : Number(String(value).trim());
        if (typeof value === 'boolean' || !Number.isFinite(n) || String(value).trim() === '') throw new ArgError(`${field} must be a number.`);
        return n;
    }
    if (typeof value !== 'string' && typeof value !== 'number') throw new ArgError(`${field} must be text.`);
    const text = String(value).trim();
    const max = LONG_TEXT_FIELDS.has(field) ? MAX_TEXT_CHARS * 5 : MAX_SHORT_VALUE_CHARS;
    if (text.length > max) throw new ArgError(`${field} is too long (max ${max} characters).`);
    if (text.includes('\u0000')) throw new ArgError(`${field} contains a NUL character.`);
    return text;
}

/** The write body: only the allow-listed fields of this kind that the arguments set. */
export function buildWriteBody(kind: keyof typeof WRITABLE_FIELDS, args: ToolArgs): Record<string, string | number> {
    const body: Record<string, string | number> = {};
    for (const field of WRITABLE_FIELDS[kind]) {
        const value = args[field];
        if (value === undefined || value === null) continue;
        body[field] = writeValue(field, value);
    }
    return body;
}
