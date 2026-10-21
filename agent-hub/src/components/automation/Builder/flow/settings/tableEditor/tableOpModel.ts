/**
 * The pure half of the "Edit table" editor: the operations it edits, their
 * starting values (the same defaults the server fills in,
 * server/core/automationModel/tableOps/normalize.js), how the columns flow
 * from one operation to the next and where a finding lands in the form.
 * No React, no I/O.
 */
import type { TableColumn } from '../../../../../../api/queries/automation/runTables';
import type { Finding, OpResult } from '../../../../../../api/queries/automation/tablePreview';

export type Binding = { kind: string; value?: unknown; path?: string };

export const OP_KINDS = ['join', 'pseudonymise', 'derive', 'bucket', 'group', 'pivot', 'filter', 'select', 'sample', 'groups', 'describe'] as const;
export type OpKind = typeof OP_KINDS[number];

export const AGG_FNS = ['count', 'sum', 'mean', 'median', 'min', 'max', 'count_distinct', 'share'] as const;
export const RULE_TESTS = [
    'equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in', 'not_in',
    'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty', 'contains_item',
] as const;

/** The smallest group the Segments operation shows, unless the organisation sets a higher floor. */
export const GROUPS_MIN_N = 30;

export interface JoinKey { left: string; right: string; alternatives?: string[] }
export interface Aggregate { fn: string; column?: string; as: string }
export interface Band { label: string; min: number | null; max: number | null }
export interface Rule { column: string; test: string; value?: unknown; separator?: string }
export interface Split { column: string; values: string[] | null; separator: string | null; label: string | null }

interface Base { id: string; op: OpKind; enabled: boolean; note?: string }
export interface JoinOp extends Base {
    op: 'join'; with: Binding | null; how: 'left' | 'inner'; on: JoinKey[]; caseInsensitive: boolean; trim: boolean;
    columns: string[] | null; prefix: string; onDuplicate: 'first' | 'all';
}
export interface PseudonymiseOp extends Base {
    op: 'pseudonymise'; columns: string[]; saltVar: string; output: string; length: number; keepColumns: boolean; dropColumns: string[];
}
export interface DeriveOp extends Base { op: 'derive'; columns: { name: string; value: Binding | null }[] }
export interface BucketOp extends Base {
    op: 'bucket'; column: string; output: string; mode: 'bands' | 'quantiles' | 'values'; bands: Band[]; quantiles: number;
    labels: string[] | null; map: { values: (string | number)[]; label: string }[]; otherLabel: string | null;
}
export interface GroupOp extends Base {
    op: 'group'; by: string[]; aggregates: Aggregate[]; weight: string | null; minN: number; sort: { column: string; dir: 'asc' | 'desc' }[];
}
export interface PivotOp extends Base {
    op: 'pivot'; rows: string; columns: string; value: { fn: 'count' | 'sum' | 'mean'; column?: string }; weight: string | null;
    percent: 'none' | 'row' | 'column' | 'total'; totals: boolean; minN: number; decimals: number; columnOrder: string[] | null; missingLabel: string;
}
export interface FilterOp extends Base {
    op: 'filter'; match: 'all' | 'any'; rules: Rule[]; rulesFrom: Binding | null; rulesFromMatch: 'all' | 'any'; expr: string | null;
}
export interface SelectOp extends Base { op: 'select'; keep: string[] | null; drop: string[] | null; rename: { from: string; to: string }[] }
export interface SampleOp extends Base { op: 'sample'; mode: 'first' | 'random'; n: number | null; percent: number | null; seed: string }
export interface GroupsOp extends Base { op: 'groups'; splits: Split[]; includeTotal: boolean; totalLabel: string; minN: number }
export interface DescribeOp extends Base { op: 'describe'; columns: string[] | null; maxOptions: number; separator: string | null; sampleValues: number }

export type TableOp = JoinOp | PseudonymiseOp | DeriveOp | BucketOp | GroupOp | PivotOp | FilterOp | SelectOp | SampleOp | GroupsOp | DescribeOp;

/** The menu: what an operation is for, in plain words. The keys are the i18n keys of the group titles. */
export const OP_GROUPS: { key: string; ops: OpKind[] }[] = [
    { key: 'combine', ops: ['join'] },
    { key: 'clean', ops: ['filter', 'select', 'sample'] },
    { key: 'calculate', ops: ['derive', 'bucket'] },
    { key: 'summarise', ops: ['group', 'pivot', 'groups'] },
    { key: 'protect', ops: ['pseudonymise'] },
    { key: 'inspect', ops: ['describe'] },
];

