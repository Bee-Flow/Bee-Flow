// @typecheck
/**
 * Project Store — PostgreSQL-backed projects.
 *
 * One table holds two kinds of container, told apart by `projects.kind`:
 *   - 'workspace'  a collaborative project (chats, documents, notebooks,
 *                  meetings, knowledge) — the Projects page;
 *   - 'solution'   a Studio Solution (automations, apps, webpages, tables,
 *                  agents) with export/import/install/upgrade;
 *   - NULL         legacy: created before the split and not classifiable from
 *                  its contents. Listed in BOTH places until its owner picks
 *                  one (`setProjectKind`, allowed while it is NULL, and once
 *                  more to correct a kind the backfill only guessed).
 * The ids never change with the kind, so Blueprint keys (`sol_<projectId>`),
 * every `project_id` column, shares and the event feed keep working.
 *
 * Tables:
 *   - projects:          core project data (name, instructions, owner, kind)
 *   - project_shares:    sharing records (user / group), permission ∈ {viewer, editor}
 *   - project_events:    the ordered live feed behind GET /:id/stream
 *   - project_activity:  audit feed (member changes, edits, kb/conversation moves)
 *                        and the content change feed (editing sessions)
 *   - project_member_state / project_item_reads: each member's visits and what
 *                        they last saw (the "since your last visit" and unread
 *                        marks; functions in stores/projectChanges.js)
 *
 * The functions are built by `makeProjectStore(db, { ready })` over a facade
 * with db.js's shape (`run`, `getOne`, `getAll`, `getClient`), so a test can
 * run them against pglite without replacing any module. The default instance
 * (the module's own exports) wraps db.js behind the store's schema init.
 */

const crypto = require('crypto');
const dbFacade = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const { buildUpdate } = require('./lib/sqlBuilder');
const log = require('../telemetry/log');
const { parseJSONObject: parseJSON } = require('./lib/json');
const { makeProjectChangeFns, mapActivityRow } = require('./projectChanges');

/** The two kinds a project can be. NULL (legacy) is the absence of one. */
const PROJECT_KINDS = Object.freeze(['workspace', 'solution']);

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

// ── Helpers ──────────────────────────────────────────────

/**
 * The kind a new project is created as. Omitted means 'workspace': the
 * collaborative project is what "a project" is; a Solution says so.
 * @param {unknown} kind
 * @returns {'workspace'|'solution'}
 */
function kindForNewProject(kind) {
    if (kind === undefined || kind === null) return 'workspace';
    if (kind === 'workspace' || kind === 'solution') return kind;
    throw new TypeError(`A project kind is 'workspace' or 'solution', not ${JSON.stringify(kind)}.`);
}

/** A stored kind as the API speaks it: one of the two, or null (legacy). */
function kindOf(row) {
    return row && (row.kind === 'workspace' || row.kind === 'solution') ? row.kind : null;
}

