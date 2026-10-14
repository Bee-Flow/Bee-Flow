// @typecheck
/**
 * stores/studioApp/apps.js — app CRUD: create, the owner and visibility
 * listings, card metadata, template provenance and the definition CAS save.
 */

const crypto = require('crypto');
const { dep } = require('./deps');
const { emptyDefinition } = require('../../appStudio/componentSpecs');
const { parseJSONObject: parseJSON } = require('../lib/json');
const { buildUpdate } = require('../lib/sqlBuilder');
const { changedKeysOf } = require('../lib/managedParts');
const { initDB } = require('./schema');
const { guardOf, inTx, serializeDefinition } = require('./shared');
const { META_COLS, mapAppMetaRow, mapAppRow } = require('./rowMappers');

const { run, getOne, getAll } = dep('db');
const log = dep('log');

// ── App CRUD ────────────────────────────────────────────────────────

/**
 * @param {{ userId?: string, organizationId?: string, name?: string, description?: string, icon?: string, accentColor?: string, definition?: any, templateId?: string, templateVersion?: string, templateInstallHash?: string }} [opts]
 */
async function createStudioApp({ userId, organizationId, name, description, icon, accentColor, definition,
    templateId, templateVersion, templateInstallHash } = {}) {
    await initDB();
    if (!userId) throw new Error('userId required');
    // No definition supplied → start from the canonical empty app.
    const payload = serializeDefinition(definition || emptyDefinition(name || 'Untitled app'));
    const id = crypto.randomUUID();
    // Stamp the engine this server actually runs. The column DEFAULT is
    // 'sqlite' because it was added for apps that predate the Postgres engine —
    // but a NEW app on a pg replica must be born marked 'pg', or the engine's
    // interlock (pgAppEngine.assertOwnership) refuses to serve it and every
    // fresh app answers engine_mismatch. The migrator only ever flips existing
    // rows; nothing else would ever set this one.
    const engine = dep('engineFlag')().getDialect() === 'pg' ? 'pg' : 'sqlite';
    const row = await getOne(
        `INSERT INTO studio_apps (id, user_id, organization_id, name, description, icon, accent_color, definition, engine,
                                  template_id, template_version, template_install_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
         RETURNING *`,
        [id, userId, organizationId || null, name || 'Untitled app', description || '',
         icon || null, accentColor || null, payload, engine,
         // Template provenance: only the create-from-template route passes
         // these (with the install hash computed over the exact `definition`
         // it saves). Blank apps stay NULL/NULL/NULL.
         templateId || null,
         Number.isInteger(templateVersion) ? templateVersion : null,
         templateInstallHash || null]
    );
    log.info(`[StudioAppStore] Created app "${row.name}" for user ${userId}`);
    return mapAppRow(row);
}

/**
 * Owner-agnostic lookup — used by publish/visibility checks where we need the
 * row before we know if the caller is the owner. Callers MUST gate access via
 * canReadStudioApp / canWriteStudioApp before returning it to the UI (same
 * contract as webpageStore.getWebpageRaw).
 */
async function getStudioApp(id) {
    await initDB();
    const r = await getOne(`SELECT * FROM studio_apps WHERE id = $1`, [id]);
    return r ? mapAppRow(r) : null;
}

/** Apps the user owns — meta only (no definition payloads). */
async function getStudioAppsByUser(userId) {
    await initDB();
    const rows = await getAll(
        `SELECT ${META_COLS} FROM studio_apps WHERE user_id = $1 ORDER BY updated_at DESC`,
        [userId]
    );
    return rows.map(mapAppMetaRow);
}

/**
 * Project (Solution) ids the user holds any role on.
 *
 * Never throws: a failed lookup degrades to "no projects", which is exactly
 * the behaviour this store had before Solutions widened anything. The safe
 * default is to deny, and a hiccup here must not take the whole app list down.
 */
async function userProjectIds(userId, userGroupIds = []) {
    if (!userId) return [];
    try {
        const projectStore = dep('projectStore')();
        const rows = await projectStore.listUserProjects(userId, Array.isArray(userGroupIds) ? userGroupIds : []);
        return (Array.isArray(rows) ? rows : [])
            .map(p => (p && typeof p.id === 'string') ? p.id : null)
            .filter(Boolean);
    } catch (err) {
        log.error('[StudioAppStore] project membership lookup failed:', err.message);
        return [];
    }
}

