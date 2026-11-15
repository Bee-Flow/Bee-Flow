/**
 * automationImportStore.mts: the migration report of an automation imported
 * from another workflow tool (today Windmill), and the facts the activation
 * gate reads from it.
 *
 * One row per imported draft in `automation_imports` (schema:
 * migrations/automation-imports-2026-11.js, run by the automationStore
 * ladder). The row goes with its automation (ON DELETE CASCADE).
 *
 *   insertReport(client, row)        inside the caller's transaction, next to the automation row
 *   getForAutomation(automationId)   the row, or null for an automation that was not imported
 *   acknowledge(automationId, ids)   checklist items the person handles by hand (merged, never removed)
 *   markDryRunOk(automationId, v)    a dry run of version v ended without an error
 *   markCleared(automationId)        the draft went live: the gate is done for good
 *   setComparison(automationId, c)   the side-by-side comparison's summary (report.comparison):
 *                                    statuses, step ids, error codes and key paths, never a value
 *
 * Plain TypeScript (erasable syntax only); the database arrives as `db`, like
 * folderStore.mts, so the PGlite tests run it on the real schema. The report
 * holds no secret and no token: the converter scrubs what it keeps, and the
 * caller never puts a token in it.
 */

import { randomUUID } from 'node:crypto';

export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface ImportDb extends Queryable {
    ready?: () => Promise<unknown>;
}

export type SourceKind = 'windmill_upload' | 'windmill_api';

export interface ImportRow {
    id: string;
    orgId: string | null;
    /** Null once the importer's account was erased (stores/user/erasureCoverage.js). */
    userId: string | null;
    automationId: string;
    sourceKind: SourceKind;
    windmillPath: string | null;
    windmillGeneration: string | null;
    report: Record<string, any>;
    acknowledged: string[];
    dryRunOkAt: string | null;
    dryRunVersion: number | null;
    clearedAt: string | null;
    createdAt: string | null;
}

export interface NewImportRow {
    orgId: string | null;
    userId: string;
    automationId: string;
    sourceKind: SourceKind;
    windmillPath: string | null;
    windmillGeneration: string | null;
    report: Record<string, unknown>;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const json = <T,>(v: unknown, fallback: T): T => {
    if (v == null) return fallback;
    if (typeof v === 'string') {
        try { return JSON.parse(v) as T; } catch { return fallback; }
    }
    return v as T;
};

export function rowToImport(r: Record<string, any> | null | undefined): ImportRow | null {
    if (!r) return null;
    return {
        id: r.id,
        orgId: r.org_id ?? null,
        userId: r.user_id ?? null,
        automationId: r.automation_id,
        sourceKind: r.source_kind,
        windmillPath: r.windmill_path ?? null,
        windmillGeneration: r.windmill_generation ?? null,
        report: json<Record<string, any>>(r.report, {}),
        acknowledged: json<string[]>(r.acknowledged, []).filter((x) => typeof x === 'string'),
        dryRunOkAt: iso(r.dry_run_ok_at),
        dryRunVersion: r.dry_run_version == null ? null : Number(r.dry_run_version),
        clearedAt: iso(r.cleared_at),
        createdAt: iso(r.created_at),
    };
}

export function makeAutomationImportStore(db: ImportDb) {
    const ready = async () => { if (db.ready) await db.ready(); };

    /** Inside the caller's transaction (the automation row was written on the same client). */
    async function insertReport(client: Queryable, row: NewImportRow): Promise<ImportRow | null> {
        const { rows } = await client.query(
            `INSERT INTO automation_imports (id, org_id, user_id, automation_id, source_kind, windmill_path, windmill_generation, report)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
             RETURNING *`,
            [randomUUID(), row.orgId, row.userId, row.automationId, row.sourceKind, row.windmillPath, row.windmillGeneration, JSON.stringify(row.report)],
        );
        return rowToImport(rows[0]);
    }

    async function getForAutomation(automationId: string): Promise<ImportRow | null> {
        await ready();
        const { rows } = await db.query('SELECT * FROM automation_imports WHERE automation_id = $1', [automationId]);
        return rowToImport(rows[0]);
    }

    /** Adds `ids` to the acknowledged items; an id already there stays once. */
    async function acknowledge(automationId: string, ids: string[]): Promise<ImportRow | null> {
        await ready();
        const current = await getForAutomation(automationId);
        if (!current) return null;
        const merged = [...new Set([...current.acknowledged, ...ids])];
        const { rows } = await db.query(
            'UPDATE automation_imports SET acknowledged = $2::jsonb WHERE automation_id = $1 RETURNING *',
            [automationId, JSON.stringify(merged)],
        );
        return rowToImport(rows[0]);
    }

    /** A dry run of `version` ended without an error. A no-op for an automation that was not imported. */
    async function markDryRunOk(automationId: string, version: number): Promise<boolean> {
        await ready();
        const r = await db.query(
            'UPDATE automation_imports SET dry_run_ok_at = NOW(), dry_run_version = $2 WHERE automation_id = $1 AND cleared_at IS NULL',
            [automationId, version],
        );
        return (r.rowCount ?? 0) > 0;
    }

    /** The draft went live once: the activation gate no longer applies. */
    async function markCleared(automationId: string): Promise<void> {
        await ready();
        await db.query('UPDATE automation_imports SET cleared_at = NOW() WHERE automation_id = $1 AND cleared_at IS NULL', [automationId]);
    }

    /** Replaces `report.comparison`; the rest of the report stays as imported. */
    async function setComparison(automationId: string, comparison: Record<string, unknown>): Promise<ImportRow | null> {
        await ready();
        const { rows } = await db.query(
            `UPDATE automation_imports SET report = jsonb_set(COALESCE(report, '{}'::jsonb), '{comparison}', $2::jsonb, true) WHERE automation_id = $1 RETURNING *`,
            [automationId, JSON.stringify(comparison)],
        );
        return rowToImport(rows[0]);
    }

    return { insertReport, getForAutomation, acknowledge, markDryRunOk, markCleared, setComparison };
}

export type AutomationImportStore = ReturnType<typeof makeAutomationImportStore>;
