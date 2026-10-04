// @typecheck
/**
 * Solution stage store: UAT and PRD stages of a Solution, their deployments
 * (history, lock and journal), bindings, variables and part options.
 *
 * This file owns the DDL of every table below and re-exports the functions of
 * stores/solutionStage/{stages,deployments,bindings,variables,managedPayload}.js.
 * Each of those is a `make…(db)` factory over `{ query, tx }`, so a pglite test
 * builds the store with no module replaced (testUtils/pgliteDb.js).
 *
 * All references are soft (no FKs), as for project_releases. A stage is a
 * `projects` row (stage, stage_of; projectStore owns those columns) plus one
 * solution_stages row here.
 *
 * Concurrency (design 6.7): one active deployment per stage is enforced by the
 * partial unique index uq_solution_deployments_active, one open approval
 * request by uq_solution_deployments_open, and admission is exclusive under
 * pg_advisory_xact_lock(hashtext('solution_stage:' || stage_project_id)).
 * A lease (lease_owner, lease_expires_at) lets a crashed worker lose a row.
 */

'use strict';

const dbFacade = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const log = require('../telemetry/log');
const { makeStagesStore } = require('./solutionStage/stages');
const { makeDeploymentsStore, ACTIVE_STATUSES } = require('./solutionStage/deployments');
const { makeBindingsStore } = require('./solutionStage/bindings');
const { makeVariablesStore } = require('./solutionStage/variables');
const { makeManagedPayloadStore } = require('./solutionStage/managedPayload');

const SOLUTION_STAGE_DDL = Object.freeze([
    `CREATE TABLE IF NOT EXISTS solution_stages (
        project_id TEXT PRIMARY KEY,
        solution_id TEXT NOT NULL,
        stage TEXT NOT NULL CHECK (stage IN ('uat', 'prd')),
        organization_id TEXT NOT NULL,
        run_as_user_id TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        paused_state JSONB,
        requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
        approval_policy JSONB,
        rollback_needs_approval BOOLEAN NOT NULL DEFAULT FALSE,
        new_parts_active BOOLEAN NOT NULL DEFAULT FALSE,
        current_release_id TEXT,
        current_release_seq INTEGER,
        previous_release_id TEXT,
        settings_version INTEGER NOT NULL DEFAULT 1,
        bindings_pending BOOLEAN NOT NULL DEFAULT FALSE,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (solution_id, stage)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_solution_stages_run_as ON solution_stages(run_as_user_id)`,

    `CREATE TABLE IF NOT EXISTS solution_deployments (
        id TEXT PRIMARY KEY,
        solution_id TEXT NOT NULL,
        stage_project_id TEXT NOT NULL,
        stage TEXT NOT NULL CHECK (stage IN ('uat', 'prd')),
        release_id TEXT,
        release_seq INTEGER,
        from_release_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('deploy', 'rollback', 'redeploy', 'settings', 'remove')),
        CONSTRAINT solution_deployments_release_chk CHECK (kind IN ('settings', 'remove') OR release_id IS NOT NULL),
        status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'approved', 'rejected', 'queued',
            'preparing', 'committing', 'converging', 'compensating', 'succeeded', 'succeeded_with_warnings',
            'failed', 'cancelled')),
        settings_patch JSONB,
        plan JSONB NOT NULL,
        plan_hash TEXT NOT NULL,
        stage_settings_version INTEGER NOT NULL,
        request_key TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        approval_id TEXT,
        acknowledgements JSONB NOT NULL DEFAULT '[]'::jsonb,
        report JSONB,
        error JSONB,
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        committed_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        UNIQUE (stage_project_id, request_key)
    )`,
    // THE lock: one active deployment per stage.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_solution_deployments_active ON solution_deployments(stage_project_id)
        WHERE status IN ('queued', 'approved', 'preparing', 'committing', 'converging', 'compensating')`,
    // One open approval request per stage.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_solution_deployments_open ON solution_deployments(stage_project_id)
        WHERE status = 'awaiting_approval'`,
    `CREATE INDEX IF NOT EXISTS idx_solution_deployments_hist
        ON solution_deployments(stage_project_id, created_at DESC, id)`,
    `CREATE INDEX IF NOT EXISTS idx_solution_deployments_ok ON solution_deployments(solution_id, stage, release_id)
        WHERE status IN ('succeeded', 'succeeded_with_warnings')`,
    `CREATE INDEX IF NOT EXISTS idx_solution_deployments_lease ON solution_deployments(lease_expires_at)
        WHERE status IN ('preparing', 'committing', 'converging', 'compensating')`,
    `CREATE INDEX IF NOT EXISTS idx_solution_deployments_approval
        ON solution_deployments(approval_id) WHERE approval_id IS NOT NULL`,

    `CREATE TABLE IF NOT EXISTS solution_deployment_steps (
        deployment_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('prepare', 'commit', 'converge', 'compensate')),
        ref TEXT,
        kind TEXT,
        action TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
        entity_id TEXT,
        before JSONB,
        after_hash TEXT,
        detail JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (deployment_id, seq)
    )`,

    `CREATE TABLE IF NOT EXISTS solution_bindings (
        project_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('connection', 'approver_seats', 'table', 'knowledge_base',
            'webpage_slug', 'mirror_source', 'integration_grant', 'document')),
        value JSONB NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, slot)
    )`,

    `CREATE TABLE IF NOT EXISTS solution_variables (
        solution_id TEXT NOT NULL,
        name TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,62}$'),
        type TEXT NOT NULL CHECK (type IN ('text', 'number', 'boolean', 'url', 'email', 'choice')),
        choices JSONB,
        description TEXT NOT NULL DEFAULT '',
        required BOOLEAN NOT NULL DEFAULT TRUE,
        steering BOOLEAN NOT NULL DEFAULT FALSE,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (solution_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS solution_variable_values (
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        value JSONB NOT NULL,
        applied_value JSONB,
        updated_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, name)
    )`,

    `CREATE TABLE IF NOT EXISTS solution_part_options (
        solution_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        kind TEXT NOT NULL,
        options JSONB NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (solution_id, ref)
    )`,
]);

