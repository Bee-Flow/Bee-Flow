// @typecheck
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

const initDB = makeStoreInit('StudioAppDataStore', _initDB);

async function _initDB() {
    // FK dependants: studio_apps must exist first (mirrors webpagePublicShareStore
    // waiting on webpages). studioAppStore self-inits on load; await its handle.
    const studioAppStore = deps.studioAppStore;
    try { if (studioAppStore && studioAppStore.ready) await studioAppStore.ready; } catch (_) { /* proceed — FK create will surface a real problem */ }

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
    ]);
    log.info('[StudioAppDataStore] PostgreSQL initialized');
}

module.exports = { initDB };
