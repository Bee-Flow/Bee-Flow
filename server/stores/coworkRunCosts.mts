/**
 * What Cowork runs cost in AI, read from the usage ledger (ai_usage_log, stores/usage), next to stores/coworkStore.js
 * which re-exports these.
 *
 * The ledger already prices every model call when it is written (estimated_cost, in the plan's currency). A run's
 * calls are found the way each kind of run writes them:
 *
 *   - a plain prompt run writes its own Cowork run id (core/aiTaskRunnerUsage.js);
 *   - a plan run's AI steps write the automation engine's run id, one per leg of the journey (a run that waited for a
 *     decision continues in a new leg);
 *   - an agent run writes its conversation: the calls in that conversation between the run's start and end.
 *
 * Amounts stay per currency, as the ledger keeps them: an organisation that changed plans has calls in two.
 * Read-only, and only ever for runs of one owner or one item the caller already checked, or for the organisation's
 * monthly budget, which reads a total and nothing else.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Db = { getAll: (sql: string, params?: unknown[]) => Promise<Row[]> };

/** What a run, or a set of runs, cost: per currency, and how many model calls. */
export interface RunCost {
    byCurrency: Record<string, number>;
    calls: number;
}

/** The ledger rows of the given Cowork runs, each tagged with its run and item. `runs` is the SQL that selects them. */
function costRowsSql(runs: string): string {
    return `
      WITH runs AS (${runs}),
           legs AS (
               SELECT runs.id AS run_id, a.id AS leg_id
                 FROM runs JOIN automation_runs a ON runs.automation_run_id IS NOT NULL
                  AND (a.id = runs.automation_run_id OR a.root_run_id = runs.automation_run_id)),
           calls AS (
               SELECT runs.id AS run_id, runs.schedule_id, u.estimated_cost, u.currency
                 FROM runs JOIN ai_usage_log u ON u.run_id = runs.id
               UNION ALL
               SELECT runs.id, runs.schedule_id, u.estimated_cost, u.currency
                 FROM legs JOIN runs ON runs.id = legs.run_id JOIN ai_usage_log u ON u.run_id = legs.leg_id
               UNION ALL
               SELECT runs.id, runs.schedule_id, u.estimated_cost, u.currency
                 FROM runs JOIN ai_usage_log u ON runs.conversation_id IS NOT NULL AND u.conversation_id = runs.conversation_id
                  AND u.timestamp >= runs.started_at AND u.timestamp <= COALESCE(runs.finished_at, NOW())
                  AND u.run_id IS DISTINCT FROM runs.id)`;
}

function add(into: Map<string, RunCost>, key: string, row: Row): void {
    const cost = into.get(key) ?? { byCurrency: {}, calls: 0 };
    const currency = typeof row.currency === 'string' && row.currency ? row.currency : 'EUR';
    const amount = Number(row.amount);
    if (Number.isFinite(amount)) cost.byCurrency[currency] = (cost.byCurrency[currency] ?? 0) + amount;
    cost.calls += Number(row.calls) || 0;
    into.set(key, cost);
}

export function makeCoworkRunCosts({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    /** What each of these runs of one item cost; a run without a priced call is left out. */
    async function costsOfRuns(scheduleId: string, runIds: string[]): Promise<Record<string, RunCost>> {
        if (runIds.length === 0) return {};
        await ready();
        const rows = await db.getAll(
            `${costRowsSql(`SELECT id, schedule_id, automation_run_id, conversation_id, started_at, finished_at
                               FROM cowork_runs WHERE schedule_id = $1 AND id = ANY($2::text[])`)}
             SELECT run_id, currency, SUM(estimated_cost) AS amount, COUNT(*) AS calls FROM calls GROUP BY run_id, currency`,
            [scheduleId, runIds],
        );
        const out = new Map<string, RunCost>();
        for (const row of rows) add(out, String(row.run_id), row);
        return Object.fromEntries(out);
    }

    /** What the runs of one owner cost since `since`, per item and in all. */
    async function costsSince(userId: string, since: Date): Promise<{ total: RunCost; byItem: Record<string, RunCost> }> {
        await ready();
        const rows = await db.getAll(
            `${costRowsSql(`SELECT id, schedule_id, automation_run_id, conversation_id, started_at, finished_at
                               FROM cowork_runs WHERE user_id = $1 AND started_at >= $2`)}
             SELECT schedule_id, currency, SUM(estimated_cost) AS amount, COUNT(*) AS calls FROM calls GROUP BY schedule_id, currency`,
            [userId, since.toISOString()],
        );
        const byItem = new Map<string, RunCost>();
        const total = new Map<string, RunCost>();
        for (const row of rows) {
            add(byItem, String(row.schedule_id), row);
            add(total, 'total', row);
        }
        return { total: total.get('total') ?? { byCurrency: {}, calls: 0 }, byItem: Object.fromEntries(byItem) };
    }

    /** What the runs of every member of one organisation cost since `since` (core/cowork/orgBudget.mts). */
    async function orgCostSince(orgId: string, since: Date): Promise<RunCost> {
        await ready();
        const rows = await db.getAll(
            `${costRowsSql(`SELECT r.id, r.schedule_id, r.automation_run_id, r.conversation_id, r.started_at, r.finished_at
                               FROM cowork_runs r JOIN users u ON u.id = r.user_id
                              WHERE u."organizationId" = $1 AND r.started_at >= $2`)}
             SELECT currency, SUM(estimated_cost) AS amount, COUNT(*) AS calls FROM calls GROUP BY currency`,
            [orgId, since.toISOString()],
        );
        const total = new Map<string, RunCost>();
        for (const row of rows) add(total, 'total', row);
        return total.get('total') ?? { byCurrency: {}, calls: 0 };
    }

    return { costsOfRuns, costsSince, orgCostSince };
}
