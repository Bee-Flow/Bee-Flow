/**
 * Migration: the schema behind Studio → Automations "handoff 5" (2026-09).
 *
 * One migration for every package of that work, so the packages that build on
 * it never race each other over DDL. What it adds, and who reads it:
 *
 *   automations
 *     live_version / live_definition_json / live_at — the LIVE split. Until
 *       now every autosave on an active routine went live on the spot. From
 *       here the editor writes the working copy (definition_json, version) and
 *       scheduled, event, webhook, form, app and agent runs execute the live
 *       copy until the owner publishes ("Make vN live").
 *     deleted_at / deleted_by — the trash. A delete is a soft delete for 30
 *       days (runs are kept), then jobs/automationTrashPurge.js removes it.
 *   automation_versions
 *     name (a milestone), description / description_json (the plain-language
 *     change list) and is_layout_only (a save that only moved nodes; it does
 *     not count as a pending change).
 *   automation_runs
 *     started_by_user_id, outcome_json (the one-sentence outcome as codes and
 *     params), caller_agent_id / caller_conversation_id (an agent started it)
 *     and is_test (a live-mode run of the working copy from the Test button;
 *     mode='dry_run' stays the preview).
 *   automation_run_steps
 *     tools_withheld (tools an agent step was not given) and error_info (a
 *     structured error: code, settingKey, fixes).
 *   automation_shares, automation_notification_events, automation_templates
 *     — sharing and roles, notification throttling and digests, and org
 *     templates.
 *
 * ── The backfill runs ONCE ─────────────────────────────────────────────────
 *
 * Every entry of stores/automationStore/core.js's MIGRATIONS is replayed on
 * every process start. A plain "live_version = version WHERE is_draft = FALSE"
 * would therefore publish every pending change of every routine on every boot,
 * silently undoing the split it exists for. So the backfill sits inside the
 * same DO block that ADDS live_version, guarded on that column not existing
 * yet: the first boot adds the column and backfills in one transaction, every
 * later boot finds the column and skips both.
 *
 * Who is backfilled: every routine (kind 'automation') with is_draft = FALSE,
 * i.e. every routine that has been activated at least once. Its current
 * definition is what runs today, so it becomes its live version and nothing a
 * scheduled run does changes. A draft that never went live stays live-less.
 * Reusable Steps (kind 'block') have their own published_version and are not
 * part of this split.
 *
 * Everything else is IF NOT EXISTS, so the migration is idempotent.
 *
 * `exec` is injectable so the migration test can run it against an in-process
 * Postgres without reaching into the module system.
 */

