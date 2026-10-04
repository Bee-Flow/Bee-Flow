// @typecheck
// The `webpages` row aggregate: create, read (owner-scoped and raw), toggle
// publishing, patch metadata + file hashes, the persisted chat history,
// cloning a page to a new owner, and delete.

const crypto = require('crypto');
const { run, getOne, getAll } = require('../../db');
const storageStore = require('../storageStore');
const { initDB } = require('./schema');
const { buildUpdate } = require('../lib/sqlBuilder');
const { VERSIONED_SLOTS, keyFor, mapWebpageRow } = require('./shared');
const { thumbnailKey, purgeWebpageObjects } = require('./storage');
const { extraKey } = require('./extraFiles');
const { DEFAULT_BRIDGE_GRANTS, assertWebpageWrite } = require('./bridgeGrants');
const managedParts = require('../lib/managedParts');
const log = require('../../telemetry/log');

// ── Webpage CRUD ─────────────────────────────────────────────────────

async function createWebpage({ userId, name, description, instructions, knowledgeBaseIds, settings }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO webpages (id, user_id, name, description, instructions, knowledge_base_ids, settings)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, userId, name || 'Untitled Webpage', description || '', instructions || '',
         JSON.stringify(knowledgeBaseIds || []), JSON.stringify(settings || {})]
    );
    log.info(`[WebpageStore] Created webpage "${name}" for user ${userId}`);
    return {
        id, userId, name: name || 'Untitled Webpage', description: description || '',
        instructions: instructions || '', knowledgeBaseIds: knowledgeBaseIds || [],
        settings: settings || {},
        htmlSize: 0, cssSize: 0, jsSize: 0,
        createdAt: new Date().toISOString(),
    };
}

async function getWebpages(userId, { limit = 50, offset = 0 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT w.*,
                COALESCE(s.source_count, 0) AS source_count
         FROM webpages w
         LEFT JOIN (
             SELECT webpage_id, COUNT(*) AS source_count
             FROM webpage_sources GROUP BY webpage_id
         ) s ON s.webpage_id = w.id
         WHERE w.user_id = $1
         ORDER BY w.updated_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
    );
    return rows.map(mapWebpageRow);
}

async function getWebpage(id, userId) {
    await initDB();
    const r = await getOne(
        `SELECT w.*,
                COALESCE(s.source_count, 0) AS source_count
         FROM webpages w
         LEFT JOIN (
             SELECT webpage_id, COUNT(*) AS source_count
             FROM webpage_sources GROUP BY webpage_id
         ) s ON s.webpage_id = w.id
         WHERE w.id = $1 AND w.user_id = $2`,
        [id, userId]
    );
    if (!r) return null;
    return mapWebpageRow(r);
}

/**
 * Owner-agnostic lookup — used by the publish endpoint and visibility checks
 * where we need the row before we know if the caller is the owner. Callers
 * MUST gate access via canReadWebpage / owner check before returning to UI.
 */
async function getWebpageRaw(id) {
    await initDB();
    const r = await getOne(
        `SELECT w.*,
                COALESCE(s.source_count, 0) AS source_count
         FROM webpages w
         LEFT JOIN (
             SELECT webpage_id, COUNT(*) AS source_count
             FROM webpage_sources GROUP BY webpage_id
         ) s ON s.webpage_id = w.id
         WHERE w.id = $1`,
        [id]
    );
    return r ? mapWebpageRow(r) : null;
}

const PUBLISH_COLUMNS = {
    isPublished: 'is_published',
    sharedGroups: { col: 'shared_groups', transform: (v) => JSON.stringify(v || []) },
    organizationId: { col: 'organization_id', transform: (v) => v || null },
};

/**
 * Toggle published state + sharing scope. When sharedGroups is undefined,
 * preserve the existing DB value (same trap as agents had — see
 * setAgentPublished). organizationId is set on first publish so visibility
 * filters can match against the owner's org without a join.
 */
