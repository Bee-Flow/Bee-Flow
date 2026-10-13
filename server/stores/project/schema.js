// @typecheck
/**
 * stores/project/schema.js — the projects schema (DDL) and the memoised
 * init that applies it over db.js. Split out of stores/projectStore.js,
 * which re-exports both.
 */

const dbFacade = require('../../db');
const { makeStoreInit } = require('../lib/storeInit');
const { runDdl } = require('../lib/_ddl');
const log = require('../../telemetry/log');

/**
 * The whole schema, as boot runs it: the base batch through `exec`, then the
 * column ladder through `runDdl`. Both runners are parameters so the pglite
 * test applies exactly these statements (twice, for idempotence) instead of a
 * copy that could drift from them.
 *
 * @param {{ exec: (sql: string) => Promise<unknown>, runDdl: (tag: string, statements: any[]) => Promise<unknown> }} runners
 */
async function applyProjectSchema({ exec, runDdl }) {
    await exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            custom_instructions TEXT DEFAULT '',
            knowledge_base_ids JSONB DEFAULT '[]'::jsonb,
            color TEXT DEFAULT '#6366f1',
            icon TEXT DEFAULT '📁',
            owner_id TEXT NOT NULL,
            organization_id TEXT DEFAULT '',
            extract_memories BOOLEAN DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        -- Migrations
        DO $$ BEGIN
            ALTER TABLE projects ADD COLUMN IF NOT EXISTS knowledge_base_ids JSONB DEFAULT '[]'::jsonb;
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;
        
        DO $$ BEGIN
            ALTER TABLE projects ADD COLUMN IF NOT EXISTS extract_memories BOOLEAN DEFAULT false;
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;

        DO $$ BEGIN
            ALTER TABLE projects ADD COLUMN IF NOT EXISTS editors_can_invite BOOLEAN NOT NULL DEFAULT true;
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;

        DO $$ BEGIN
            ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
            ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_by TEXT;
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;

        CREATE TABLE IF NOT EXISTS project_shares (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            shared_with_type TEXT NOT NULL,
            shared_with_id TEXT NOT NULL,
            permission TEXT DEFAULT 'viewer',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
        CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization_id);
        -- listUserProjects orders by this on every call.
        CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_project_shares_project ON project_shares(project_id);
        CREATE INDEX IF NOT EXISTS idx_project_shares_shared ON project_shares(shared_with_type, shared_with_id);

        -- The column default was 'view', which the CHECK constraint added below
        -- ('viewer' | 'editor') rejects. Latent only because shareProject is the
        -- sole inserter and always normalises — but it would fire the moment
        -- anything else wrote the table.
        DO $$ BEGIN
            ALTER TABLE project_shares ALTER COLUMN permission SET DEFAULT 'viewer';
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;

        -- Migrate legacy permission vocabulary: 'view' → 'viewer', 'edit' → 'editor'
        DO $$ BEGIN
            UPDATE project_shares SET permission = 'viewer' WHERE permission = 'view';
            UPDATE project_shares SET permission = 'editor' WHERE permission = 'edit';
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;

        DO $$ BEGIN
            ALTER TABLE project_shares ADD COLUMN IF NOT EXISTS invited_by TEXT;
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;

        DO $$ BEGIN
            ALTER TABLE project_shares
                ADD CONSTRAINT project_shares_permission_chk
                CHECK (permission IN ('viewer', 'editor'));
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;

        -- One membership row per (project, principal).
        --
        -- Without this, shareProject's check-then-insert let two concurrent
        -- invites create duplicate rows — and then REVOKING A MEMBER SILENTLY
        -- FAILED: unshareProject deletes one share id, while getProjectRole
        -- does ORDER BY ... LIMIT 1 across all matching rows, so the survivor
        -- kept the access the admin believed they had removed.
        --
        -- Collapse existing duplicates first, keeping the HIGHEST permission so
        -- the dedupe never silently demotes someone mid-flight.
        -- Dedupe and index in ONE block: if the dedupe cannot complete, the index
        -- must not be attempted, and neither should take the whole store down —
        -- an unreachable projectStore breaks the feature entirely. Failure is
        -- logged as a WARNING so it is visible rather than swallowed; shareProject's
        -- ON CONFLICT then fails loudly per-request instead of racing quietly.
        DO $$ BEGIN
            DELETE FROM project_shares a
             USING project_shares b
             WHERE a.project_id = b.project_id
               AND a.shared_with_type = b.shared_with_type
               AND a.shared_with_id = b.shared_with_id
               AND ( CASE a.permission WHEN 'editor' THEN 1 ELSE 0 END,  a.ctid )
                 < ( CASE b.permission WHEN 'editor' THEN 1 ELSE 0 END,  b.ctid );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_project_shares_unique
                ON project_shares(project_id, shared_with_type, shared_with_id);
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'project_shares uniqueness migration failed: %', SQLERRM;
        END $$;

        -- Optimistic concurrency for project settings. The client PUTs the whole
        -- form, including a whole-array knowledge_base_ids replace, so two
        -- editors on the Knowledge tab silently clobbered each other and the
        -- activity log recorded a kb_removed nobody performed.
        -- Mirrors notebooks.version + notebookStore.updateNotebookCas.
        DO $$ BEGIN
            ALTER TABLE projects ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;

        -- Per-project event counter. See project_events below for why this is
        -- not a BIGSERIAL.
        DO $$ BEGIN
            ALTER TABLE projects ADD COLUMN IF NOT EXISTS event_seq BIGINT NOT NULL DEFAULT 0;
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;

        -- ── Live event log ──────────────────────────────────────────────────
        --
        -- The transient channel behind GET /:id/stream. project_activity remains
        -- the durable human-readable audit trail; this is the ordered feed a
        -- client tails, and rows are pruned after a week.
        --
        -- seq is allocated from projects.event_seq under the project's row
        -- lock, NOT from a BIGSERIAL. A sequence hands out values BEFORE commit,
        -- so a transaction holding seq=5 can commit after one holding seq=6 —
        -- and a client polling "seq > cursor" would skip 5 forever. Serialising
        -- per project costs nothing at this write rate and makes the cursor
        -- gapless, which is the entire basis of reconnect-without-loss.
        CREATE TABLE IF NOT EXISTS project_events (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            seq         BIGINT NOT NULL,
            kind        TEXT NOT NULL,
            actor_id    TEXT,
            target_type TEXT,
            target_id   TEXT,
            payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_project_events_project_seq
            ON project_events(project_id, seq);
        CREATE INDEX IF NOT EXISTS idx_project_events_created
            ON project_events(created_at);

        CREATE TABLE IF NOT EXISTS project_activity (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            actor_id    TEXT NOT NULL,
            action      TEXT NOT NULL,
            target_type TEXT,
            target_id   TEXT,
            details     JSONB DEFAULT '{}'::jsonb,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_project_activity_project_created
            ON project_activity(project_id, created_at DESC);
    `);

    // ── Where this Solution came from ───────────────────────────────────────
    //
    // Via runDdl (stores/lib/_ddl.js) rather than another `DO $$ … EXCEPTION
    // WHEN OTHERS THEN NULL` block: those swallow a statement timeout and a
    // dropped connection as readily as "column already exists", and the store
    // then reports itself healthy on a half-built schema.
    //
    // A SOFT reference, like every other project_id in this codebase and for
    // the mirror-image reason: `project_blueprints` rows are deletable by their
    // creator, and deleting the Blueprint somebody installed from must hand
    // them a Solution that no longer offers updates — never take the Solution
    // with it. So no FK, and a dangling id reads as "the Blueprint is gone",
    // which the overview must render as UNKNOWN rather than as up to date.
    //
    // The index is partial because almost every project has no Blueprint behind
    // it, and the only query is "the ones installed from this id". `projects`
    // is not one of the volume tables the _ddl.js runbook rule names, so a boot
    // build is free here.
    // ── En wat die herkomst er verder over zegt (O4) ────────────────────────
    //
    // `installed_from_org_id` is de organisatie waar de Oplossing vandaan komt,
    // en de TROUW ervan verschilt per pad: bij een galerij-installatie heeft de
    // server de galerijrij zelf gelezen, bij een BESTANDSinstallatie is het de
    // bewering van het bestand (manifest.source). Daarom beslist deze kolom
    // NOOIT iets: wie de installatietelling van een Blueprint mag zien wordt
    // beantwoord door `blueprintStore.canRead` over de echte galerijrij, nooit
    // door wat hier is opgeslagen. De kolom is geschiedenis, geen recht.
    //
    // `installed_version` is het versienummer waarop deze Oplossing binnenkwam
    // — hetzelfde nummer dat de stempels per entiteit dragen
    // (`project_solution_entities.installed_version`). Twee getallen die kunnen
    // verschillen zouden een bron van bugs zijn, dus er wordt er precies één
    // gelezen: `manifest.solution.version`. NULL betekent "niet vastgelegd" en
    // is iets anders dan 0 of 1 — een installatie zonder nummer mag nooit als
    // "bij" lezen.
    //
    // Geen extra index: beide kolommen worden gelezen bij het project dat je al
    // te pakken hebt. De enige telling loopt over `installed_from_blueprint_id`
    // en die heeft zijn eigen partiële index hierboven.
    await runDdl('projectStore', [
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS installed_from_blueprint_id TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_projects_installed_from
            ON projects(installed_from_blueprint_id) WHERE installed_from_blueprint_id IS NOT NULL`,
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS installed_from_org_id TEXT`,
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS installed_version INTEGER`,
    ]);

    // ── Workspace or Solution ───────────────────────────────────────────────
    //
    // `kind` tells a collaborative project from a Studio Solution. NULL is a
    // real value, not a missing default: it marks a row from before the split
    // that the backfill (migrations/project-kind-backfill-2026-09.js) could
    // not classify, and such a row is listed on both sides until its owner
    // picks one. Hence no DEFAULT: every INSERT names the kind it creates.
    //
    // The CHECK rides on the ADD COLUMN, so the column and its constraint
    // arrive in one statement and IF NOT EXISTS keeps the pair idempotent.
    //
    // `files_kb_id` is the knowledge base a workspace's uploaded files live in,
    // created on first upload (projects/projectFiles.js). A soft reference like
    // every other one on this row: deleting the base must not take the project.
    //
    // `kind_guessed` is TRUE on a row whose kind the backfill set rather than
    // its owner: the owner may correct that guess once (`setProjectKind`),
    // after which the kind is theirs and set for good.
    await runDdl('projectStore', [
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS kind TEXT
            CONSTRAINT projects_kind_chk CHECK (kind IS NULL OR kind IN ('workspace', 'solution'))`,
        `CREATE INDEX IF NOT EXISTS idx_projects_kind ON projects(kind)`,
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS files_kb_id TEXT`,
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS kind_guessed BOOLEAN NOT NULL DEFAULT FALSE`,
    ]);

    // ── Solution stages (UAT / PRD) ──────────────────────────────────────────
    //
    // A stage is its own `projects` row (kind 'solution') with `stage` and
    // `stage_of` (the Dev project's id, a soft reference like every other).
    // Both are WRITE-ONCE: only `createStageProject` sets them, on a new row,
    // and only `detachStage` clears them; `updateProject` never takes them.
    // That is what lets `stageOfProject` cache a negative answer for good.
    // One UAT and one PRD per Solution (the unique index). The pair CHECK is
    // added once, guarded on pg_constraint (the idiom of
    // migrations/approvals-v2-2026-09.js), so a later boot is a catalog lookup
    // and not a full scan of projects.
    await runDdl('projectStore', [
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS stage TEXT
            CONSTRAINT projects_stage_chk CHECK (stage IS NULL OR stage IN ('uat', 'prd'))`,
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS stage_of TEXT`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_stage ON projects(stage_of, stage) WHERE stage_of IS NOT NULL`,
        `DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_stage_pair_chk') THEN
                ALTER TABLE projects ADD CONSTRAINT projects_stage_pair_chk
                    CHECK ((stage IS NULL) = (stage_of IS NULL) AND (stage IS NULL OR kind = 'solution'));
            END IF;
        END $$`,
    ]);

    // ── What changed, and what each member has seen ─────────────────────────
    //
    // project_activity becomes the change feed as well as the audit trail
    // (stores/projectChanges.js):
    //   - `actor_id` may be NULL and `actor_kind` says who acted: a person, the
    //     AI on nobody's particular behalf, or the system;
    //   - `item_type`/`item_id` name the notebook, document or meeting a content
    //     row is about, and `version_id` the version it left behind;
    //   - `updated_at` moves when an edit folds into an open editing session.
    //     No backfill: existing rows keep NULL and every reader takes
    //     COALESCE(updated_at, created_at). Giving the column a default in the
    //     ADD would stamp every old row with the migration time, and the feed
    //     would then call a year of history "new since your last visit";
    //   - `seq` is the project_events seq of the row's latest event, and
    //     `emitted_at` when that event was written (a folded edit re-emits
    //     only now and then).
    //
    // project_member_state holds one member's marks per project: when they
    // first came, the current and the previous visit (the "since your last
    // visit" line), and "mark everything as seen". project_item_reads holds
    // when they last saw one item and which version that was. Both carry
    // times and ids only, and go with the project (CASCADE) or with the
    // member's account (eraseUserChangeState).
    await runDdl('projectStore', [
        `ALTER TABLE project_activity ALTER COLUMN actor_id DROP NOT NULL`,
        `ALTER TABLE project_activity ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL DEFAULT 'user'`,
        `ALTER TABLE project_activity ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
        `ALTER TABLE project_activity ALTER COLUMN updated_at SET DEFAULT NOW()`,
        `ALTER TABLE project_activity ADD COLUMN IF NOT EXISTS item_type TEXT`,
        `ALTER TABLE project_activity ADD COLUMN IF NOT EXISTS item_id TEXT`,
        `ALTER TABLE project_activity ADD COLUMN IF NOT EXISTS version_id TEXT`,
        `ALTER TABLE project_activity ADD COLUMN IF NOT EXISTS seq BIGINT`,
        `ALTER TABLE project_activity ADD COLUMN IF NOT EXISTS emitted_at TIMESTAMPTZ`,
        `CREATE INDEX IF NOT EXISTS idx_project_activity_item
            ON project_activity(project_id, item_type, item_id) WHERE item_id IS NOT NULL`,
        `CREATE TABLE IF NOT EXISTS project_member_state (
            project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            user_id          TEXT NOT NULL,
            seen_seq         BIGINT NOT NULL DEFAULT 0,
            seen_at          TIMESTAMPTZ,
            prev_visit_seq   BIGINT NOT NULL DEFAULT 0,
            prev_visit_at    TIMESTAMPTZ,
            visit_started_at TIMESTAMPTZ,
            last_visit_seq   BIGINT NOT NULL DEFAULT 0,
            last_visit_at    TIMESTAMPTZ,
            first_visit_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (project_id, user_id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_project_member_state_user ON project_member_state(user_id)`,
        `CREATE TABLE IF NOT EXISTS project_item_reads (
            project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            user_id         TEXT NOT NULL,
            item_type       TEXT NOT NULL,
            item_id         TEXT NOT NULL,
            seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            seen_version_id TEXT,
            PRIMARY KEY (project_id, user_id, item_type, item_id)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_project_item_reads_user ON project_item_reads(user_id)`,
    ]);
}

const initDB = makeStoreInit('ProjectStore', async () => {
    await applyProjectSchema({ exec: (sql) => dbFacade.exec(sql), runDdl });
    log.info('[ProjectStore] PostgreSQL initialized');
});

module.exports = { applyProjectSchema, initDB };
