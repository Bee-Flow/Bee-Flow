/**
 * stores/studioApp/actionTests.mts: the saved action tests of an app
 * (studio_app_action_tests, DDL in ./schema.js), written by app_save_test and read by
 * app_run_tests (appStudio/actionTests/mcpActionTests.mts).
 *
 *   upsertActionTest     insert, or replace the spec of the test with the same action + name
 *   deleteActionTest     by action + name
 *   listActionTests      every test of the app, optionally narrowed to actions and/or names
 *   countActionTests     how many tests the app has (the STUDIO_APP_TESTS_MAX cap)
 *   recordTestStatuses   the outcome of a run, per test id
 *
 * Every query is keyed by the app id the caller has ALREADY authorised; a test id of another
 * app is unreachable through every accessor. Plain TypeScript that imports nothing: the
 * database arrives as `db`, the init as `ready` (not in the studioAppStore barrel).
 */

export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null; affectedRows?: number }>;
}

export type ActionTestRow = {
    id: string; appId: string; actionId: string; name: string; spec: Record<string, unknown>;
    createdBy: string | null; updatedBy: string | null; lastStatus: string | null; lastRunAt: string | null;
    createdAt: string | null; updatedAt: string | null;
};

const changed = (r: { rowCount?: number | null; affectedRows?: number }): number => r.rowCount ?? r.affectedRows ?? 0;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v : null));
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function toTest(row: Record<string, unknown>): ActionTestRow {
    const spec = typeof row.spec === 'string' ? JSON.parse(row.spec) : row.spec;
    return {
        id: String(row.id), appId: String(row.app_id), actionId: String(row.action_id), name: String(row.name),
        spec: spec && typeof spec === 'object' ? spec as Record<string, unknown> : {},
        createdBy: text(row.created_by), updatedBy: text(row.updated_by), lastStatus: text(row.last_status),
        lastRunAt: iso(row.last_run_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    };
}

const newId = (): string => `sat_${globalThis.crypto.randomUUID().replace(/-/g, '')}`;

export function makeActionTestStore(db: Queryable, { ready = async () => {} }: { ready?: () => Promise<unknown> } = {}) {
    /** Insert, or replace the spec of the same action + name. `created` tells which. */
    async function upsertActionTest(appId: string, t: { actionId: string; name: string; spec: unknown; userId: string }): Promise<{ test: ActionTestRow; created: boolean }> {
        await ready();
        const { rows } = await db.query(
            `INSERT INTO studio_app_action_tests (id, app_id, action_id, name, spec, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)
             ON CONFLICT (app_id, action_id, name)
             DO UPDATE SET spec = EXCLUDED.spec, updated_by = EXCLUDED.updated_by, updated_at = NOW()
             RETURNING *, (xmax = 0) AS inserted`,
            [newId(), appId, t.actionId, t.name, JSON.stringify(t.spec ?? {}), t.userId],
        );
        const row = rows[0] as Record<string, unknown>;
        return { test: toTest(row), created: row.inserted === true };
    }

    async function deleteActionTest(appId: string, actionId: string, name: string): Promise<boolean> {
        await ready();
        return changed(await db.query(
            'DELETE FROM studio_app_action_tests WHERE app_id = $1 AND action_id = $2 AND name = $3',
            [appId, actionId, name],
        )) > 0;
    }

    /** The app's tests in a stable order (action, then name); filters are ANDed, each a list. */
    async function listActionTests(appId: string, filter: { actionIds?: string[]; names?: string[] } = {}): Promise<ActionTestRow[]> {
        await ready();
        const actionIds = Array.isArray(filter.actionIds) && filter.actionIds.length ? filter.actionIds : null;
        const names = Array.isArray(filter.names) && filter.names.length ? filter.names : null;
        const { rows } = await db.query(
            `SELECT * FROM studio_app_action_tests
              WHERE app_id = $1
                AND ($2::text[] IS NULL OR action_id = ANY($2::text[]))
                AND ($3::text[] IS NULL OR name = ANY($3::text[]))
              ORDER BY action_id, name, id`,
            [appId, actionIds, names],
        );
        return rows.map(toTest);
    }

    async function countActionTests(appId: string): Promise<number> {
        await ready();
        const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM studio_app_action_tests WHERE app_id = $1', [appId]);
        return Number(rows[0]?.n ?? 0);
    }

    /** Write the outcome of a run back; a test id of another app is ignored. */
    async function recordTestStatuses(appId: string, statuses: Array<{ id: string; status: string }>): Promise<number> {
        if (!statuses.length) return 0;
        await ready();
        return changed(await db.query(
            `UPDATE studio_app_action_tests t
                SET last_status = u.status, last_run_at = NOW()
               FROM (SELECT unnest($2::text[]) AS id, unnest($3::text[]) AS status) u
              WHERE t.app_id = $1 AND t.id = u.id`,
            [appId, statuses.map((s) => s.id), statuses.map((s) => s.status)],
        ));
    }

    return { upsertActionTest, deleteActionTest, listActionTests, countActionTests, recordTestStatuses };
}

export type ActionTestStore = ReturnType<typeof makeActionTestStore>;