/**
 * The schema, through a runDdl of the caller's (the store's own, or the
 * pglite test's), so the test applies exactly these statements.
 *
 * @param {{ runDdl: (tag: string, statements: any[]) => Promise<unknown> }} runners
 */
async function applySolutionStageSchema({ runDdl: run }) {
    await run('solutionStageStore', [...SOLUTION_STAGE_DDL]);
}

const initDB = makeStoreInit('SolutionStageStore', async () => {
    await applySolutionStageSchema({ runDdl });
    log.info('[SolutionStageStore] PostgreSQL initialized');
});

/**
 * The store's functions over one `{ query, tx }` database.
 *
 * @param {{
 *   query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }>,
 *   tx: <T>(fn: (client: { query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }) => Promise<T>) => Promise<T>,
 * }} db
 * @param {{ ready?: () => Promise<unknown>, projectStore?: any }} [opts]
 *        `projectStore`: createStageProject / detachStage (default: the module's own instance)
 */
function makeSolutionStageStore(db, { ready = async () => {}, projectStore = null } = {}) {
    // valuesMemo: variableValuesFor's memo, shared so a release pointer move
    // (stages.js) drops it as a values write (variables.js) does.
    const ctx = { ready, projectStore: () => projectStore || require('./projectStore'), valuesMemo: new Map() };
    return {
        ...makeStagesStore(db, ctx),
        ...makeDeploymentsStore(db, ctx),
        ...makeBindingsStore(db, ctx),
        ...makeVariablesStore(db, ctx),
        ...makeManagedPayloadStore(db, ctx),
    };
}

// The instance the app uses: db.js, behind the store's schema init.
const store = makeSolutionStageStore({
    query: (sql, params) => dbFacade.run(sql, params),
    tx: (fn) => dbFacade.withTransaction((client) => fn(client)),
}, { ready: initDB });

module.exports = {
    initDB,
    makeSolutionStageStore,
    applySolutionStageSchema,
    SOLUTION_STAGE_DDL,
    ACTIVE_STATUSES,
    ...store,
};