/**
 * Apps the user can see: ones they own, ones published into their org/groups,
 * and ones published into a Studio Project they are a member of. Meta only.
 *
 * The first two mirror getAccessibleWebpages' predicate: shared_groups is
 * filtered in JS (empty array = whole org) to keep the SQL portable and
 * parsing consistent.
 *
 * ── The project widening, and its one limit ─────────────────────────
 * Project membership is an AUDIENCE, the same kind of thing as an org or a
 * group — it answers WHO, never WHETHER THERE IS ANYTHING TO SHOW. So an
 * unpublished app filed into a project stays invisible here even to its
 * project's members: there is no frozen published_definition to serve them,
 * the runtime route refuses it before it ever asks this predicate, and a tile
 * that 404s on click is worse than no tile. The owner's live draft is never
 * served to anyone else, project or not.
 *
 * That is narrower than the sentence studio_apps.project_id carried since the
 * column was added ("regardless of is_published/shared_groups"); the comment
 * has been corrected rather than the rule widened.
 */
async function getAccessibleStudioApps(userId, userGroupIds = [], userOrgIds = []) {
    await initDB();
    const orgIds = Array.isArray(userOrgIds) ? userOrgIds : [...(userOrgIds || [])];
    const groupIds = Array.isArray(userGroupIds) ? userGroupIds : [];
    const rows = await getAll(
        `SELECT ${META_COLS} FROM studio_apps
         WHERE user_id = $1
            OR (is_published = TRUE AND organization_id IS NOT NULL AND organization_id = ANY($2::text[]))
         ORDER BY updated_at DESC`,
        [userId, orgIds]
    );
    const visible = rows
        .map(mapAppMetaRow)
        .filter(a => {
            if (a.userId === userId) return true;
            if (!a.isPublished) return false;
            const groups = Array.isArray(a.sharedGroups) ? a.sharedGroups : [];
            if (groups.length === 0) return true; // entire-org publish
            return groups.some(g => groupIds.includes(g));
        });

    if (!userId) return visible;
    // Cheap guard before the membership lookup: on an install where no app is
    // filed into a project at all there is nothing to widen, and this costs one
    // index probe (idx_studio_apps_project is partial on exactly this predicate)
    // instead of a project query per app list.
    const anyFiled = await getOne(`SELECT 1 FROM studio_apps WHERE project_id IS NOT NULL LIMIT 1`);
    if (!anyFiled) return visible;
    const projectIds = await userProjectIds(userId, groupIds);
    if (projectIds.length === 0) return visible;

    const projectRows = await getAll(
        `SELECT ${META_COLS} FROM studio_apps
         WHERE project_id = ANY($1::text[]) AND is_published = TRUE
         ORDER BY updated_at DESC`,
        [projectIds]
    );
    const seen = new Set(visible.map(a => a.id));
    for (const r of projectRows) {
        const a = mapAppMetaRow(r);
        if (seen.has(a.id)) continue;   // owned or already published to me
        seen.add(a.id);
        visible.push(a);
    }
    // One list, one order. The two queries each come back newest-first; the
    // merge has to restore that across them.
    return visible.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

const APP_CARD_COLUMNS = {
    name: 'name',
    description: 'description',
    icon: 'icon',
    accentColor: 'accent_color',
    // Empty string collapses to NULL: "" and NULL would otherwise be two
    // different ways of saying uncategorised, and the filter pills would have
    // to know about both.
    category: { col: 'category', transform: (v) => v || null },
};

/**
 * Update card metadata. Whitelisted columns only — the definition goes
 * through saveDefinition (CAS) and publish state through setStudioAppPublished.
 * Owner-scoped in the WHERE (IDOR-safe). Returns the updated row, or null
 * when the app doesn't exist or isn't owned by ownerId.
 */
async function updateStudioApp(io, id, updates = {}, ownerId, { managedWrite = null } = {}) {
    await io.ready();
    const built = buildUpdate({
        table: 'studio_apps',
        updates,
        columnMap: APP_CARD_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }, { col: 'user_id', value: ownerId }],
        returning: '*',
    });
    if (!built) {
        const cur = await io.db.getOne(`SELECT * FROM studio_apps WHERE id = $1 AND user_id = $2`, [id, ownerId]);
        return cur ? mapAppRow(cur) : null;
    }
    // The row is locked while the guard decides, so no filing into a stage or
    // deploy lands between the check and the write.
    const row = await inTx(io, async (client) => {
        const cur = (await client.query(
            `SELECT * FROM studio_apps WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, ownerId],
        )).rows[0];
        if (!cur) return null;
        // Only what actually changes counts against the lock: a client that
        // re-sends the stored name is not editing a managed app.
        await guardOf(io).assertManagedWrite({
            kind: 'app', projectId: cur.project_id ?? null, managedWrite, client,
            changedKeys: changedKeysOf(cur, updates, APP_CARD_COLUMNS),
        });
        return (await client.query(built.sql, built.params)).rows[0] || null;
    });
    return row ? mapAppRow(row) : null;
}

/**
 * Re-stamp the template provenance after a successful template upgrade: the
 * version the app now runs and the install hash of the definition as just
 * re-installed (canonical key-sorted JSON, computed by the caller over the
 * exact object it saved). Owner-scoped in the WHERE. templateId itself never
 * changes after create — an upgrade stays within the same template.
 * @param id
 * @param ownerId
 * @param {{ templateVersion?: string, templateInstallHash?: string }} [opts]
 */
async function setTemplateStamp(id, ownerId, { templateVersion, templateInstallHash } = {}) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE studio_apps SET template_version = $1, template_install_hash = $2, updated_at = NOW()
         WHERE id = $3 AND user_id = $4`,
        [Number.isInteger(templateVersion) ? templateVersion : null, templateInstallHash || null, id, ownerId]
    );
    return rowCount > 0;
}

/**
 * Stamp the FULL template provenance, template_id included.
 *
 * setTemplateStamp above deliberately leaves template_id alone: an upgrade
 * stays within the same template, and letting it drift would silently re-point
 * an app at a different one. This is the other case — an app created BLANK and
 * then given a template by the builder's app_apply_template, which is how a
 * template is installed over MCP. Without it that app carries no provenance and
 * is never offered the template's later versions.
 *
 * Refuses to overwrite an existing stamp (`template_id IS NULL` in the WHERE):
 * an app already born from a template must go through the upgrade path.
 * @param id
 * @param ownerId
 * @param {{ templateId?: string, templateVersion?: string, templateInstallHash?: string }} [opts]
 */
async function setTemplateProvenance(id, ownerId, { templateId, templateVersion, templateInstallHash } = {}) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE studio_apps
            SET template_id = $1, template_version = $2, template_install_hash = $3, updated_at = NOW()
          WHERE id = $4 AND user_id = $5 AND template_id IS NULL`,
        [templateId || null, Number.isInteger(templateVersion) ? templateVersion : null,
            templateInstallHash || null, id, ownerId]
    );
    return rowCount > 0;
}

/**
 * Persist the working definition with optimistic concurrency.
 *
 * Ownership is enforced inside the locking SELECT. When `expectedVersion` is
 * provided and doesn't match the persisted definition_version, no write
 * happens and the caller gets the server's copy back to reconcile against:
 *   { ok:false, conflict:true, currentVersion, definition }
 * On success: { ok:true, version } (the new definition_version).
 * Oversize definitions throw with .code='definition_too_large'.
 */
async function saveDefinition(io, id, ownerId, definition, { expectedVersion = null, managedWrite = null } = {}) {
    await io.ready();
    const payload = serializeDefinition(definition);
    const client = await io.db.getClient();
    try {
        await client.query('BEGIN');
        const cur = await client.query(
            `SELECT definition, definition_version, project_id FROM studio_apps WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [id, ownerId]
        );
        if (cur.rows.length === 0) {
            await client.query('ROLLBACK');
            return { ok: false, notFound: true };
        }
        await guardOf(io).assertManagedWrite({
            kind: 'app', projectId: cur.rows[0].project_id ?? null, changedKeys: ['definition'], managedWrite, client,
        });
        const currentVersion = parseInt(cur.rows[0].definition_version) || 1;
        if (expectedVersion != null && currentVersion !== expectedVersion) {
            await client.query('ROLLBACK');
            return { ok: false, conflict: true, currentVersion, definition: parseJSON(cur.rows[0].definition, {}) };
        }
        const nextVersion = currentVersion + 1;
        await client.query(
            `UPDATE studio_apps SET definition = $1::jsonb, definition_version = $2, updated_at = NOW()
             WHERE id = $3 AND user_id = $4`,
            [payload, nextVersion, id, ownerId]
        );
        await client.query('COMMIT');
        return { ok: true, version: nextVersion };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

module.exports = {
    createStudioApp,
    getStudioApp,
    getStudioAppsByUser,
    getAccessibleStudioApps,
    updateStudioApp,
    setTemplateStamp,
    setTemplateProvenance,
    saveDefinition,
};