/** A projects row as the API speaks it (getProject, and each listUserProjects row). */
function mapProjectRow(row) {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        customInstructions: row.custom_instructions,
        knowledgeBaseIds: parseJSON(row.knowledge_base_ids, []),
        color: row.color,
        icon: row.icon,
        ownerId: row.owner_id,
        organizationId: row.organization_id,
        extractMemories: row.extract_memories,
        version: row.version,
        // 'workspace' | 'solution', or null for a legacy row nobody has
        // classified yet.
        kind: kindOf(row),
        // True while the kind is the backfill's guess, which the owner may
        // still correct once (setProjectKind).
        kindGuessed: row.kind_guessed === true,
        filesKbId: row.files_kb_id || null,
        // Which Blueprint this Solution was installed from, if any. The
        // overview's "Installed" tab is this column being non-null; `null` is
        // "built here", and stays distinguishable from "the Blueprint is gone".
        installedFromBlueprintId: row.installed_from_blueprint_id || null,
        // The organisation the file or gallery row NAMES as its source; never a
        // ground for access (see the ladder above).
        installedFromOrgId: row.installed_from_org_id || null,
        installedVersion: Number.isInteger(row.installed_version) ? row.installed_version : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// Translate legacy permission vocabulary so external callers don't break.
function normalizePermission(permission) {
    if (permission === 'view') return 'viewer';
    if (permission === 'edit') return 'editor';
    if (permission === 'viewer' || permission === 'editor') return permission;
    return 'viewer';
}

// How many events a reconnecting client may replay in one go. Beyond this the
// stream tells it to resync from scratch rather than dribbling out a backlog:
// a client that was away that long is better off refetching than replaying.
const EVENT_REPLAY_LIMIT = 500;

// SQLSTATEs that mean "this installation has no shared conversations at all":
// the agent schema was never created here, or predates sharing.
const NO_SHARING_SCHEMA = new Set(['42P01', '42703']);

/**
 * The store's functions over one database facade.
 *
 * @param {{
 *   run: (sql: string, params?: any[]) => Promise<{ rowCount: number, rows?: any[] }>,
 *   getOne: (sql: string, params?: any[]) => Promise<any>,
 *   getAll: (sql: string, params?: any[]) => Promise<any[]>,
 *   getClient: () => Promise<{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>, release: () => void }>,
 * }} db  db.js, or a facade of the same shape (pglite in the store test)
 * @param {{ ready?: () => Promise<unknown> }} [opts]  the schema init every function awaits first
 */
function makeProjectStore(db, { ready = async () => {} } = {}) {
    const initDB = ready;
    const run = (sql, params) => db.run(sql, params);
    const getOne = (sql, params) => db.getOne(sql, params);
    const getAll = (sql, params) => db.getAll(sql, params);
    const getClient = () => db.getClient();

    // ── CRUD ─────────────────────────────────────────────────

    /**
     * Create a project. `kind` defaults to 'workspace'; a Solution says so
     * (the Studio form and the Blueprint installer both do).
     */
    async function createProject({ name, description, customInstructions, color, icon, ownerId, organizationId, knowledgeBaseIds, extractMemories, installedFromBlueprintId = null, installedFromOrgId = null, installedVersion = null, kind = 'workspace' }) {
        await initDB();
        const projectKind = kindForNewProject(kind);
        const id = crypto.randomUUID();
        const kbIds = JSON.stringify(knowledgeBaseIds || []);
        // De drie herkomstvelden worden bij de INSERT geschreven en niet achteraf
        // gepatcht: ze zijn een feit over hoe dit project is ontstaan, en een tweede
        // statement is een tweede ding dat kan falen en een Oplossing achterlaat die
        // niet kan zeggen waar zij vandaan komt.
        const fromBlueprint = typeof installedFromBlueprintId === 'string' && installedFromBlueprintId
            ? installedFromBlueprintId : null;
        const fromOrg = typeof installedFromOrgId === 'string' && installedFromOrgId
            ? installedFromOrgId : null;
        // NULL blijft NULL: "niet vastgelegd" is iets anders dan versie 1, en een
        // installatie zonder nummer mag nooit als bijgewerkt lezen.
        const atVersion = Number.isInteger(installedVersion) && installedVersion > 0 ? installedVersion : null;
        await run(
            `INSERT INTO projects (id, name, description, custom_instructions, knowledge_base_ids, color, icon, owner_id, organization_id, extract_memories, installed_from_blueprint_id, installed_from_org_id, installed_version, kind)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [id, name, description || '', customInstructions || '', kbIds, color || '#6366f1', icon || '📁', ownerId, organizationId || '', extractMemories || false, fromBlueprint, fromOrg, atVersion, projectKind]
        );
        return { id, name, description, customInstructions, knowledgeBaseIds: knowledgeBaseIds || [], color, icon, ownerId, organizationId, extractMemories: extractMemories || false, installedFromBlueprintId: fromBlueprint, installedFromOrgId: fromOrg, installedVersion: atVersion, kind: projectKind, kindGuessed: false, filesKbId: null };
    }

    async function getProject(id) {
        await initDB();
        const row = await getOne('SELECT * FROM projects WHERE id = $1', [id]);
        return row ? mapProjectRow(row) : null;
    }

    /**
     * List projects the user can access (owned + shared via user or group).
     *
     * `kind` narrows the list to one side of the split, and a legacy row
     * (kind NULL) belongs to BOTH sides until its owner classifies it:
     *   'workspace' → kind = 'workspace' OR kind IS NULL
     *   'solution'  → kind = 'solution'  OR kind IS NULL
     *   omitted     → every project the user can access. Access paths (who may
     *                 read a published app, and so on) rely on that; only the
     *                 two LISTINGS narrow.
     *
     * @param {string} userId
     * @param {string[]} groupIds - groups the user belongs to
     * @param {{ kind?: 'workspace'|'solution' }} [opts]
     */
    async function listUserProjects(userId, groupIds = [], { kind } = {}) {
        await initDB();
        if (kind !== undefined && kind !== null && !PROJECT_KINDS.includes(kind)) {
            throw new TypeError(`listUserProjects: kind is 'workspace' or 'solution', not ${JSON.stringify(kind)}.`);
        }

        // Build a query that gets owned projects + projects shared with user or user's groups
        const params = [userId];
        let groupPlaceholders = '';
        if (groupIds.length > 0) {
            const placeholders = groupIds.map((_, i) => `$${i + 2}`).join(', ');
            groupPlaceholders = `OR (ps.shared_with_type = 'group' AND ps.shared_with_id IN (${placeholders}))`;
            params.push(...groupIds);
        }
        let kindFilter = '';
        if (kind) {
            params.push(kind);
            kindFilter = `AND (p.kind = $${params.length} OR p.kind IS NULL)`;
        }

        const rows = await getAll(`
            SELECT DISTINCT p.*,
                CASE WHEN p.owner_id = $1 THEN 'owner' ELSE COALESCE(
                    (SELECT ps2.permission FROM project_shares ps2
                     WHERE ps2.project_id = p.id AND (
                         (ps2.shared_with_type = 'user' AND ps2.shared_with_id = $1)
                         ${groupPlaceholders.replace(/ps\./g, 'ps2.')}
                     )
                     ORDER BY CASE ps2.permission WHEN 'editor' THEN 0 ELSE 1 END
                     LIMIT 1),
                    'viewer'
                ) END as user_permission
            FROM projects p
            LEFT JOIN project_shares ps ON ps.project_id = p.id
            WHERE (p.owner_id = $1
               OR (ps.shared_with_type = 'user' AND ps.shared_with_id = $1)
               ${groupPlaceholders})
               ${kindFilter}
            ORDER BY p.updated_at DESC
        `, params);

        return rows.map(row => ({ ...mapProjectRow(row), permission: row.user_permission || 'viewer' }));
    }

    /**
     * The owner's classification of a legacy project, once.
     *
     * Only while `kind` is still NULL, or is the backfill's guess
     * (`kind_guessed`): the owner may correct a guess one time, and from then
     * on the kind is theirs. Moving a project the owner classified to the
     * other side would change what it may hold (a Solution holds no chats, a
     * workspace carries no Blueprint), and that is not a settings toggle; the
     * route checks first that the project holds nothing the new side refuses
     * (projects/kindChange.js). The predicate is in the UPDATE itself, so two
     * owners' tabs racing each other cannot both win.
     *
     * Neither `version` nor anything the settings form edits changes, so an
     * editor with the form open does not get a spurious conflict.
     *
     * @param {string} id
     * @param {'workspace'|'solution'} kind
     * @returns {Promise<object|null>} the updated project, or null when it is
     *          gone or its kind is already the owner's
     */
    async function setProjectKind(id, kind) {
        await initDB();
        if (!PROJECT_KINDS.includes(kind)) {
            throw new TypeError(`setProjectKind: kind is 'workspace' or 'solution', not ${JSON.stringify(kind)}.`);
        }
        const { rowCount } = await run(
            `UPDATE projects SET kind = $2, kind_guessed = FALSE, updated_at = NOW()
              WHERE id = $1 AND (kind IS NULL OR kind_guessed)`,
            [id, kind]
        );
        if (!rowCount) return null;
        return await getProject(id);
    }

    /**
     * How many of the things only a collaborative project holds are in this
     * one: conversations filed in it (direct and agent, shared or not) and
     * team chats. Read before a project becomes a Solution, which holds
     * neither. A table this install does not have counts 0.
     *
     * @param {string} projectId
     * @returns {Promise<{ conversations: number, teamChats: number }>}
     */
    async function countChatHoldings(projectId) {
        await initDB();
        const count = async (sql) => {
            try {
                const row = await getOne(sql, [projectId]);
                return Number(row?.n) || 0;
            } catch (err) {
                if (NO_SHARING_SCHEMA.has(err?.code)) return 0;
                throw err;
            }
        };
        const [direct, agent, teamChats] = [
            await count('SELECT COUNT(*) AS n FROM direct_conversations WHERE project_id = $1'),
            await count('SELECT COUNT(*) AS n FROM agent_conversations WHERE project_id = $1'),
            await count('SELECT COUNT(*) AS n FROM project_chats WHERE project_id = $1'),
        ];
        return { conversations: direct + agent, teamChats };
    }

    /**
     * Record the knowledge base a project's uploaded files live in.
     *
     * First writer wins: the UPDATE only applies while nothing is recorded
     * (or, with `expected`, while the recorded id is still the stale one the
     * caller saw), so two first uploads at once cannot both register a base.
     * The loser reads back the winner's id and discards its own base.
     *
     * @param {string} projectId
     * @param {string} kbId
     * @param {{ expected?: string|null }} [opts]  replace this recorded id instead of NULL
     * @returns {Promise<string|null>} the id now stored, or null when the project is gone
     */
    async function setFilesKbId(projectId, kbId, { expected = null } = {}) {
        await initDB();
        if (typeof kbId !== 'string' || !kbId) throw new TypeError('setFilesKbId: kbId is a knowledge base id.');
        await run(
            `UPDATE projects SET files_kb_id = $2
              WHERE id = $1 AND files_kb_id IS NOT DISTINCT FROM $3`,
            [projectId, kbId, typeof expected === 'string' && expected ? expected : null]
        );
        const row = await getOne('SELECT files_kb_id FROM projects WHERE id = $1', [projectId]);
        return row ? (row.files_kb_id || null) : null;
    }

    /**
     * How many conversations are SHARED into this project (direct and agent).
     *
     * Deleting a project with one still shared cannot succeed: the conversation
     * FKs set `project_id` to NULL on delete, and a shared conversation must
     * keep its project (CHECK `shared_scope = 'private' OR project_id IS NOT
     * NULL`), so Postgres refuses the whole DELETE. Unsharing re-encrypts under
     * the owner's key, which only the owner's session holds, so the delete
     * route asks for that first instead of attempting it.
     *
     * @param {string} projectId
     * @returns {Promise<number>}
     */
    async function countSharedThreads(projectId) {
        await initDB();
        try {
            const row = await getOne(
                `SELECT (SELECT COUNT(*) FROM direct_conversations WHERE project_id = $1 AND shared_scope = 'project')
                      + (SELECT COUNT(*) FROM agent_conversations  WHERE project_id = $1 AND shared_scope = 'project') AS n`,
                [projectId]
            );
            return Number(row?.n) || 0;
        } catch (err) {
            // No conversation tables, or none with sharing: nothing can be shared.
            if (NO_SHARING_SCHEMA.has(err?.code)) return 0;
            throw err;
        }
    }

    /**
     * The conversations SHARED into this project, as ids only: which chat,
     * which table, and whose it is. What a refused project delete names, so
     * the owner knows whom to ask: only a conversation's own owner can unshare
     * it (it is re-encrypted under their key). Oldest share first, capped.
     *
     * @param {string} projectId
     * @param {{ limit?: number }} [opts]
     * @returns {Promise<Array<{ id: string, type: 'direct'|'agent', ownerId: string }>>}
     */
    async function listSharedThreads(projectId, { limit = 20 } = {}) {
        await initDB();
        const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
        try {
            const rows = await getAll(
                `SELECT id, user_id, type FROM (
                    SELECT id, user_id, 'direct' AS type, shared_at FROM direct_conversations
                     WHERE project_id = $1 AND shared_scope = 'project'
                    UNION ALL
                    SELECT id, user_id, 'agent' AS type, shared_at FROM agent_conversations
                     WHERE project_id = $1 AND shared_scope = 'project'
                 ) s
                 ORDER BY shared_at NULLS FIRST, id
                 LIMIT $2`,
                [projectId, cap]
            );
            return rows.map(r => ({ id: r.id, type: r.type === 'agent' ? 'agent' : 'direct', ownerId: r.user_id }));
        } catch (err) {
            if (NO_SHARING_SCHEMA.has(err?.code)) return [];
            throw err;
        }
    }

    /**
     * Where one of the caller's OWN conversations is filed, and whether it is
     * shared there. Matches on `user_id`, so it never says anything about
     * somebody else's conversation: that reads as null, like one that does
     * not exist.
     *
     * @param {string} conversationId
     * @param {string} userId
     * @param {string} [tableName]  'direct_conversations' | 'agent_conversations'
     * @returns {Promise<{ projectId: string|null, shared: boolean }|null>}
     */
    async function getOwnConversationFiling(conversationId, userId, tableName = 'direct_conversations') {
        await initDB();
        if (!conversationId || !userId) return null;
        const safeTable = tableName === 'agent_conversations' ? 'agent_conversations' : 'direct_conversations';
        try {
            const row = await getOne(
                `SELECT project_id, shared_scope FROM ${safeTable} WHERE id = $1 AND user_id = $2`,
                [conversationId, userId]
            );
            return row ? { projectId: row.project_id || null, shared: row.shared_scope === 'project' } : null;
        } catch (err) {
            if (NO_SHARING_SCHEMA.has(err?.code)) return null;
            throw err;
        }
    }

    const PROJECT_COLUMNS = {
        // A whole-array replace, so it is serialized rather than merged.
        knowledgeBaseIds: { col: 'knowledge_base_ids', transform: v => JSON.stringify(v) },
        name: 'name',
        description: 'description',
        customInstructions: 'custom_instructions',
        color: 'color',
        icon: 'icon',
        extractMemories: 'extract_memories',
    };

    /**
     * Update a project's settings.
     *
     * Pass `expectedVersion` for optimistic concurrency: the write applies only if
     * the row still carries that version, otherwise this returns
     * `{ conflict: true, current }` and the caller surfaces a 409.
     *
     * This matters because the client PUTs the ENTIRE form and knowledge_base_ids
     * is a whole-array replace. Two editors each adding a different KB meant the
     * second save deleted the first's, and the activity feed dutifully logged a
     * kb_removed nobody performed. Same for an 8000-character instruction block.
     *
     * Omitting expectedVersion keeps the old last-write-wins behaviour, so existing
     * callers are unaffected.
     * @param id
     * @param updates
     * @param {{ expectedVersion?: number }} [opts]
     */
    async function updateProject(id, updates, { expectedVersion } = {}) {
        await initDB();
        const existing = await getOne('SELECT id, owner_id, version FROM projects WHERE id = $1', [id]);
        if (!existing) return null;

        if (expectedVersion !== undefined && expectedVersion !== null
            && Number(existing.version) !== Number(expectedVersion)) {
            return { conflict: true, current: await getProject(id) };
        }

        // Re-check the version IN the UPDATE, not just in the SELECT above: between
        // the two, another editor may have committed. The predicate makes the check
        // and the write one atomic step.
        const where = [{ col: 'id', value: id }];
        if (expectedVersion !== undefined && expectedVersion !== null) {
            where.push({ col: 'version', value: Number(expectedVersion) });
        }

        const built = buildUpdate({
            table: 'projects',
            updates,
            columnMap: PROJECT_COLUMNS,
            extraSet: ['updated_at = NOW()', 'version = version + 1'],
            where,
            quoteCols: true,
        });
        if (!built) return await getProject(id);

        const { rowCount } = await run(built.sql, built.params);
        if (rowCount === 0 && expectedVersion !== undefined && expectedVersion !== null) {
            return { conflict: true, current: await getProject(id) };
        }
        return await getProject(id);
    }

    async function deleteProject(id) {
        await initDB();
        // project_shares cascade-deleted via FK
        const { rowCount } = await run('DELETE FROM projects WHERE id = $1', [id]);
        return rowCount > 0;
    }

    // ── Sharing ──────────────────────────────────────────────

    /**
     * Invite a user or group, or change their permission if already invited.
     *
     * A single upsert, not check-then-insert. The old shape raced: two concurrent
     * invites both saw "no existing row" and both inserted, producing a duplicate
     * membership that made a later revocation a no-op (unshareProject removes one
     * row by id; getProjectRole picks the best of whatever remains).
     *
     * Returns the share id — the existing one when this was an update.
     */
    async function shareProject(projectId, sharedWithType, sharedWithId, permission = 'viewer', invitedBy = null) {
        await initDB();
        const perm = normalizePermission(permission);
        const id = crypto.randomUUID();
        const row = await getOne(
            `INSERT INTO project_shares (id, project_id, shared_with_type, shared_with_id, permission, invited_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (project_id, shared_with_type, shared_with_id)
             DO UPDATE SET permission = EXCLUDED.permission
             RETURNING id`,
            [id, projectId, sharedWithType, sharedWithId, perm, invitedBy]
        );
        return row?.id || id;
    }

    async function getShareById(shareId) {
        await initDB();
        const r = await getOne('SELECT * FROM project_shares WHERE id = $1', [shareId]);
        if (!r) return null;
        return {
            id: r.id,
            projectId: r.project_id,
            sharedWithType: r.shared_with_type,
            sharedWithId: r.shared_with_id,
            permission: r.permission,
            invitedBy: r.invited_by,
            createdAt: r.created_at,
        };
    }

    async function updateMemberRole(shareId, role) {
        await initDB();
        const perm = normalizePermission(role);
        const { rowCount } = await run(
            'UPDATE project_shares SET permission = $1 WHERE id = $2',
            [perm, shareId]
        );
        return rowCount > 0;
    }

    async function unshareProject(shareId) {
        await initDB();
        const { rowCount } = await run('DELETE FROM project_shares WHERE id = $1', [shareId]);
        return rowCount > 0;
    }

    async function getProjectShares(projectId) {
        await initDB();
        const rows = await getAll('SELECT * FROM project_shares WHERE project_id = $1 ORDER BY created_at', [projectId]);
        return rows.map(r => ({
            id: r.id,
            projectId: r.project_id,
            sharedWithType: r.shared_with_type,
            sharedWithId: r.shared_with_id,
            permission: r.permission,
            createdAt: r.created_at,
        }));
    }

    // ── Conversation assignment ──────────────────────────────

    // Both helpers require userId so we only touch conversations the caller owns.
    // Without this guard, anyone with editor+ on a project could attach (or detach)
    // other users' conversations via the project assignment endpoint.
    async function assignConversation(conversationId, projectId, userId, tableName = 'direct_conversations') {
        await initDB();
        if (!userId) return false;
        const safeTable = tableName === 'agent_conversations' ? 'agent_conversations' : 'direct_conversations';
        const { rowCount } = await run(
            `UPDATE ${safeTable} SET project_id = $1 WHERE id = $2 AND user_id = $3`,
            [projectId, conversationId, userId]
        );
        return rowCount > 0;
    }

    async function unassignConversation(conversationId, userId, tableName = 'direct_conversations') {
        await initDB();
        if (!userId) return false;
        const safeTable = tableName === 'agent_conversations' ? 'agent_conversations' : 'direct_conversations';
        const { rowCount } = await run(
            `UPDATE ${safeTable} SET project_id = NULL WHERE id = $1 AND user_id = $2`,
            [conversationId, userId]
        );
        return rowCount > 0;
    }

    // ── Access check ─────────────────────────────────────────

    /**
     * Returns the user's effective role on a project: 'owner' | 'editor' | 'viewer' | null.
     * Owner trumps any share. For non-owners, returns the highest matching share permission
     * across direct user shares and group shares.
     *
     * @param {string} userId
     * @param {string} projectId
     * @param {string[]} groupIds - groups the user belongs to
     */
    async function getProjectRole(userId, projectId, groupIds = []) {
        await initDB();
        if (!userId || !projectId) return null;
        const project = await getOne('SELECT owner_id FROM projects WHERE id = $1', [projectId]);
        if (!project) return null;
        if (project.owner_id === userId) return 'owner';

        const groupArr = (groupIds && groupIds.length > 0) ? groupIds : [''];
        const row = await getOne(`
            SELECT permission FROM project_shares
            WHERE project_id = $1
              AND ((shared_with_type = 'user'  AND shared_with_id = $2)
                OR (shared_with_type = 'group' AND shared_with_id = ANY($3::text[])))
            ORDER BY CASE permission WHEN 'editor' THEN 0 ELSE 1 END
            LIMIT 1
        `, [projectId, userId, groupArr]);
        return row?.permission || null;
    }

    /**
     * Backwards-compatible boolean wrapper. New code should call getProjectRole.
     */
    async function userHasAccess(userId, projectId, groupIds = []) {
        const role = await getProjectRole(userId, projectId, groupIds);
        return role !== null;
    }

    // ── Activity feed ────────────────────────────────────────

    async function logActivity(projectId, actorId, action, details = {}) {
        await initDB();
        if (!projectId || !actorId || !action) return null;
        const id = crypto.randomUUID();
        const targetType = details.targetType || null;
        const targetId = details.targetId || null;
        try {
            await run(
                `INSERT INTO project_activity (id, project_id, actor_id, action, target_type, target_id, details)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [id, projectId, actorId, action, targetType, targetId, JSON.stringify(details)]
            );
        } catch (err) {
            log.warn('[ProjectStore] logActivity failed:', err.message);
            return null;
        }
        return id;
    }

    // ── Live events ──────────────────────────────────────────────────────
    // (EVENT_REPLAY_LIMIT, the replay cap, is defined above the factory.)

    /**
     * Append an event and return its project-scoped sequence number.
     *
     * The counter lives on the projects row and is incremented inside the same
     * transaction as the INSERT, so the UPDATE's row lock serialises writers for
     * this project. That is what makes the sequence gapless and commit-ordered —
     * see the project_events DDL for why a BIGSERIAL cannot give that.
     *
     * Best-effort by design: a live-feed notification must never fail the action it
     * is reporting. Failures are logged and swallowed, and a client that misses an
     * event still converges via its next reconnect or refetch.
     *
     * @returns {Promise<{seq: number, id: string}|null>}
     * @param projectId
     * @param {{ kind?: string, actorId?: string|null, targetType?: string|null, targetId?: string|null, payload?: object }} [opts]
     */
    async function appendProjectEvent(projectId, { kind, actorId = null, targetType = null, targetId = null, payload = {} } = {}) {
        await initDB();
        if (!projectId || !kind) return null;

        const client = await getClient();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(
                'UPDATE projects SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq',
                [projectId]
            );
            if (rows.length === 0) {          // project vanished mid-flight
                await client.query('ROLLBACK');
                return null;
            }
            const seq = Number(rows[0].event_seq);
            const id = crypto.randomUUID();
            await client.query(
                `INSERT INTO project_events (id, project_id, seq, kind, actor_id, target_type, target_id, payload)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [id, projectId, seq, kind, actorId, targetType, targetId, JSON.stringify(payload || {})]
            );
            await client.query('COMMIT');
            return { seq, id };
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
            log.warn('[ProjectStore] appendProjectEvent failed:', err.message);
            return null;
        } finally {
            client.release();
        }
    }

    /**
     * Events after `sinceSeq`, oldest first: the reconnect catch-up query.
     *
     * `truncated` asks the stream for a resync (the client refetches instead
     * of replaying): more follow than one replay carries, or the cursor
     * points into a stretch that was pruned (jobs/projectEventsPrune.js).
     * Seqs are gapless, allocated with their row in one transaction, so a
     * first surviving seq past `sinceSeq + 1` means rows were deleted. When
     * nothing after the cursor survives while the project's counter moved
     * on, the answer is ONE durable `resync` event at the head: the stream's
     * cursor, and the client's, then move past the hole, so it is said once
     * and not on every poll. The head is read in the same statement (one
     * snapshot), so an event committed in between never looks like a hole.
     */
    async function listProjectEvents(projectId, sinceSeq = 0, limit = EVENT_REPLAY_LIMIT) {
        await initDB();
        const capped = Math.min(Math.max(1, limit), EVENT_REPLAY_LIMIT);
        const since = Number(sinceSeq) || 0;
        const rows = await getAll(
            `SELECT p.event_seq AS head_seq, e.*
               FROM projects p
               LEFT JOIN LATERAL (
                   SELECT id, seq, kind, actor_id, target_type, target_id, payload, created_at
                     FROM project_events
                    WHERE project_id = p.id AND seq > $2
                    ORDER BY seq ASC
                    LIMIT $3
               ) e ON true
              WHERE p.id = $1
              ORDER BY e.seq ASC`,
            [projectId, since, capped + 1]
        );
        const head = rows.length ? Number(rows[0].head_seq) || 0 : 0;
        const found = rows.filter(r => r.id != null);
        if (since > 0 && !found.length && head > since) {
            return {
                events: [{ id: null, seq: head, kind: 'resync', actorId: null, targetType: null, targetId: null, payload: { reason: 'pruned' }, createdAt: null }],
                truncated: false,
            };
        }
        const truncated = found.length > capped || (since > 0 && found.length > 0 && Number(found[0].seq) > since + 1);
        return {
            events: found.slice(0, capped).map(r => ({
                id: r.id,
                seq: Number(r.seq),
                kind: r.kind,
                actorId: r.actor_id,
                targetType: r.target_type,
                targetId: r.target_id,
                payload: r.payload || {},
                createdAt: r.created_at,
            })),
            truncated,
        };
    }

    /** Current head, so a fresh subscriber can start from "now" and miss nothing. */
    async function getProjectEventSeq(projectId) {
        await initDB();
        const row = await getOne('SELECT event_seq FROM projects WHERE id = $1', [projectId]);
        return row ? Number(row.event_seq) : 0;
    }

    /** Housekeeping: drop events older than `days`. The audit trail is elsewhere. */
    async function pruneProjectEvents(days = 7) {
        await initDB();
        const { rowCount } = await run(
            `DELETE FROM project_events WHERE created_at < NOW() - ($1 || ' days')::interval`,
            [String(Math.max(1, days))]
        );
        return rowCount;
    }

    async function listActivity(projectId, limit = 50, offset = 0) {
        await initDB();
        const rows = await getAll(
            `SELECT * FROM project_activity
             WHERE project_id = $1
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [projectId, limit, offset]
        );
        // actorKind, itemType/itemId, versionId and updatedAt come with the
        // change feed (stores/projectChanges.js); older rows read as a
        // person's action that was never folded.
        return rows.map(mapActivityRow);
    }

    // The change feed: editing sessions, visits and seen marks.
    const changes = makeProjectChangeFns({ getOne, getAll, run, getClient, ready: initDB });

    return {
        ...changes,
        createProject,
        getProject,
        listUserProjects,
        setProjectKind,
        countChatHoldings,
        listSharedThreads,
        getOwnConversationFiling,
        setFilesKbId,
        countSharedThreads,
        updateProject,
        deleteProject,
        shareProject,
        unshareProject,
        getProjectShares,
        getShareById,
        updateMemberRole,
        assignConversation,
        unassignConversation,
        getProjectRole,
        userHasAccess,
        logActivity,
        listActivity,
        appendProjectEvent,
        listProjectEvents,
        getProjectEventSeq,
        pruneProjectEvents,
    };
}

// The instance the app uses: db.js, behind the store's schema init.
const store = makeProjectStore(dbFacade, { ready: initDB });

module.exports = {
    initDB,
    makeProjectStore,
    applyProjectSchema,
    PROJECT_KINDS,
    createProject: store.createProject,
    getProject: store.getProject,
    listUserProjects: store.listUserProjects,
    // The workspace / Solution split (see the header).
    setProjectKind: store.setProjectKind,
    countChatHoldings: store.countChatHoldings,
    listSharedThreads: store.listSharedThreads,
    getOwnConversationFiling: store.getOwnConversationFiling,
    setFilesKbId: store.setFilesKbId,
    countSharedThreads: store.countSharedThreads,
    updateProject: store.updateProject,
    deleteProject: store.deleteProject,
    shareProject: store.shareProject,
    unshareProject: store.unshareProject,
    getProjectShares: store.getProjectShares,
    getShareById: store.getShareById,
    updateMemberRole: store.updateMemberRole,
    assignConversation: store.assignConversation,
    unassignConversation: store.unassignConversation,
    getProjectRole: store.getProjectRole,
    userHasAccess: store.userHasAccess,
    logActivity: store.logActivity,
    listActivity: store.listActivity,
    normalizePermission,
    // Live feed (see the project_events DDL for the gapless-sequence rationale).
    appendProjectEvent: store.appendProjectEvent,
    listProjectEvents: store.listProjectEvents,
    getProjectEventSeq: store.getProjectEventSeq,
    pruneProjectEvents: store.pruneProjectEvents,
    EVENT_REPLAY_LIMIT,
    // The change feed (stores/projectChanges.js): the audit row and its live
    // event in one transaction, editing sessions, visits and seen marks.
    recordActivityEvent: store.recordActivityEvent,
    recordContentSession: store.recordContentSession,
    recordVisit: store.recordVisit,
    markAllSeen: store.markAllSeen,
    getMemberState: store.getMemberState,
    markItemSeen: store.markItemSeen,
    listItemReads: store.listItemReads,
    listChangeRows: store.listChangeRows,
    listChangeLog: store.listChangeLog,
    eraseUserChangeState: store.eraseUserChangeState,
};
