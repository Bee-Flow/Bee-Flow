/**
 * What a data model change does to the rows an app already holds: the dry run
 * (previewDataModelChange) and the report a save returns (buildMigrationReport).
 *
 * A change can rebuild a stored computed field (a new expression, a new stored
 * field on a populated table: every row is recomputed by the database inside
 * the migration transaction) or convert a field's type in place
 * (core/dataEngine/dataModel/fieldConversion.mts). The dry run counts, against
 * the CURRENT schema and without writing anything, how many rows each op
 * touches and how many values cannot convert, with up to five examples per
 * conversion (cut to 60 characters). The examples are row values: they go to the
 * app's owner in the answer and are never logged.
 *
 * A failing migration statement is mapped to a fixed reason (migrationFailureFor);
 * the database's own message is never passed on.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { deps } = nodeRequire('./cycleDeps.js') as { deps: { dataModel: DataModelDeps; studioAppDbStore: DbStoreDeps } };
type ConvField = Record<string, unknown> & { id: string; key: string };

interface DataModelDeps {
    validateDataModel: (model: unknown) => { errors: string[] };
    planMigration: (oldModel: unknown, newModel: unknown, opts?: Record<string, unknown>) => PlanResult;
    emptyDataModel: () => Record<string, unknown>;
    unconvertibleWhere: (conv: { from: string; to: string; safe: boolean }, col: string, newF: ConvField, dialect?: string) => string | null;
}
interface DbStoreDeps {
    query: (ownerId: string, appId: string, sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export type OpKind = 'recompute' | 'convert' | 'unsupported';

export interface PlanOp {
    kind: OpKind;
    reason: string;
    tableId: string;
    tableKey: string;
    oldTableKey: string;
    fieldId: string;
    fieldKey: string;
    oldFieldKey: string;
    from?: string;
    to?: string;
    action?: 'refuse' | 'clear';
    first: number;
    last: number;
}

export interface PlanProbe { sql: string; at: number; opIndex: number; refuse: boolean; tableKey?: string }
export interface PlanResult { statements: string[]; ops: PlanOp[]; probes: PlanProbe[] }
export interface ProbeCount { opIndex: number; refuse?: boolean; n: number; bad: number; samples?: string[] }

interface ReportEntry { tableId: string; table: string; fieldId: string; field: string }
export interface RecomputeEntry extends ReportEntry { reason: string; rows: number | null }
export interface ConvertEntry extends ReportEntry {
    from: string; to: string; rows: number | null; unconvertible: number | null; samples?: string[]; action: 'refuse' | 'clear';
}
export interface UnsupportedEntry extends ReportEntry { from: string; to: string }
export interface MigrationReport {
    statements: number;
    summary: string;
    recomputed: RecomputeEntry[];
    converted: ConvertEntry[];
    unsupported: UnsupportedEntry[];
}

export const MAX_SAMPLES = 5;
export const MAX_SAMPLE_CHARS = 60;

/** Compact human summary of a migration plan (the builder tool's `migration` line). */
export function summariseMigration(plan: unknown): string {
    if (!Array.isArray(plan) || !plan.length) return 'no schema change';
    const shown = plan.slice(0, 8).map((s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 80));
    if (plan.length > 8) shown.push(`… +${plan.length - 8} more`);
    return shown.join('; ');
}

function entryOf(op: PlanOp): ReportEntry {
    return { tableId: op.tableId, table: op.tableKey, fieldId: op.fieldId, field: op.fieldKey };
}

/** The report of a plan, with the probe counts (from the engine, or the dry run) laid on. */
export function buildMigrationReport(plan: PlanResult, probed: ProbeCount[] = []): MigrationReport {
    const byOp = new Map<number, ProbeCount>();
    for (const p of Array.isArray(probed) ? probed : []) byOp.set(p.opIndex, p);
    const report: MigrationReport = { statements: plan.statements.length, summary: '', recomputed: [], converted: [], unsupported: [] };
    plan.ops.forEach((op, i) => {
        const count = byOp.get(i);
        if (op.kind === 'recompute') report.recomputed.push({ ...entryOf(op), reason: op.reason, rows: count ? count.n : null });
        else if (op.kind === 'convert') {
            const entry: ConvertEntry = {
                ...entryOf(op), from: String(op.from), to: String(op.to),
                rows: count ? count.n : null, unconvertible: count ? count.bad : null, action: op.action === 'clear' ? 'clear' : 'refuse',
            };
            if (count && Array.isArray(count.samples) && count.samples.length) entry.samples = count.samples;
            report.converted.push(entry);
        } else report.unsupported.push({ ...entryOf(op), from: String(op.from), to: String(op.to) });
    });
    report.summary = summaryWithCounts(summariseMigration(plan.statements), report);
    return report;
}

