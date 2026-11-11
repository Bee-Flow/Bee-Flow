// @typecheck strict
/**
 * The App Studio data-engine metadata tables: their boot DDL and the additive
 * migration ladder, behind one memoised init that every part of the store
 * awaits. See ../studioAppDataStore.js for what each table holds.
 */

const { exec } = require('../../db');
const { makeStoreInit } = require('../lib/storeInit');
const { runDdl } = require('../lib/_ddl');
const { deps } = require('./cycleDeps');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

const initDB = makeStoreInit('StudioAppDataStore', _initDB);

async function _initDB() {
    // FK dependants: studio_apps must exist first (mirrors webpagePublicShareStore
    // waiting on webpages). studioAppStore self-inits on load; await its handle.
    const studioAppStore = deps.studioAppStore;
    try { if (studioAppStore && studioAppStore.ready) await studioAppStore.ready; } catch (err) { bestEffort('stores/studioAppData/schema:_initDB', err); /* proceed — FK create will surface a real problem */ }

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_data_meta (
            app_id TEXT PRIMARY KEY REFERENCES studio_apps(id) ON DELETE CASCADE,
            owner_user_id TEXT NOT NULL,
            model JSONB NOT NULL DEFAULT '{}'::jsonb,
            model_version INTEGER NOT NULL DEFAULT 0,
            data_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
            row_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_data_meta_owner ON studio_app_data_meta(owner_user_id);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_datasets (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            owner_user_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT 'Untitled dataset',
            table_id TEXT,
            source JSONB NOT NULL DEFAULT '{}'::jsonb,
            descriptor JSONB NOT NULL DEFAULT '{}'::jsonb,
            cache_ttl_seconds INTEGER NOT NULL DEFAULT 60,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_datasets_app ON studio_app_datasets(app_id);
        CREATE INDEX IF NOT EXISTS idx_studio_app_datasets_owner ON studio_app_datasets(owner_user_id);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_dataset_cache (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL REFERENCES studio_app_datasets(id) ON DELETE CASCADE,
            viewer_scope_key TEXT NOT NULL,
            params_hash TEXT NOT NULL,
            data_version INTEGER NOT NULL DEFAULT 0,
            result JSONB NOT NULL DEFAULT '{}'::jsonb,
            row_count INTEGER NOT NULL DEFAULT 0,
            computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_app_dataset_cache_key
            ON studio_app_dataset_cache(dataset_id, viewer_scope_key, params_hash);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_members (
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL,
            role_key TEXT NOT NULL DEFAULT 'member',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (app_id, user_id)
        );
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_attachments (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            owner_user_id TEXT NOT NULL,
            record_id TEXT,
            field_key TEXT,
            mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
            sha256 TEXT NOT NULL DEFAULT '',
            size BIGINT NOT NULL DEFAULT 0,
            scanned BOOLEAN NOT NULL DEFAULT FALSE,
            quarantined BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_attachments_app ON studio_app_attachments(app_id);
        CREATE INDEX IF NOT EXISTS idx_studio_app_attachments_record ON studio_app_attachments(app_id, record_id);
    `);

    // Connector → table sync state. Deliberately NOT part of the data model
    // JSONB: writing last_run_at/watermark there on every refresh would churn
    // model_version under an editor that has the model open, and make every
    // background sync a potential save conflict.
    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_connector_sync (
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            connector_id TEXT NOT NULL,
            owner_user_id TEXT NOT NULL,
            table_key TEXT,
            status TEXT NOT NULL DEFAULT 'idle',
            last_run_at TIMESTAMPTZ,
            next_run_at TIMESTAMPTZ,
            started_at TIMESTAMPTZ,
            watermark TEXT,
            rows_written INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (app_id, connector_id)
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_connector_sync_due
            ON studio_app_connector_sync(next_run_at) WHERE next_run_at IS NOT NULL;
    `);

    // Outbound e-mail ledger. An app that can send mail from a real person's
    // mailbox needs a record of what left and on whose authority — with a lend
    // grant the sender and the mailbox owner are different people, so both are
    // stored. Recipients are masked: this proves what happened without becoming
    // a second copy of the customer's address book.
    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_email_log (
            id BIGSERIAL PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            connector_id TEXT NOT NULL,
            viewer_user_id TEXT,
            effective_user_id TEXT,
            to_masked TEXT,
            subject TEXT,
            provider_message_id TEXT,
            thread_key TEXT,
            dlp_outcome TEXT,
            sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_email_log_app ON studio_app_email_log(app_id, sent_at DESC);
    `);

    await initActionRuns();

    // Additive migrations — CREATE TABLE IF NOT EXISTS won't add columns to a
    // pre-existing table. Via runDdl (stores/lib/_ddl.js): a failing statement
    // is reported loudly in the failures list and the rest keeps running — the
    // old catch (_) also read a timeout as "column already exists".
    await runDdl('studioAppDataStore', [
        `ALTER TABLE studio_app_data_meta ADD COLUMN IF NOT EXISTS data_versions JSONB NOT NULL DEFAULT '{}'::jsonb`,
        `ALTER TABLE studio_app_data_meta ADD COLUMN IF NOT EXISTS row_counts JSONB NOT NULL DEFAULT '{}'::jsonb`,
        `ALTER TABLE studio_app_datasets ADD COLUMN IF NOT EXISTS table_id TEXT`,
        `ALTER TABLE studio_app_datasets ADD COLUMN IF NOT EXISTS descriptor JSONB NOT NULL DEFAULT '{}'::jsonb`,
        `ALTER TABLE studio_app_datasets ADD COLUMN IF NOT EXISTS cache_ttl_seconds INTEGER NOT NULL DEFAULT 60`,
        `ALTER TABLE studio_app_attachments ADD COLUMN IF NOT EXISTS scanned BOOLEAN NOT NULL DEFAULT FALSE`,
        `ALTER TABLE studio_app_attachments ADD COLUMN IF NOT EXISTS quarantined BOOLEAN NOT NULL DEFAULT FALSE`,
        // Drives the exponential back-off in connectorSync. Without a streak
        // counter, a failing connector reschedules at its normal cadence
        // forever — which for a 2-minute mailbox means hammering a provider
        // that is already throttling us.
        `ALTER TABLE studio_app_connector_sync ADD COLUMN IF NOT EXISTS consecutive_errors INTEGER NOT NULL DEFAULT 0`,
        ...PAUSED_RUN_DDL,
        ...TRIGGER_RUN_DDL,
        // The next addition to the run table or beside it goes here, after the columns it builds on.
    ]);
    await initTriggers();
    log.info('[StudioAppDataStore] PostgreSQL initialized');
}

/**
 * A paused run (appStudio/backgroundRunDurable.mts): the columns for a database that had the run
 * table before them (CREATE TABLE below carries them for a new one), and their indexes.
 *   paused_state       where the walk was and the scope it needs to go on (JSON). Personal data
 *                      at rest: dropped the moment the run is resumed, cancelled or ended, and
 *                      with the row when the retention ends a pause that outlived it
 *   paused_at          when the run was put on hold
 *   wake_at            when the wake job continues it (jobs/studioAppRunWake.js)
 *   wait_kind/_ref     what it waits for besides time; a server-side resume names the pair
 *   resume_seq         counts resumes: a resume is a compare-and-set on it, so one of two wins
 *   resume_token_hash  sha256 of the resume token; cleared by the resume that used it
 *   cancel_requested   a running job stops at its next step when it reads this
 */
const PAUSED_RUN_DDL = [
    `ALTER TABLE studio_app_action_runs ADD COLUMN IF NOT EXISTS paused_state JSONB`,
    `ALTER TABLE studio_app_action_runs ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ`,
    `ALTER TABLE studio_app_action_runs ADD COLUMN IF NOT EXISTS wake_at TIMESTAMPTZ`,
    `ALTER TABLE studio_app_action_runs ADD COLUMN IF NOT EXISTS wait_kind TEXT`,
    `ALTER TABLE studio_app_action_runs ADD COLUMN IF NOT EXISTS wait_ref TEXT`,
    `ALTER TABLE studio_app_action_runs ADD COLUMN IF NOT EXISTS resume_seq INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE studio_app_action_runs ADD COLUMN IF NOT EXISTS resume_token_hash TEXT`,
    `ALTER TABLE studio_app_action_runs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE`,
    `CREATE INDEX IF NOT EXISTS idx_studio_app_action_runs_wake ON studio_app_action_runs(wake_at) WHERE status = 'paused'`,
    `CREATE INDEX IF NOT EXISTS idx_studio_app_action_runs_wait ON studio_app_action_runs(wait_kind, wait_ref) WHERE status = 'paused'`,
];

/**
 * A run a trigger started (appStudio/triggers/triggerFire.mts): the trigger of the app's
 * definition it belongs to, for a database that had the run table before the column.
 */
const TRIGGER_RUN_DDL = [
    `ALTER TABLE studio_app_action_runs ADD COLUMN IF NOT EXISTS trigger_id TEXT`,
];

/**
 * Armed triggers (queries in ./triggers.mts, the rules in appStudio/triggers/). One row per
 * trigger of an app's PUBLISHED definition, written only when the app is published and removed
 * when it is unpublished; a draft has no rows. The row goes with its app (ON DELETE CASCADE).
 *   kind / config      the trigger's kind (`schedule`, later kinds beside it) and what that kind
 *                      keeps of the trigger; no personal data
 *   fingerprint        the trigger, its action and the actions that one calls, as published: a
 *                      fire compares it with the published definition of that moment
 *   state              `armed`, or `paused` with paused_code / paused_reason (by the owner, or
 *                      after failed runs in a row)
 *   next_fire_at       when a kind that fires by time is due; NULL for a kind that fires on an event
 *   fire_seq           counts fires: a fire is a compare-and-set on it, so one of two instances wins
 *   last_*             the last fire, its run row and how it ended; consecutive_failures drives
 *                      the back-off and the pause
 */
async function initTriggers() {
    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_triggers (
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            trigger_id TEXT NOT NULL,
            owner_user_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            action_id TEXT NOT NULL,
            config JSONB NOT NULL DEFAULT '{}'::jsonb,
            fingerprint TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'armed',
            paused_code TEXT,
            paused_reason TEXT,
            next_fire_at TIMESTAMPTZ,
            last_fired_at TIMESTAMPTZ,
            last_run_id TEXT,
            last_status TEXT,
            last_error TEXT,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            fire_seq INTEGER NOT NULL DEFAULT 0,
            armed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (app_id, trigger_id)
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_triggers_due ON studio_app_triggers(next_fire_at) WHERE state = 'armed' AND next_fire_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_studio_app_triggers_running ON studio_app_triggers(last_run_id) WHERE last_status = 'running';
    `);
}

/**
 * Action runs (queries in ./actionRuns.mts). A background job IS a run row (its jobId is the
 * row id); the run log adds its own rows to the same table later. `lock_key` is unique per app
 * among RUNNING rows (a partial index, so the lock holds across replicas) and, with the second
 * index, among running and PAUSED rows together: a run on hold keeps its lock; a heartbeat writes
 * `last_activity_at`, and a row that stops beating is swept to `interrupted`
 * (jobs/studioAppActionRuns.js). Payload columns (result, vars, effects, progress) are nulled
 * after the result TTL and rows are deleted after the retention (jobs/platformRetention.js).
 * viewer_user_id is detached on account erasure (stores/user/erasureCoverage.js).
 */
async function initActionRuns() {
    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_action_runs (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            owner_user_id TEXT NOT NULL,
            action_id TEXT NOT NULL,
            origin TEXT NOT NULL,
            draft BOOLEAN NOT NULL DEFAULT FALSE,
            definition_version INTEGER,
            dry_run BOOLEAN NOT NULL DEFAULT FALSE,
            viewer_user_id TEXT,
            visitor_key TEXT,
            client TEXT,
            client_run_key TEXT,
            tracked BOOLEAN NOT NULL DEFAULT TRUE,
            status TEXT NOT NULL DEFAULT 'running',
            ended_by TEXT,
            error TEXT,
            error_code TEXT,
            error_step JSONB,
            handled_errors INTEGER NOT NULL DEFAULT 0,
            last_step_status TEXT,
            in_flight BOOLEAN NOT NULL DEFAULT FALSE,
            lock_key TEXT,
            progress JSONB NOT NULL DEFAULT '{}'::jsonb,
            result JSONB,
            vars JSONB,
            effects JSONB,
            instance_id TEXT,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ended_at TIMESTAMPTZ,
            duration_ms INTEGER,
            step_count INTEGER NOT NULL DEFAULT 0,
            failed_steps INTEGER NOT NULL DEFAULT 0,
            truncated BOOLEAN NOT NULL DEFAULT FALSE,
            ai_calls INTEGER NOT NULL DEFAULT 0,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            cost_by_currency JSONB NOT NULL DEFAULT '{}'::jsonb,
            paused_state JSONB,
            paused_at TIMESTAMPTZ,
            wake_at TIMESTAMPTZ,
            wait_kind TEXT,
            wait_ref TEXT,
            resume_seq INTEGER NOT NULL DEFAULT 0,
            resume_token_hash TEXT,
            cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
            trigger_id TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_app_action_runs_lock
            ON studio_app_action_runs(app_id, lock_key) WHERE status = 'running' AND lock_key IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_app_action_runs_lock_held
            ON studio_app_action_runs(app_id, lock_key) WHERE status IN ('running', 'paused') AND lock_key IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_app_action_runs_client_key
            ON studio_app_action_runs(app_id, client_run_key) WHERE client_run_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_studio_app_action_runs_app ON studio_app_action_runs(app_id, started_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_studio_app_action_runs_action ON studio_app_action_runs(app_id, action_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_studio_app_action_runs_viewer ON studio_app_action_runs(app_id, viewer_user_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_studio_app_action_runs_started ON studio_app_action_runs(started_at);
        CREATE INDEX IF NOT EXISTS idx_studio_app_action_runs_active ON studio_app_action_runs(last_activity_at) WHERE status = 'running';
    `);
    await initActionRunSteps();
}

/**
 * The run log's step rows (package 8): one per step a run reached, in order. Duration,
 * status, the error (already cleaned by runLogError: no prompt text, no customer values),
 * and per AI step the model, tokens and the estimated cost. Never results, scope or prompts.
 * They go with their run (ON DELETE CASCADE), so retention and app deletion need no second pass.
 */
async function initActionRunSteps() {
    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_action_run_steps (
            run_id TEXT NOT NULL REFERENCES studio_app_action_runs(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            action_id TEXT,
            step_index INTEGER,
            path TEXT NOT NULL,
            iteration INTEGER,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            error TEXT,
            error_code TEXT,
            attempts SMALLINT,
            handled BOOLEAN NOT NULL DEFAULT FALSE,
            mocked BOOLEAN NOT NULL DEFAULT FALSE,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            duration_ms INTEGER NOT NULL DEFAULT 0,
            model TEXT,
            model_tier TEXT,
            ai_calls INTEGER NOT NULL DEFAULT 0,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            cost NUMERIC(14,6),
            cost_currency TEXT,
            PRIMARY KEY (run_id, seq)
        );
    `);
}

module.exports = { initDB };
