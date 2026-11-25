/**
 * The receipts of Cowork runs (core/cowork/receipts): one chain per item, `cowork_receipts`, one row per closed run.
 * A receipt holds what the run was allowed to do and what it did, in names and counts, never what it read or wrote
 * (core/cowork/receipts/receiptFacts.mts builds it from an allow-list). Rows are linked by hash, so a missing or an
 * edited one shows (usecases/coworkReceipts.mts verifies).
 *
 * Receipts are issued after a run closed, by the item's own chain lock: whichever replica comes first appends the
 * runs that have none yet, in the order they finished. A run that is waiting for a decision gets its receipt when its
 * journey ends. The chain goes with its item.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }> };
type Db = {
    getAll: (sql: string, params?: unknown[]) => Promise<Row[]>;
    getOne: (sql: string, params?: unknown[]) => Promise<Row | null>;
    withTransaction: <T>(fn: (client: Client) => Promise<T>) => Promise<T>;
    exec?: (sql: string) => Promise<unknown>;
};

export const COWORK_RECEIPTS_DDL: readonly string[] = Object.freeze([
    `CREATE TABLE IF NOT EXISTS cowork_receipts (
        schedule_id TEXT NOT NULL REFERENCES cowork_schedules(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        signature TEXT,
        key_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (schedule_id, seq)
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_cowork_receipts_run ON cowork_receipts (run_id)',
]);

/** A closed run as the receipt reads it. */
export interface ReceiptRun {
    id: string;
    scheduleId: string;
    status: string;
    triggerKind: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    planId: string | null;
    automationRunId: string | null;
    conversationId: string | null;
    independence: string | null;
    trustedSteps: string[];
    activity: unknown;
    /** How the run really ended (cowork_runs.outcome_json, core/cowork/runOutcome.mts): the code of it, nothing else. */
    outcome?: string | null;
}

/** The approved plan a run executed. */
export interface ReceiptPlan {
    version: number;
    fingerprint: string;
    approvedBy: string;
    approvedAt: string | null;
    permissions: unknown;
    definition: unknown;
}

export interface StoredReceipt {
    seq: number;
    runId: string;
    payload: Record<string, unknown>;
    payloadHash: string;
    prevHash: string;
    hash: string;
    signature: string | null;
    keyId: string | null;
    createdAt: string | null;
}

export interface NewReceipt { runId: string; payload: Record<string, unknown>; payloadHash: string; prevHash: string; hash: string; signature: string | null; keyId: string | null }