async function setWebpagePublished(id, isPublished, ownerId, sharedGroups = undefined, organizationId = undefined) {
    await initDB();
    const built = buildUpdate({
        table: 'webpages',
        // Coerced here, not in the column map: this column is ALWAYS written, so
        // it must never look "not supplied" to the builder.
        updates: { isPublished: !!isPublished, sharedGroups, organizationId },
        columnMap: PUBLISH_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }, { col: 'user_id', value: ownerId }],
    });
    const { rowCount } = await run(built.sql, built.params);
    return rowCount > 0;
}

/**
 * Pin (or unpin) the snapshot the audience reads — the W2 publish lifecycle.
 *
 * `versionId` null CLEARS the pointer: a page with no audience must not keep
 * a pointer claiming one. Owner-scoped like every other write here, and it
 * verifies the version really belongs to THIS webpage first — a pointer to
 * another page's version would serve that page's bytes to this page's
 * readers, which is the whole class of bug this column exists to prevent.
 *
 * On a managed page (a Solution stage) a NON-null pin is the deploy commit's:
 * it needs `managedWrite`, and passes `client` so the pointer moves inside
 * the commit transaction. Clearing it stays allowed.
 *
 * Returns true when the pointer was written.
 *
 * @param {string} id
 * @param {string} ownerId
 * @param {string|null} versionId
 * @param {{ client?: any, managedWrite?: { deploymentId?: string }|null }} [opts]
 */
async function setPublishedVersion(id, ownerId, versionId, { client = null, managedWrite = null } = {}) {
    await initDB();
    const write = async (sql, params) => (client ? client.query(sql, params) : run(sql, params));
    const readOne = async (sql, params) => (client ? (await client.query(sql, params)).rows[0] : getOne(sql, params));
    if (versionId) {
        await assertWebpageWrite(id, ['publishedVersionId'], { managedWrite, client });
        const v = await readOne(
            'SELECT id FROM webpage_versions WHERE id = $1 AND webpage_id = $2',
            [versionId, id]
        );
        if (!v) return false;
    }
    const { rowCount } = await write(
        'UPDATE webpages SET published_version_id = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
        [versionId || null, id, ownerId]
    );
    return rowCount > 0;
}

const METADATA_COLUMNS = {
    name: 'name',
    description: 'description',
    instructions: 'instructions',
    knowledgeBaseIds: { col: 'knowledge_base_ids', transform: v => JSON.stringify(v) },
    settings: { col: 'settings', transform: v => JSON.stringify(v) },
    htmlSha: 'html_sha256',
    cssSha: 'css_sha256',
    jsSha: 'js_sha256',
    htmlSize: 'html_size',
    cssSize: 'css_size',
    jsSize: 'js_size',
    dbSha: 'db_sha256',
    dbSize: 'db_size',
    icon: 'icon',
    accentColor: 'accent_color',
    tagline: 'tagline',
    thumbnailSha: 'thumbnail_sha256',
    thumbnailSize: 'thumbnail_size',
};

// What a metadata write may change on a managed page: the page's own
// data.db and its thumbnail (ALLOWED.webpage). Everything else (name,
// instructions, knowledge bases, settings, file hashes) comes from a deploy.
const MANAGED_FREE_METADATA = Object.freeze(['dbSha', 'dbSize', 'thumbnailSha', 'thumbnailSize']);

/**
 * The managed-part guard for a metadata write: compared against the stored
 * row, so a save that resends unchanged values (the editor sends every field)
 * is not refused for keys it does not change.
 */
async function guardMetadataWrite(id, updates, managedWrite) {
    const supplied = Object.fromEntries(Object.entries(updates || {})
        .filter(([k, v]) => v !== undefined && Object.prototype.hasOwnProperty.call(METADATA_COLUMNS, k)));
    if (Object.keys(supplied).every((k) => MANAGED_FREE_METADATA.includes(k))) return;
    const row = await getOne('SELECT * FROM webpages WHERE id = $1', [id]);
    if (!row || !row.project_id) return;
    const changed = managedParts.changedKeysOf(row, supplied, METADATA_COLUMNS);
    await assertWebpageWrite(id, changed, { managedWrite, projectId: row.project_id });
}

/**
 * @param {string} id
 * @param {string} userId
 * @param {Record<string, any>} updates
 * @param {{ managedWrite?: { deploymentId?: string }|null }} [opts]
 */