function summaryWithCounts(base: string, r: MigrationReport): string {
    const bits: string[] = [];
    for (const e of r.recomputed) if (e.rows !== null) bits.push(`${e.table}.${e.field}: ${e.rows} row(s) recomputed`);
    for (const e of r.converted) {
        const bad = e.unconvertible ? `, ${e.unconvertible} value(s) cannot convert${e.action === 'clear' ? ' (cleared)' : ''}` : '';
        if (e.rows !== null) bits.push(`${e.table}.${e.field} ${e.from}→${e.to}: ${e.rows} row(s)${bad}`);
    }
    for (const e of r.unsupported) bits.push(`${e.table}.${e.field} ${e.from}→${e.to}: model only, the column keeps its values`);
    return bits.length ? `${base} — ${bits.join('; ')}` : base;
}

/** The conversions a refusal names (every refusing conversion, counted). */
export function refusedConversions(plan: PlanResult, probed: ProbeCount[]): ConvertEntry[] {
    return buildMigrationReport(plan, probed).converted.filter((c) => c.action === 'refuse');
}

// ── Failure reasons (fixed ids and sentences; never the database's text) ──

export const FAILURE_REASONS: Readonly<Record<string, string>> = {
    division_by_zero: 'The expression divides by zero for at least one row.',
    invalid_value: 'At least one row holds a value the new column type cannot store.',
    unknown_column: 'The expression names a column the table does not have.',
    type_mismatch: 'The expression mixes types the database cannot combine.',
    duplicate_values: 'The field must be unique, but at least two rows would hold the same value.',
    other: 'The database refused the change.',
};

/** The reason id of a migration statement error. */
export function migrationFailureReason(err: unknown): string {
    const e = (err && typeof err === 'object') ? err as { code?: unknown; sqlState?: unknown; message?: unknown } : {};
    const code = String(e.sqlState ?? e.code ?? '');
    const msg = String(e.message ?? '');
    if (code === '22012') return 'division_by_zero';
    if (code === '22P02' || code === '22003') return 'invalid_value';
    if (code === '42703' || /no such column/i.test(msg)) return 'unknown_column';
    if (code === '42883' || code === '42804') return 'type_mismatch';
    if (code === '23505' || code === 'unique_violation' || code === 'SQLITE_CONSTRAINT_UNIQUE') return 'duplicate_values';
    return 'other';
}

export interface MigrationFailure extends ReportEntry { kind: OpKind; reason: string; message: string; code: string }

/**
 * The failure of an indexed statement (or of a probe, which names its op)
 * mapped onto its op, or null when no op owns it.
 */
export function migrationFailureFor(err: unknown, plan: PlanResult): MigrationFailure | null {
    const e0 = (err && typeof err === 'object') ? err as { migrationStatementIndex?: unknown; migrationOpIndex?: unknown } : {};
    const idx = e0.migrationStatementIndex;
    const opIdx = e0.migrationOpIndex;
    let op: PlanOp | undefined;
    if (Number.isInteger(idx)) {
        const n = idx as number;
        op = plan.ops.find((o) => o.first >= 0 && o.first <= n && n <= o.last);
    } else if (Number.isInteger(opIdx)) {
        op = plan.ops[opIdx as number];
    }
    if (!op) return null;
    const reason = migrationFailureReason(err);
    const e = err as { sqlState?: unknown; code?: unknown };
    return { ...entryOf(op), kind: op.kind, reason, message: FAILURE_REASONS[reason], code: String(e.sqlState ?? e.code ?? '') };
}

// ── The dry run ─────────────────────────────────────────────────────

function q(name: string): string {
    return `"${String(name).replace(/"/g, '""')}"`;
}

function cut(v: unknown): string {
    const s = typeof v === 'string' ? v : String(v);
    return s.length > MAX_SAMPLE_CHARS ? `${s.slice(0, MAX_SAMPLE_CHARS)}…` : s;
}

/** The bad-value predicate of a conversion against the CURRENT column (old key). */
function oldColumnPredicate(op: PlanOp, newModel: unknown): string | null {
    const tables = (newModel && typeof newModel === 'object' && Array.isArray((newModel as { tables?: unknown }).tables))
        ? (newModel as { tables: Array<{ id?: string; fields?: Array<Record<string, unknown>> }> }).tables : [];
    const nf = (tables.find((t) => t && t.id === op.tableId)?.fields || []).find((f) => f && f.id === op.fieldId);
    if (!nf || !op.from || !op.to) return null;
    return deps.dataModel.unconvertibleWhere({ from: op.from, to: op.to, safe: true }, op.oldFieldKey, nf as unknown as ConvField);
}

async function countOp(appId: string, ownerId: string, op: PlanOp, newModel: unknown): Promise<ProbeCount | null> {
    const db = deps.studioAppDbStore;
    const t = q(op.oldTableKey);
    const bad = op.kind === 'convert' ? oldColumnPredicate(op, newModel) : null;
    const badSql = bad ? `COALESCE(SUM(CASE WHEN ${bad} THEN 1 ELSE 0 END), 0)` : '0';
    try {
        const { rows } = await db.query(ownerId, appId, `SELECT COUNT(*) AS n, ${badSql} AS bad FROM ${t}`);
        const out: ProbeCount = { opIndex: -1, n: Number(rows?.[0]?.n) || 0, bad: Number(rows?.[0]?.bad) || 0 };
        if (bad && out.bad > 0) {
            const s = await db.query(ownerId, appId, `SELECT DISTINCT ${q(op.oldFieldKey)} AS v FROM ${t} WHERE ${bad} LIMIT ${MAX_SAMPLES}`);
            out.samples = (s.rows || []).map((r) => cut(r.v));
        }
        return out;
    } catch {
        // A table or column the database does not have (drift): no count.
        return null;
    }
}