/** What a chain append may do inside the item's lock. */
export interface ChainTx {
    head: () => Promise<{ seq: number; hash: string } | null>;
    pending: (limit: number) => Promise<ReceiptRun[]>;
    append: (seq: number, receipt: NewReceipt) => Promise<void>;
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const parse = (v: unknown): unknown => {
    if (typeof v !== 'string' || !v) return v ?? null;
    try {
        return JSON.parse(v);
    } catch {
        return null;
    }
};

function runOf(r: Row): ReceiptRun {
    const trusted = parse(r.trusted_steps);
    return {
        id: String(r.id), scheduleId: String(r.schedule_id), status: String(r.status ?? ''),
        triggerKind: r.trigger_kind ? String(r.trigger_kind) : null, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
        planId: r.plan_id ? String(r.plan_id) : null, automationRunId: r.automation_run_id ? String(r.automation_run_id) : null,
        conversationId: r.conversation_id ? String(r.conversation_id) : null, independence: r.independence ? String(r.independence) : null,
        trustedSteps: Array.isArray(trusted) ? trusted.filter((s): s is string => typeof s === 'string') : [],
        activity: parse(r.activity_json),
        outcome: outcomeKindOf(parse(r.outcome_json)),
    };
}

const OUTCOME_KINDS: ReadonlySet<string> = new Set(['done', 'nothing_to_do', 'incomplete', 'ai_failed']);
/** The outcome's code only: never its references, never a reason. */
function outcomeKindOf(v: unknown): string | null {
    const kind = v && typeof v === 'object' ? (v as { kind?: unknown }).kind : null;
    return typeof kind === 'string' && OUTCOME_KINDS.has(kind) ? kind : null;
}

function receiptOf(r: Row): StoredReceipt {
    const payload = parse(r.payload_json);
    return {
        seq: Number(r.seq), runId: String(r.run_id), payload: payload && typeof payload === 'object' ? payload as Record<string, unknown> : {},
        payloadHash: String(r.payload_hash), prevHash: String(r.prev_hash), hash: String(r.hash),
        signature: r.signature ? String(r.signature) : null, keyId: r.key_id ? String(r.key_id) : null, createdAt: iso(r.created_at),
    };
}

const RUN_COLUMNS = 'r.id, r.schedule_id, r.status, r.trigger_kind, r.started_at, r.finished_at, r.plan_id, r.automation_run_id, r.conversation_id, r.independence, r.trusted_steps, r.activity_json, r.outcome_json';
/** A closed run without a receipt: finished, and not waiting for a decision. */
const PENDING = `r.finished_at IS NOT NULL AND r.status <> 'waiting'
    AND NOT EXISTS (SELECT 1 FROM cowork_receipts c WHERE c.run_id = r.id)`;

export function makeCoworkReceipts({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    /** Run `fn` with the item's chain locked, in one transaction. */
    async function withChain<T>(scheduleId: string, fn: (tx: ChainTx) => Promise<T>): Promise<T> {
        await ready();
        return db.withTransaction(async (client) => {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cowork_receipts:${scheduleId}`]);
            const tx: ChainTx = {
                head: async () => {
                    const { rows } = await client.query('SELECT seq, hash FROM cowork_receipts WHERE schedule_id = $1 ORDER BY seq DESC LIMIT 1', [scheduleId]);
                    return rows[0] ? { seq: Number(rows[0].seq), hash: String(rows[0].hash) } : null;
                },
                pending: async (limit) => (await client.query(
                    `SELECT ${RUN_COLUMNS} FROM cowork_runs r WHERE r.schedule_id = $1 AND ${PENDING} ORDER BY r.finished_at, r.id LIMIT $2`,
                    [scheduleId, limit],
                )).rows.map(runOf),
                append: async (seq, receipt) => {
                    await client.query(
                        `INSERT INTO cowork_receipts (schedule_id, seq, run_id, payload_json, payload_hash, prev_hash, hash, signature, key_id)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                        [scheduleId, seq, receipt.runId, JSON.stringify(receipt.payload), receipt.payloadHash, receipt.prevHash, receipt.hash, receipt.signature, receipt.keyId],
                    );
                },
            };
            return fn(tx);
        });
    }

    /** The approved plan a run executed, or null. */
    async function planOf(planId: string): Promise<ReceiptPlan | null> {
        await ready();
        const r = await db.getOne('SELECT version, fingerprint, approved_by, approved_at, permissions_json, definition_json FROM cowork_plans WHERE id = $1', [planId]);
        if (!r) return null;
        return {
            version: Number(r.version), fingerprint: String(r.fingerprint), approvedBy: String(r.approved_by), approvedAt: iso(r.approved_at),
            permissions: parse(r.permissions_json), definition: parse(r.definition_json),
        };
    }

    /** The steps of a plan run that ended, per step: how often it succeeded (every leg of its journey). */
    async function stepsOf(automationRunId: string): Promise<Array<{ stepId: string; stepType: string; succeeded: number }>> {
        await ready();
        const rows = await db.getAll(
            `SELECT s.step_id, MAX(s.step_type) AS step_type, COUNT(*) FILTER (WHERE s.status = 'success')::int AS succeeded
               FROM automation_run_steps s JOIN automation_runs a ON a.id = s.run_id
              WHERE a.id = $1 OR a.root_run_id = $1
              GROUP BY s.step_id`,
            [automationRunId],
        );
        return rows.map((r) => ({ stepId: String(r.step_id), stepType: String(r.step_type ?? ''), succeeded: Number(r.succeeded) || 0 }));
    }

    /** The items that have a closed run without a receipt (the sweeper's list). */
    async function itemsWithPending(limit: number): Promise<string[]> {
        await ready();
        const rows = await db.getAll(`SELECT DISTINCT r.schedule_id FROM cowork_runs r WHERE ${PENDING} LIMIT $1`, [limit]);
        return rows.map((r) => String(r.schedule_id));
    }

    /** An item's chain, oldest first. */
    async function listReceipts(scheduleId: string, { limit = 1000 }: { limit?: number } = {}): Promise<StoredReceipt[]> {
        await ready();
        return (await db.getAll('SELECT * FROM cowork_receipts WHERE schedule_id = $1 ORDER BY seq LIMIT $2', [scheduleId, limit])).map(receiptOf);
    }

    /** The receipt of one run of this item, or null. */
    async function receiptOfRun(scheduleId: string, runId: string): Promise<StoredReceipt | null> {
        await ready();
        const r = await db.getOne('SELECT * FROM cowork_receipts WHERE schedule_id = $1 AND run_id = $2', [scheduleId, runId]);
        return r ? receiptOf(r) : null;
    }

    /** Closed runs of the item still without a receipt, finished before `before` (a gap the chain cannot show). */
    async function countMissing(scheduleId: string, before: Date): Promise<number> {
        await ready();
        const r = await db.getOne(`SELECT COUNT(*)::int AS n FROM cowork_runs r WHERE r.schedule_id = $1 AND r.finished_at < $2 AND ${PENDING}`, [scheduleId, before.toISOString()]);
        return Number(r?.n) || 0;
    }

    /** The ids of every item of the organisation's members (the audit of usecases/coworkOrgPanel.mts), at most `limit`. */
    async function itemIdsOfOrg(orgId: string, limit: number): Promise<string[]> {
        await ready();
        const rows = await db.getAll(
            'SELECT s.id FROM cowork_schedules s JOIN users u ON u.id = s.user_id WHERE u."organizationId" = $1 ORDER BY s.id LIMIT $2',
            [orgId, limit],
        );
        return rows.map((r) => String(r.id));
    }

    return { withChain, planOf, stepsOf, itemsWithPending, listReceipts, receiptOfRun, countMissing, itemIdsOfOrg };
}

type StoreInit = { makeStoreInit: (tag: string, fn: () => Promise<void>) => () => Promise<void> };

/** The schema init (ledgered, memoised), after the Cowork schema it refers to; storeModules.js starts it at boot. */
export const initDB: () => Promise<void> = (nodeRequire('./lib/storeInit.js') as StoreInit).makeStoreInit('CoworkReceiptsStore', async () => {
    await (nodeRequire('./coworkStore.js') as { initDB: () => Promise<unknown> }).initDB();
    const db = nodeRequire('../db.js') as { exec: (sql: string) => Promise<unknown> };
    for (const sql of COWORK_RECEIPTS_DDL) await db.exec(sql);
});

let defaultStore: ReturnType<typeof makeCoworkReceipts> | null = null;

/** The store on the server's pool. */
export function coworkReceipts(): ReturnType<typeof makeCoworkReceipts> {
    if (!defaultStore) defaultStore = makeCoworkReceipts({ ready: initDB });
    return defaultStore;
}