async function updateWebpageMetadata(id, userId, updates, { managedWrite = null } = {}) {
    await initDB();
    await guardMetadataWrite(id, updates, managedWrite);
    const built = buildUpdate({
        table: 'webpages',
        updates,
        columnMap: METADATA_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }, { col: 'user_id', value: userId }],
    });
    if (!built) return false;
    const { rowCount } = await run(built.sql, built.params);
    return rowCount > 0;
}

/**
 * Read the persisted chat history for a webpage. Returns [] when the column
 * is empty, missing, or unparseable. Stored as JSONB so the array is the
 * canonical type — no JSON.parse failures from invalid strings.
 */
async function getChatMessages(id, userId) {
    await initDB();
    const r = await getOne('SELECT chat_messages FROM webpages WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!r) return [];
    const raw = r.chat_messages;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') { try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
    return [];
}

/**
 * Replace the chat history for a webpage. The frontend is the source of
 * truth — it sends the full array on every save, so this is an idempotent
 * overwrite (no merge logic needed). Validates the shape and trims to a
 * reasonable size to keep the row lean.
 */
async function setChatMessages(id, userId, messages, { managedWrite = null } = {}) {
    await initDB();
    // The AI builder's conversation edits a managed page's content: refused there.
    await assertWebpageWrite(id, ['chatMessages'], { managedWrite });
    const safe = Array.isArray(messages) ? messages : [];
    // Cap at the most recent 200 messages to prevent unbounded row growth.
    const trimmed = safe.slice(-200);
    const { rowCount } = await run(
        'UPDATE webpages SET chat_messages = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
        [JSON.stringify(trimmed), id, userId]
    );
    return rowCount > 0;
}

/**
 * Clone a webpage. The new row is owned by `newOwnerId`; the source row
 * stays untouched. Copies all four RustFS slots (html/css/js/db), the
 * thumbnail, and every extra file from the source owner's prefix into
 * the new owner's prefix — but resets the publishing scope
 * (is_published=false, shared_groups=[], organization_id=null) and skips
 * chat history, version history, sources, and public share links.
 *
 * Callers MUST gate visibility before invoking (canReadWebpage). This
 * function does not check whether the cloner is allowed to see the source
 * — it trusts the route to have done that.
 *
 * RustFS copies run server-side via `copyObject`, so even large `data.db`
 * blobs never round-trip through Node. Callers should flush any in-memory
 * SQLite handle for the source webpage first (see webpageDbStore.flush)
 * to ensure the on-disk blob is up-to-date before the copy.
 */
async function cloneWebpage({ sourceId, newOwnerId, newName }) {
    await initDB();
    // Look up source by id only — visibility is the caller's responsibility.
    const src = await getOne('SELECT * FROM webpages WHERE id = $1', [sourceId]);
    if (!src) return null;
    const sourceOwnerId = src.user_id;

    const newId = crypto.randomUUID();
    const name = (typeof newName === 'string' && newName.trim()) ? newName.trim() : `Copy of ${src.name}`;
    const kbIds = typeof src.knowledge_base_ids === 'string'
        ? src.knowledge_base_ids
        : JSON.stringify(src.knowledge_base_ids || []);
    const settings = typeof src.settings === 'string'
        ? src.settings
        : JSON.stringify(src.settings || {});
    const grants = typeof src.bridge_grants === 'string'
        ? src.bridge_grants
        : JSON.stringify(src.bridge_grants || DEFAULT_BRIDGE_GRANTS);

    // Insert mirrors the source row except for the three publishing fields
    // (defaulted to private), chat_messages (defaulted to []), timestamps,
    // and the FK-linked sources/versions/public-shares (intentionally skipped).
    // `published_version_id` is deliberately NOT in this list: a clone is
    // unpublished, and the source's versions are not copied, so a pointer
    // carried across would aim at a version this new page does not own.
    await run(
        `INSERT INTO webpages (
            id, user_id, name, description, instructions,
            knowledge_base_ids, settings,
            html_sha256, css_sha256, js_sha256, db_sha256,
            html_size, css_size, js_size, db_size,
            icon, accent_color, tagline, thumbnail_sha256, thumbnail_size,
            bridge_grants
         ) VALUES (
            $1, $2, $3, $4, $5,
            $6::jsonb, $7::jsonb,
            $8, $9, $10, $11,
            $12, $13, $14, $15,
            $16, $17, $18, $19, $20,
            $21::jsonb
         )`,
        [
            newId, newOwnerId, name, src.description || '', src.instructions || '',
            kbIds, settings,
            src.html_sha256 || '', src.css_sha256 || '', src.js_sha256 || '', src.db_sha256 || '',
            parseInt(src.html_size) || 0, parseInt(src.css_size) || 0,
            parseInt(src.js_size) || 0, parseInt(src.db_size) || 0,
            src.icon || '', src.accent_color || '', src.tagline || '',
            src.thumbnail_sha256 || '', parseInt(src.thumbnail_size) || 0,
            grants,
        ]
    );

    const ignoreMissing = (err) => {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return;
        throw err;
    };

    if (storageStore.isAvailable()) {
        // Slot blobs — read from the SOURCE owner's prefix, write to the NEW
        // owner's prefix. NoSuchKey is fine: an empty slot (no object) just
        // means there's nothing to copy.
        for (const slot of VERSIONED_SLOTS) {
            try { await storageStore.copyObject(keyFor(sourceOwnerId, sourceId, slot), keyFor(newOwnerId, newId, slot)); }
            catch (err) { try { ignoreMissing(err); } catch (e) { log.warn(`[WebpageStore] Clone slot ${slot} failed:`, e.message); } }
        }
        // Thumbnail — only attempt when the source row records one.
        if (src.thumbnail_sha256) {
            try { await storageStore.copyObject(thumbnailKey(sourceOwnerId, sourceId), thumbnailKey(newOwnerId, newId)); }
            catch (err) { try { ignoreMissing(err); } catch (e) { log.warn(`[WebpageStore] Clone thumbnail failed:`, e.message); } }
        }
    }

    // Extra files — duplicate every row + corresponding RustFS blob.
    const extras = await getAll('SELECT * FROM webpage_extra_files WHERE webpage_id = $1', [sourceId]);
    for (const f of extras) {
        const extraId = crypto.randomUUID();
        await run(
            `INSERT INTO webpage_extra_files (id, webpage_id, path, mime_type, is_text, sha256, size)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [extraId, newId, f.path, f.mime_type, f.is_text, f.sha256, f.size]
        );
        if (storageStore.isAvailable()) {
            try { await storageStore.copyObject(extraKey(sourceOwnerId, sourceId, f.path), extraKey(newOwnerId, newId, f.path)); }
            catch (err) { try { ignoreMissing(err); } catch (e) { log.warn(`[WebpageStore] Clone extra ${f.path} failed:`, e.message); } }
        }
    }

    log.info(`[WebpageStore] Cloned ${sourceId} (owner ${sourceOwnerId}) → ${newId} (owner ${newOwnerId}) ("${name}")`);
    return mapWebpageRow({ ...src, id: newId, user_id: newOwnerId, name, is_published: false, shared_groups: '[]', organization_id: null, published_version_id: null, chat_messages: [], source_count: 0, created_at: new Date(), updated_at: new Date() });
}

async function deleteWebpage(id, userId, { managedWrite = null } = {}) {
    await initDB();
    const r = await getOne('SELECT * FROM webpages WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!r) return null;
    // A managed page is retired by a deploy (unpublished), never deleted.
    await assertWebpageWrite(id, ['delete'], { managedWrite, projectId: r.project_id || null });
    // Sources cascade-delete via FK.  Versions too.
    await run('DELETE FROM webpages WHERE id = $1 AND user_id = $2', [id, userId]);
    // Purge RustFS objects (best-effort, non-blocking on failure)
    purgeWebpageObjects(userId, id).catch(err =>
        log.warn(`[WebpageStore] Purge failed for ${id}:`, err.message));
    return mapWebpageRow(r);
}

module.exports = {
    createWebpage,
    getWebpages,
    getWebpage,
    getWebpageRaw,
    setWebpagePublished,
    setPublishedVersion,
    updateWebpageMetadata,
    getChatMessages,
    setChatMessages,
    cloneWebpage,
    deleteWebpage,
};