/** The fields of a new operation. `sample` starts on the first 100 rows: the server has no default there and asks for exactly one of the two. */
const STARTING: Record<OpKind, () => Record<string, unknown>> = {
    join: () => ({ with: null, how: 'left', on: [{ left: '', right: '' }], caseInsensitive: true, trim: true, columns: null, prefix: '', onDuplicate: 'first' }),
    pseudonymise: () => ({ columns: [], saltVar: '', output: 'pseudonym', length: 16, keepColumns: false, dropColumns: [] }),
    derive: () => ({ columns: [{ name: '', value: null }] }),
    bucket: () => ({ column: '', output: '', mode: 'bands', bands: [{ label: '', min: null, max: null }], quantiles: 4, labels: null, map: [], otherLabel: 'Other' }),
    group: () => ({ by: [], aggregates: [{ fn: 'count', as: 'Count' }], weight: null, minN: 0, sort: [] }),
    pivot: () => ({ rows: '', columns: '', value: { fn: 'count' }, weight: null, percent: 'none', totals: true, minN: 0, decimals: 1, columnOrder: null, missingLabel: '(empty)' }),
    filter: () => ({ match: 'all', rules: [], rulesFrom: null, rulesFromMatch: 'all', expr: null }),
    select: () => ({ keep: null, drop: null, rename: [] }),
    sample: () => ({ mode: 'first', n: 100, percent: null, seed: 'sample' }),
    groups: () => ({ splits: [{ column: '', values: null, separator: null, label: null }], includeTotal: true, totalLabel: 'All', minN: GROUPS_MIN_N }),
    describe: () => ({ columns: null, maxOptions: 50, separator: null, sampleValues: 5 }),
};

export const isOpKind = (v: unknown): v is OpKind => typeof v === 'string' && (OP_KINDS as readonly string[]).includes(v);

/** The first `op<n>` not used yet. */
export function newOpId(ops: readonly { id?: string }[]): string {
    const taken = new Set(ops.map(o => o.id));
    for (let n = ops.length + 1; ; n++) if (!taken.has(`op${n}`)) return `op${n}`;
}

export function newOp(kind: OpKind, ops: readonly { id?: string }[]): TableOp {
    return { id: newOpId(ops), op: kind, enabled: true, ...STARTING[kind]() } as TableOp;
}

/** An operation with every field present: what the forms read, so an older step opens with the defaults showing. */
export function withDefaults(op: Partial<TableOp> & { id: string; op: OpKind }): TableOp {
    const fresh = STARTING[op.op]();
    const out: Record<string, unknown> = { ...fresh, ...op, enabled: op.enabled !== false };
    // A stored sample carries the one it was given; the other stays unset.
    if (op.op === 'sample') {
        const given = op as Partial<SampleOp>;
        if (given.percent != null && given.n == null) out.n = null;
    }
    return out as unknown as TableOp;
}

export const moveOp = <T,>(ops: readonly T[], from: number, to: number): T[] => {
    if (from === to || from < 0 || to < 0 || from >= ops.length || to >= ops.length) return ops.slice();
    const next = ops.slice();
    next.splice(to, 0, next.splice(from, 1)[0]);
    return next;
};

/** A copy right after the original, with a fresh id. */
export function duplicateOp(ops: readonly TableOp[], index: number): TableOp[] {
    const original = ops[index];
    if (!original) return ops.slice();
    const copy = { ...structuredClone(original), id: newOpId(ops) } as TableOp;
    return [...ops.slice(0, index + 1), copy, ...ops.slice(index + 1)];
}

export const removeOp = <T,>(ops: readonly T[], index: number): T[] => ops.filter((_, i) => i !== index);

export const replaceOp = (ops: readonly TableOp[], index: number, next: TableOp): TableOp[] => ops.map((o, i) => (i === index ? next : o));

// ── Columns ────────────────────────────────────────────────────────────────

const col = (key: string, type: TableColumn['type'] = 'mixed'): TableColumn => ({ key, label: key, type });

const upsert = (cols: TableColumn[], next: TableColumn): TableColumn[] => {
    const at = cols.findIndex(c => c.key === next.key);
    if (at < 0) return [...cols, next];
    const copy = cols.slice();
    copy[at] = next;
    return copy;
};