async function up({ exec } = require('../db')) {
    // ── Live split + backfill (one transaction, first boot only) ──────────
    await exec(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema()
                   AND table_name = 'automations'
                   AND column_name = 'live_version'
            ) THEN
                ALTER TABLE automations ADD COLUMN live_version INTEGER NULL;
                ALTER TABLE automations ADD COLUMN IF NOT EXISTS live_definition_json JSONB NULL;
                ALTER TABLE automations ADD COLUMN IF NOT EXISTS live_at TIMESTAMPTZ NULL;
                UPDATE automations
                   SET live_version = version,
                       live_definition_json = definition_json,
                       live_at = NOW()
                 WHERE is_draft = FALSE
                   AND COALESCE(kind, 'automation') = 'automation';
            END IF;
        END $$;
    `);

    // ── automations: the rest ──────────────────────────────────────────────
    await exec(`
        ALTER TABLE automations ADD COLUMN IF NOT EXISTS live_definition_json JSONB NULL;
        ALTER TABLE automations ADD COLUMN IF NOT EXISTS live_at TIMESTAMPTZ NULL;
        ALTER TABLE automations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;
        ALTER TABLE automations ADD COLUMN IF NOT EXISTS deleted_by TEXT NULL;
        CREATE INDEX IF NOT EXISTS idx_automations_deleted_at ON automations(deleted_at);
    `);

    // ── automation_versions ───────────────────────────────────────────────
    await exec(`
        ALTER TABLE automation_versions ADD COLUMN IF NOT EXISTS name TEXT NULL;
        ALTER TABLE automation_versions ADD COLUMN IF NOT EXISTS description TEXT NULL;
        ALTER TABLE automation_versions ADD COLUMN IF NOT EXISTS description_json JSONB NULL;
        ALTER TABLE automation_versions ADD COLUMN IF NOT EXISTS is_layout_only BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    // ── automation_runs ───────────────────────────────────────────────────
    await exec(`
        ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS started_by_user_id TEXT NULL;
        ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS outcome_json JSONB NULL;
        ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS caller_agent_id TEXT NULL;
        ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS caller_conversation_id TEXT NULL;
        ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
        CREATE INDEX IF NOT EXISTS idx_automation_runs_started_by
            ON automation_runs(started_by_user_id) WHERE started_by_user_id IS NOT NULL;
    `);

    // ── automation_run_steps ──────────────────────────────────────────────
    await exec(`
        ALTER TABLE automation_run_steps ADD COLUMN IF NOT EXISTS tools_withheld JSONB NULL;
        ALTER TABLE automation_run_steps ADD COLUMN IF NOT EXISTS error_info JSONB NULL;
    `);

    // ── Sharing and roles ─────────────────────────────────────────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_shares (
            id              TEXT PRIMARY KEY,
            automation_id   TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            principal_type  TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
            principal_id    TEXT NOT NULL,
            role            TEXT NOT NULL CHECK (role IN ('run', 'view', 'edit')),
            created_by      TEXT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (automation_id, principal_type, principal_id)
        );
        CREATE INDEX IF NOT EXISTS idx_automation_shares_principal
            ON automation_shares(principal_type, principal_id);
    `);

    // ── Notification events (throttle, bundling, daily digest) ────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_notification_events (
            id                 TEXT PRIMARY KEY,
            automation_id      TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            run_id             TEXT NULL REFERENCES automation_runs(id) ON DELETE SET NULL,
            event              TEXT NOT NULL,
            recipient_user_id  TEXT NOT NULL,
            channel            TEXT NOT NULL,
            urgency            TEXT NOT NULL DEFAULT 'normal',
            created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            delivered_at       TIMESTAMPTZ NULL,
            bundled            BOOLEAN NOT NULL DEFAULT FALSE,
            digest_sent_at     TIMESTAMPTZ NULL
        );
        CREATE INDEX IF NOT EXISTS idx_automation_notif_recipient
            ON automation_notification_events(recipient_user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_automation_notif_throttle
            ON automation_notification_events(automation_id, event, recipient_user_id, created_at);
    `);

    // ── Organisation templates ("Save as template") ───────────────────────
    // automation-extras-2026-06 used to create an automation_templates of its
    // own (§26 gallery: slug, definition, org_id) that nothing ever read or
    // wrote. On installs that carry it, the CREATE below was a no-op and the
    // index on organization_id failed. Clear it out of the way first: dropped
    // when empty (it always is: it never had a writer), renamed with its
    // indexes otherwise, so no row is lost.
    await exec(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema()
                   AND table_name = 'automation_templates' AND column_name = 'slug'
            ) THEN
                IF NOT EXISTS (SELECT 1 FROM automation_templates) THEN
                    DROP TABLE automation_templates;
                ELSE
                    ALTER TABLE automation_templates RENAME TO automation_templates_legacy_2026_06;
                    ALTER INDEX IF EXISTS idx_automation_templates_org RENAME TO idx_automation_templates_legacy_org;
                    ALTER INDEX IF EXISTS idx_automation_templates_category RENAME TO idx_automation_templates_legacy_category;
                    ALTER INDEX IF EXISTS idx_automation_templates_source RENAME TO idx_automation_templates_legacy_source;
                END IF;
            END IF;
        END $$;
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_templates (
            id               TEXT PRIMARY KEY,
            organization_id  TEXT NULL,
            created_by       TEXT NOT NULL,
            title            TEXT NOT NULL,
            description      TEXT NULL,
            icon             TEXT NULL,
            definition_json  JSONB NOT NULL,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_automation_templates_org ON automation_templates(organization_id);
    `);
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
}
