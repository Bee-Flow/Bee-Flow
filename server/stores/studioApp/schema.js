// @typecheck strict
/**
 * stores/studioApp/schema.js — the studio_apps / studio_app_versions schema
 * and the store's memoised init (one instance: every module awaits this one).
 */

const { dep } = require('./deps');
const { makeStoreInit } = require('../lib/storeInit');
const { runDdl } = require('../lib/_ddl');

const { exec } = dep('db');
const log = dep('log');

const initDB = makeStoreInit('StudioAppStore', _initDB);

async function _initDB() {

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_apps (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            organization_id TEXT,
            name TEXT NOT NULL DEFAULT 'Untitled app',
            description TEXT DEFAULT '',
            icon TEXT,
            accent_color TEXT,
            definition JSONB NOT NULL DEFAULT '{}'::jsonb,
            definition_version INTEGER NOT NULL DEFAULT 1,
            published_definition JSONB,
            builder_session JSONB,
            is_published BOOLEAN NOT NULL DEFAULT FALSE,
            shared_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
            published_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_apps_user ON studio_apps(user_id);
        CREATE INDEX IF NOT EXISTS idx_studio_apps_org ON studio_apps(organization_id) WHERE organization_id IS NOT NULL;
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_versions (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            definition JSONB NOT NULL,
            summary TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_versions_app ON studio_app_versions(app_id);
    `);

    // Additive migrations — CREATE TABLE IF NOT EXISTS won't add columns to a
    // pre-existing table, so every column beyond the primordial shape is also
    // applied as an idempotent ALTER. Via runDdl (stores/lib/_ddl.js): a
    // failing statement lands loudly in the failures list and the rest keeps
    // running — the old catch (_) also read a timeout as "column already exists".
    await runDdl('studioAppStore', [
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS organization_id TEXT`,
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''`,
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS icon TEXT`,
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS accent_color TEXT`,
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS definition JSONB NOT NULL DEFAULT '{}'::jsonb`,
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS definition_version INTEGER NOT NULL DEFAULT 1`,
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS published_definition JSONB`,
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS builder_session JSONB`,
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT FALSE`,
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS shared_groups JSONB NOT NULL DEFAULT '[]'::jsonb`,
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`,
        // ── App Studio v2 DATA ENGINE (per-app SQLite) ──────────────────
        // The per-app data.db blob's fingerprint + size, updated on every
        // debounce-flush from studioAppDbStore. db_sha256='' / db_size=0 means
        // no database has been materialised yet.
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS db_sha256 TEXT DEFAULT ''`,
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS db_size BIGINT DEFAULT 0`,
        // Reserved for future multi-replica handle affinity: which replica
        // currently owns the writable handle and until when. Written by the
        // DATA ENGINE lease logic when it lands — DO NOT route on these yet.
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS db_lease_owner TEXT`,
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS db_lease_expires_at TIMESTAMPTZ`,
        // Optimistic version of the *data model* (studio_app_data_meta.model),
        // mirrored here so an app-list read can tell whether an app has a data
        // model without joining. Bumped by studioAppDataStore.saveDataModel.
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS data_model_version INT DEFAULT 0`,
        // Which data engine serves this app's records: 'sqlite' (blob engine)
        // or 'pg' (per-app Postgres schema). A SAFETY INTERLOCK, not a router:
        // the env-selected engine refuses apps not marked for it, so a stale
        // replica can never write to the storage the fleet has migrated away
        // from. Flipped per app by the B3 migrator, in the same transaction as
        // the data copy.
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'sqlite'`,
        // Studio Project membership. NULL = standalone, which is every existing
        // app and stays the default; set = the app belongs to a project, and
        // its members are an audience for it alongside shared_groups — a
        // PUBLISHED app reaches them without being published to their org or
        // group. It does not reach past is_published: see
        // canReadStudioAppAsync for why publication is not an audience rule.
        // Soft reference like the conversation and automation equivalents, so
        // deleting a project detaches its apps instead of destroying them.
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS project_id TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_studio_apps_project ON studio_apps(project_id) WHERE project_id IS NOT NULL`,
        // Directory category — the value behind the filter pills on /app/apps
        // ("Sales", "Service", "Finance", …). TEXT in the column, but the
        // vocabulary is a CLOSED LIST owned by the organisation, not free text:
        // free text gives twelve chips and a spelling mistake inside a month.
        // That list (and the admin screen that edits it) lives above this
        // store, so nothing here validates the value — the column is the
        // substrate, the route trims and caps it. NULL = uncategorised, which
        // is every app that exists today.
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS category TEXT`,
        // ── Template provenance (template-upgrade feature) ──────────────
        // Which registry template the app was cloned from, at which template
        // version, and the sha256 of the canonical (key-sorted) JSON of the
        // definition AS INSTALLED. Hash equality with the current draft means
        // "never hand-edited since install" — the precondition for offering a
        // one-click upgrade to a newer template version. NULL on blank apps
        // and on apps created before this column existed (no upgrade offer).
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS template_id TEXT`,
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS template_version INT`,
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS template_install_hash TEXT`,
        // Nextcloud app-menu publication. Owner-controlled flag: when TRUE and
        // the app is org-published, the org's Nextcloud connector registers a
        // top-menu entry for it so the app opens on its own page inside
        // Nextcloud. Independent of is_published on purpose — unpublishing
        // hides the entry (the connector list filters on is_published) but
        // re-publishing restores it without the owner re-opting-in.
        `ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS nextcloud_menu BOOLEAN NOT NULL DEFAULT FALSE`,
        `ALTER TABLE studio_app_versions ADD COLUMN IF NOT EXISTS summary TEXT`,
    ]);

    // Columns whose rationale doesn't fit on one line live as their own
    // migration file under ../migrations (same convention as automationStore),
    // applied here so a plain `npm run db:migrate` — which only loads stores —
    // still brings them in. Tolerated individually like the ALTERs above.
    for (const name of ['studio-app-published-version-2026-08', 'studio-app-public-pages-2026-08']) {
        try { await dep('migration')(name).up(); } catch (e) {
            log.error(`[StudioAppStore] migration ${name} FAILED: ${/** @type {Error} */ (e).message}`);
        }
    }
    log.info('[StudioAppStore] PostgreSQL initialized');
}

module.exports = { initDB };