function uniqueKey(base: string, taken: Set<string>): string {
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} (${i})`)) return `${base} (${i})`;
}

type Plan<K extends OpKind> = (op: Extract<TableOp, { op: K }>, cols: TableColumn[], other: TableColumn[] | null) => TableColumn[] | null;

const planJoin: Plan<'join'> = (op, cols, other) => {
    const wanted = op.columns || (other ? other.map(c => c.key).filter(k => !op.on.some(o => o.right === k)) : null);
    if (!wanted) return null;
    const taken = new Set(cols.map(c => c.key));
    return [...cols, ...wanted.map(name => { const key = uniqueKey(op.prefix + name, taken); taken.add(key); return col(key); })];
};

const planPseudonymise: Plan<'pseudonymise'> = (op, cols) => {
    const gone = new Set([...(op.keepColumns ? [] : op.columns), ...op.dropColumns]);
    return upsert(cols.filter(c => !gone.has(c.key) || c.key === op.output), col(op.output || 'pseudonym', 'text'));
};

const planGroup: Plan<'group'> = (op, cols) => [
    ...op.by.map(k => cols.find(c => c.key === k) || col(k)),
    ...op.aggregates.map(a => col(a.as, a.fn === 'min' || a.fn === 'max' ? 'mixed' : 'number')),
    col('n', 'number'),
    // The organisation's minimum group size applies to every group, so the column is always planned.
    col('suppressed', 'boolean'),
];

const planSelect: Plan<'select'> = (op, cols) => {
    let out = cols;
    if (op.keep) out = op.keep.map(k => cols.find(c => c.key === k)).filter((c): c is TableColumn => !!c);
    else if (op.drop) out = cols.filter(c => !op.drop?.includes(c.key));
    for (const r of op.rename) if (r.from && r.to) out = out.map(c => (c.key === r.from ? { ...c, key: r.to, label: r.to } : c));
    return out;
};

const GROUPS_COLUMNS = (): TableColumn[] => [col('segment', 'text'), col('label', 'text'), col('column', 'text'), col('value', 'text'), col('n', 'number'), col('suppressed', 'boolean')];

const PLANS: { [K in OpKind]?: Plan<K> } = {
    join: planJoin,
    pseudonymise: planPseudonymise,
    derive: (op, cols) => op.columns.reduce((acc, c) => (c.name ? upsert(acc, col(c.name)) : acc), cols),
    bucket: (op, cols) => (op.output || op.column ? upsert(cols, col(op.output || `${op.column} (group)`, 'text')) : cols),
    group: planGroup,
    pivot: () => null,
    select: planSelect,
    groups: GROUPS_COLUMNS,
};

/**
 * The columns after one operation, worked out from its settings alone, or null
 * when they depend on the data (after a pivot, or a join that takes every
 * column of the other table). The preview's answer wins where there is one;
 * this is what the pickers use before there is a preview.
 */
export function planOpColumns(cols: TableColumn[], op: TableOp, otherColumns: TableColumn[] | null = null): TableColumn[] | null {
    if (op.enabled === false) return cols;
    const plan = PLANS[op.op] as Plan<OpKind> | undefined;
    return plan ? plan(op as never, cols, otherColumns) : cols;
}

/**
 * The columns that flow INTO operation `index`: what the previous operation
 * left (the preview's answer when it has one), otherwise the planned columns,
 * starting from the source table's. Null when they are not known yet.
 */
export function columnsInto(
    source: TableColumn[] | null,
    ops: readonly TableOp[],
    index: number,
    opResults: readonly OpResult[] | null = null,
    otherColumns: (opId: string) => TableColumn[] | null = () => null,
): TableColumn[] | null {
    if (!source) return null;
    let cols: TableColumn[] | null = source;
    const known = new Map(source.map(c => [c.key, c]));
    for (let i = 0; i < index && cols; i++) {
        const planned: TableColumn[] | null = planOpColumns(cols, ops[i], otherColumns(ops[i].id));
        const stat = opResults?.find(r => r.opId === ops[i].id);
        if (stat && stat.ok && (planned === null || stat.columns.join('\u0000') !== planned.map(c => c.key).join('\u0000'))) {
            cols = stat.columns.map(k => planned?.find(c => c.key === k) || known.get(k) || col(k));
        } else {
            cols = planned;
        }
        for (const c of cols || []) known.set(c.key, c);
    }
    return cols;
}

// ── Findings ───────────────────────────────────────────────────────────────

export interface FieldIssue { severity: 'error' | 'warning'; message: string; hint?: string; code: string }

/** `ops[2].by[0]` -> { index: 2, rest: 'by[0]' }; a path outside the operations -> null. */
export function splitPath(path: string): { index: number; rest: string } | null {
    const m = /^ops\[(\d+)\](?:\.(.*))?$/.exec(path || '');
    return m ? { index: Number(m[1]), rest: m[2] || '' } : null;
}

/** Everything the preview says about one operation, as issues with the field they name (`rest`, '' = the whole operation). */
export function issuesOf(index: number, opId: string, findings: readonly Finding[], opResults: readonly OpResult[]): (FieldIssue & { rest: string })[] {
    const out: (FieldIssue & { rest: string })[] = [];
    for (const f of findings) {
        const at = splitPath(f.path);
        if (at && at.index === index) out.push({ rest: at.rest, severity: f.severity, message: f.message, hint: f.hint, code: f.code });
    }
    const err = opResults.find(r => r.opId === opId)?.error;
    if (err && !out.some(i => i.message === err.message)) {
        out.push({ rest: err.field || '', severity: 'error', message: err.message, hint: err.hint, code: err.code });
    }
    return out;
}

/** Whether an issue's field is `name` or inside it (`by` claims `by[0]`; `on[1].left` claims only itself when `exact`). */
export function claims(rest: string, name: string, exact = false): boolean {
    if (rest === name) return true;
    return !exact && (rest.startsWith(`${name}[`) || rest.startsWith(`${name}.`));
}

// ── Sources ────────────────────────────────────────────────────────────────

export interface HandleRef { runId: string; tableId: string; columns: TableColumn[]; name: string }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The table handle a value is, or carries as `.table`; null for a dry-run handle or anything else. */
export function handleOf(value: unknown): HandleRef | null {
    const v = isRecord(value) && isRecord(value.table) && value.kind !== 'table' ? value.table : value;
    if (!isRecord(v) || v.kind !== 'table') return null;
    if (typeof v.tableId !== 'string' || typeof v.runId !== 'string' || !v.runId || v.tableId === 'dry-run') return null;
    return {
        runId: v.runId,
        tableId: v.tableId,
        name: typeof v.name === 'string' ? v.name : '',
        columns: Array.isArray(v.columns) ? (v.columns as TableColumn[]) : [],
    };
}

/** The columns of any table handle, a dry-run one included (it has no rows to preview, but it knows its columns). */
export function columnsOf(value: unknown): TableColumn[] | null {
    const v = isRecord(value) && isRecord(value.table) && value.kind !== 'table' ? value.table : value;
    return isRecord(v) && v.kind === 'table' && Array.isArray(v.columns) && v.columns.length > 0 ? (v.columns as TableColumn[]) : null;
}

/** The first row a handle carries, to show real values while building. */
export function sampleRowOf(value: unknown): Record<string, unknown> | null {
    const v = isRecord(value) && isRecord(value.table) && value.kind !== 'table' ? value.table : value;
    return isRecord(v) && Array.isArray(v.preview) && isRecord(v.preview[0]) ? v.preview[0] : null;
}

/** The table a binding points at, found in the editor's sample of the last run. */
export function handleFromBinding(binding: Binding | string | null | undefined, resolve: (path: string) => unknown): HandleRef | null {
    const path = typeof binding === 'string' ? binding : binding && binding.kind === 'ref' ? binding.path : '';
    return path ? handleOf(resolve(path)) : null;
}

/** `{ kind: 'ref', path }`. */
export const refBinding = (path: string): Binding => ({ kind: 'ref', path });

/** The path a ref binding carries, or ''. */
export const pathOf = (b: Binding | null | undefined): string => (b && b.kind === 'ref' && typeof b.path === 'string' ? b.path : '');

/** Whether a binding says nothing yet. */
export const isBlankBinding = (b: Binding | null | undefined): boolean =>
    !b || (b.kind === 'ref' ? !b.path : b.kind === 'literal' ? b.value === undefined || b.value === null || b.value === '' : !b.value);

/** The step types that make a table. */
export const TABLE_STEP_TYPES = new Set(['read_table', 'table']);
