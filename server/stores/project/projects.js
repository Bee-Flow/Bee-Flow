// @typecheck
/**
 * stores/project/projects.js — project CRUD: create, read, list, archive,
 * kind, the files knowledge base, settings update, delete and the installed
 * version. Split out of stores/projectStore.js; built per store by
 * makeProjectStore.
 */

const crypto = require('crypto');
const { buildUpdate } = require('../lib/sqlBuilder');
const { parseJSONObject: parseJSON } = require('../lib/json');
const { PROJECT_KINDS, kindForNewProject, mapProjectRow } = require('./rows');

/**
 * @param {{
 *   run: (sql: string, params?: any[]) => Promise<any>,
 *   getOne: (sql: string, params?: any[]) => Promise<any>,
 *   getAll: (sql: string, params?: any[]) => Promise<any[]>,
 *   getClient: () => Promise<any>,
 *   initDB: () => Promise<unknown>,
 *   guard: () => { assertManagedWrite: Function },
 *   refuseStageBound: (projectId: string) => Promise<void>,
 * }} ctx  the store's db facade and schema init (built by makeProjectStore)
 */
function makeProjectFns({ run, getOne, getAll, initDB, guard, refuseStageBound }) {
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
        // The three provenance fields are written by the INSERT, not patched in
        // afterwards: they are a fact about how this project came to be, and a
        // second statement is a second thing that can fail and leave a Solution
        // that cannot say where it came from.
        const fromBlueprint = typeof installedFromBlueprintId === 'string' && installedFromBlueprintId
            ? installedFromBlueprintId : null;
        const fromOrg = typeof installedFromOrgId === 'string' && installedFromOrgId
            ? installedFromOrgId : null;
        // NULL stays NULL: "not recorded" is not version 1, and an install
        // without a number must never read as up to date.
        const atVersion = Number.isInteger(installedVersion) && installedVersion > 0 ? installedVersion : null;
        await run(
            `INSERT INTO projects (id, name, description, custom_instructions, knowledge_base_ids, color, icon, owner_id, organization_id, extract_memories, installed_from_blueprint_id, installed_from_org_id, installed_version, kind)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [id, name, description || '', customInstructions || '', kbIds, color || '#6366f1', icon || '📁', ownerId, organizationId || '', extractMemories || false, fromBlueprint, fromOrg, atVersion, projectKind]
        );
        return { id, name, description, customInstructions, knowledgeBaseIds: knowledgeBaseIds || [], color, icon, ownerId, organizationId, extractMemories: extractMemories || false, editorsCanInvite: true, archivedAt: null, archivedBy: null, installedFromBlueprintId: fromBlueprint, installedFromOrgId: fromOrg, installedVersion: atVersion, kind: projectKind, kindGuessed: false, filesKbId: null };
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
     * Solution stages (UAT/PRD rows, `stage_of` set) are left out of the
     * 'solution' listing: they show under their Solution, not as Solutions of
     * their own. `{ kind: 'solution', onlyStages: true }` lists just the stage
     * rows the user can reach (a stage operator who is no Dev member). With
     * `kind` omitted they stay in: a stage member must keep reading the apps
     * published to the stage (studioAppStore.userProjectIds).
     *
     * @param {string} userId
     * @param {string[]} groupIds - groups the user belongs to
     * @param {{ kind?: 'workspace'|'solution', onlyStages?: boolean, includeArchived?: boolean }} [opts]
     *        archived projects are left out unless `includeArchived`
     */
    async function listUserProjects(userId, groupIds = [], { kind, onlyStages = false, includeArchived = false } = {}) {
        await initDB();
        if (kind !== undefined && kind !== null && !PROJECT_KINDS.includes(kind)) {
            throw new TypeError(`listUserProjects: kind is 'workspace' or 'solution', not ${JSON.stringify(kind)}.`);
        }
        if (onlyStages && kind !== 'solution') {
            throw new TypeError(`listUserProjects: onlyStages goes with kind 'solution'.`);
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
        if (onlyStages) {
            kindFilter = 'AND p.stage_of IS NOT NULL';
        } else if (kind) {
            params.push(kind);
            kindFilter = `AND (p.kind = $${params.length} OR p.kind IS NULL)`;
            if (kind === 'solution') kindFilter += ' AND p.stage_of IS NULL';
        }

        if (!includeArchived) kindFilter += ' AND p.archived_at IS NULL';

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
     * Archive a project (`userId`) or restore it (`null`).
     *
     * Archiving an archived project keeps the first `archived_at`/`archived_by`
     * (idempotent). Neither `version` nor `updated_at` changes: an open settings
     * form must not turn into a spurious conflict, and the list order is by activity.
     *
     * @param {string} id
     * @param {string|null} userId who archives; null restores
     * @returns {Promise<object|null>} the project, or null when it does not exist
     */
    async function setArchived(id, userId) {
        await initDB();
        if (userId) {
            await run(
                `UPDATE projects SET archived_at = NOW(), archived_by = $2
                  WHERE id = $1 AND archived_at IS NULL`,
                [id, userId]
            );
        } else {
            await run(`UPDATE projects SET archived_at = NULL, archived_by = NULL WHERE id = $1`, [id]);
        }
        return await getProject(id);
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
        await refuseStageBound(id);
        const { rowCount } = await run(
            `UPDATE projects SET kind = $2, kind_guessed = FALSE, updated_at = NOW()
              WHERE id = $1 AND (kind IS NULL OR kind_guessed)`,
            [id, kind]
        );
        if (!rowCount) return null;
        return await getProject(id);
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

    const PROJECT_COLUMNS = {
        // A whole-array replace, so it is serialized rather than merged.
        knowledgeBaseIds: { col: 'knowledge_base_ids', transform: v => JSON.stringify(v) },
        name: 'name',
        description: 'description',
        customInstructions: 'custom_instructions',
        color: 'color',
        icon: 'icon',
        extractMemories: 'extract_memories',
        editorsCanInvite: 'editors_can_invite',
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
     * `stage` and `stage_of` are never written here (they are not in
     * PROJECT_COLUMNS): they are write-once. On a stage project a change to
     * `knowledgeBaseIds` is a change to a managed part and needs the deploy's
     * capability (`opts.managedWrite`), or it throws 409 managed_part.
     *
     * @param id
     * @param updates
     * @param {{ expectedVersion?: number, managedWrite?: { deploymentId?: string }|null }} [opts]
     */
    async function updateProject(id, updates, { expectedVersion, managedWrite = null } = {}) {
        await initDB();
        const existing = await getOne('SELECT id, owner_id, version, stage_of, knowledge_base_ids FROM projects WHERE id = $1', [id]);
        if (!existing) return null;

        if (existing.stage_of && updates && updates.knowledgeBaseIds !== undefined
            && JSON.stringify(parseJSON(existing.knowledge_base_ids, [])) !== JSON.stringify(updates.knowledgeBaseIds || [])) {
            await guard().assertManagedWrite({
                kind: 'project', projectId: id, changedKeys: ['knowledgeBaseIds'], managedWrite,
            });
        }

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

    /**
     * Record the version a Solution now runs (an install or an upgrade).
     * NULL stays "not recorded": a non-positive or non-integer version clears it.
     *
     * @param {string} projectId
     * @param {number|null} version
     * @returns {Promise<boolean>}
     */
    async function setInstalledVersion(projectId, version) {
        await initDB();
        const v = Number.isInteger(version) && version > 0 ? version : null;
        const { rowCount } = await run('UPDATE projects SET installed_version = $2 WHERE id = $1', [projectId, v]);
        return rowCount > 0;
    }

    return {
        createProject,
        getProject,
        listUserProjects,
        setProjectKind,
        setArchived,
        setInstalledVersion,
        setFilesKbId,
        updateProject,
        deleteProject,
    };
}

module.exports = { makeProjectFns };