export interface PreviewResult {
    ok: boolean;
    dryRun?: true;
    invalid?: true;
    errors?: string[];
    currentVersion?: number;
    report?: MigrationReport;
}

/**
 * The dry run of a data model save against the app's current model (`current`,
 * from getDataModel; null = no model yet): what the save WOULD do to the rows,
 * with the type conversions on. Reads only (owner-scoped through the per-app
 * engine); writes nothing, bumps no version. stores/studioAppData/dataModel.js
 * previewDataModelChange reads `current` and calls this.
 */
export async function previewAgainst(
    appId: string, ownerId: string, model: unknown,
    current: { model?: unknown; modelVersion?: number } | null,
    { onUnconvertible = 'refuse' }: { onUnconvertible?: 'refuse' | 'clear' } = {},
): Promise<PreviewResult> {
    const dm = deps.dataModel;
    const { errors } = dm.validateDataModel(model);
    if (errors.length) return { ok: false, invalid: true, errors };
    const currentModel = current && current.model ? current.model : dm.emptyDataModel();
    const plan = dm.planMigration(currentModel, model, { convertTypes: true, onUnconvertible: onUnconvertible === 'clear' ? 'clear' : 'refuse' });
    const probed: ProbeCount[] = [];
    for (const [i, op] of plan.ops.entries()) {
        if (op.kind === 'unsupported') continue;
        const c = await countOp(appId, ownerId, op, model);
        if (c) probed.push({ ...c, opIndex: i });
    }
    return { ok: true, dryRun: true, currentVersion: current?.modelVersion ?? 0, report: buildMigrationReport(plan, probed) };
}

// ── Running a planned migration (saveDataModelIn) ───────────────────

const log = nodeRequire('../../telemetry/log.js') as { warn: (msg: string) => void };

export interface MigrationIo {
    applyMigration: (ownerId: string, appId: string, plan: string[], opts: Record<string, unknown>) => Promise<{ probed?: ProbeCount[] } | null | undefined>;
    isPg: () => boolean;
}

export type SaveRefusal =
    | { ok: false; conversionRefused: true; conversions: ConvertEntry[] }
    | { ok: false; conversionUnsupported: true; conversions: UnsupportedEntry[] }
    | { ok: false; migrationFailed: true; failure: MigrationFailure };

export type PlannedOutcome = { ok: true; probed: ProbeCount[] } | { ok: false; probed: ProbeCount[]; result: SaveRefusal };

/**
 * Run a planned migration on the per-app engine (`client`: the save's own
 * Postgres transaction). A refusing probe and a failing recompute/convert
 * statement come back as the save's result (the caller rolls back); every
 * other error is thrown. `refuseUnsupported` (a save that converts types):
 * a type change outside the safe pairs is refused before anything runs,
 * instead of leaving a model whose type no longer matches its column.
 */
export async function applyPlanned(
    io: MigrationIo,
    { ownerId, appId, client, planned, nextVersion, refuseUnsupported = false }:
        { ownerId: string; appId: string; client: unknown; planned: PlanResult; nextVersion: number; refuseUnsupported?: boolean },
): Promise<PlannedOutcome> {
    const unsupported = refuseUnsupported ? buildMigrationReport(planned).unsupported : [];
    if (unsupported.length) return { ok: false, probed: [], result: { ok: false, conversionUnsupported: true, conversions: unsupported } };
    try {
        const res = await io.applyMigration(ownerId, appId, planned.statements, {
            targetVersion: nextVersion,
            ...(planned.probes.length ? { probes: planned.probes } : {}),
            ...(io.isPg() ? { client } : {}),
        });
        return { ok: true, probed: res && Array.isArray(res.probed) ? res.probed : [] };
    } catch (e) {
        const err = (e && typeof e === 'object') ? e as { code?: unknown; probed?: ProbeCount[] } : {};
        if (err.code === 'migration_precondition') {
            return { ok: false, probed: [], result: { ok: false, conversionRefused: true, conversions: refusedConversions(planned, err.probed || []) } };
        }
        const failure = migrationFailureFor(e, planned);
        if (!failure) throw e;
        // Ids, keys and the SQLSTATE / SQLite code only: the message can quote row values.
        log.warn(`[StudioAppDataStore] migration ${failure.kind} failed for ${appId} ${failure.tableId}.${failure.fieldId} (${failure.reason}, ${failure.code || 'no code'})`);
        return { ok: false, probed: [], result: { ok: false, migrationFailed: true, failure } };
    }
}
