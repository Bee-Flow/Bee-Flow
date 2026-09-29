// @typecheck
/**
 * Project Store — PostgreSQL-backed projects for organizing chats.
 *
 * Tables:
 *   - projects:          core project data (name, instructions, owner)
 *   - project_shares:    sharing records (user / group), permission ∈ {viewer, editor}
 *   - project_activity:  audit feed (member changes, edits, kb/conversation moves)
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec, getClient } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const { buildUpdate } = require('./lib/sqlBuilder');
const log = require('../telemetry/log');
const { parseJSONObject: parseJSON } = require('./lib/json');

const initDB = makeStoreInit('ProjectStore', _initDB);

async function _initDB() {

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
    log.info('[ProjectStore] PostgreSQL initialized');
}

// ── Helpers ──────────────────────────────────────────────


// ── CRUD ─────────────────────────────────────────────────

async function createProject({ name, description, customInstructions, color, icon, ownerId, organizationId, knowledgeBaseIds, extractMemories, installedFromBlueprintId = null, installedFromOrgId = null, installedVersion = null }) {
    await initDB();
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
        `INSERT INTO projects (id, name, description, custom_instructions, knowledge_base_ids, color, icon, owner_id, organization_id, extract_memories, installed_from_blueprint_id, installed_from_org_id, installed_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, name, description || '', customInstructions || '', kbIds, color || '#6366f1', icon || '📁', ownerId, organizationId || '', extractMemories || false, fromBlueprint, fromOrg, atVersion]
    );
    return { id, name, description, customInstructions, knowledgeBaseIds: knowledgeBaseIds || [], color, icon, ownerId, organizationId, extractMemories: extractMemories || false, installedFromBlueprintId: fromBlueprint, installedFromOrgId: fromOrg, installedVersion: atVersion };
}

async function getProject(id) {
    await initDB();
    const row = await getOne('SELECT * FROM projects WHERE id = $1', [id]);
    if (!row) return null;
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
        installedFromBlueprintId: row.installed_from_blueprint_id || null,
        // De organisatie die het bestand of de galerijrij als bron NOEMT — nooit
        // een grond voor toegang, zie de ladder hierboven.
        installedFromOrgId: row.installed_from_org_id || null,
        installedVersion: Number.isInteger(row.installed_version) ? row.installed_version : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * List projects the user can access (owned + shared via user or group).
 * @param {string} userId
 * @param {string[]} groupIds - groups the user belongs to
 */
async function listUserProjects(userId, groupIds = []) {
    await initDB();

    // Build a query that gets owned projects + projects shared with user or user's groups
    const params = [userId];
    let groupPlaceholders = '';
    if (groupIds.length > 0) {
        const placeholders = groupIds.map((_, i) => `$${i + 2}`).join(', ');
        groupPlaceholders = `OR (ps.shared_with_type = 'group' AND ps.shared_with_id IN (${placeholders}))`;
        params.push(...groupIds);
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
        WHERE p.owner_id = $1
           OR (ps.shared_with_type = 'user' AND ps.shared_with_id = $1)
           ${groupPlaceholders}
        ORDER BY p.updated_at DESC
    `, params);

    return rows.map(row => ({
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
        // Which Blueprint this Solution was installed from, if any. The
        // overview's "Installed" tab is this column being non-null; `null` is
        // "built here", and stays distinguishable from "the Blueprint is gone".
        installedFromBlueprintId: row.installed_from_blueprint_id || null,
        installedFromOrgId: row.installed_from_org_id || null,
        installedVersion: Number.isInteger(row.installed_version) ? row.installed_version : null,
        permission: row.user_permission || 'viewer',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }));
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

// Translate legacy permission vocabulary so external callers don't break.
function normalizePermission(permission) {
    if (permission === 'view') return 'viewer';
    if (permission === 'edit') return 'editor';
    if (permission === 'viewer' || permission === 'editor') return permission;
    return 'viewer';
}

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
//
// How many events a reconnecting client may replay in one go. Beyond this the
// stream tells it to resync from scratch rather than dribbling out a backlog:
// a client that was away that long is better off refetching than replaying.
const EVENT_REPLAY_LIMIT = 500;

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
 * Events after `sinceSeq`, oldest first — the reconnect catch-up query.
 *
 * `truncated` tells the caller the client is too far behind to replay and
 * should refetch instead.
 */
async function listProjectEvents(projectId, sinceSeq = 0, limit = EVENT_REPLAY_LIMIT) {
    await initDB();
    const capped = Math.min(Math.max(1, limit), EVENT_REPLAY_LIMIT);
    const rows = await getAll(
        `SELECT * FROM project_events
          WHERE project_id = $1 AND seq > $2
          ORDER BY seq ASC
          LIMIT $3`,
        [projectId, Number(sinceSeq) || 0, capped + 1]
    );
    const truncated = rows.length > capped;
    return {
        events: (truncated ? rows.slice(0, capped) : rows).map(r => ({
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
    return rows.map(r => ({
        id: r.id,
        projectId: r.project_id,
        actorId: r.actor_id,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        details: r.details || {},
        createdAt: r.created_at,
    }));
}

module.exports = {
    initDB,
    createProject,
    getProject,
    listUserProjects,
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
    normalizePermission,
    // Live feed (see the project_events DDL for the gapless-sequence rationale).
    appendProjectEvent,
    listProjectEvents,
    getProjectEventSeq,
    pruneProjectEvents,
    EVENT_REPLAY_LIMIT,
};
