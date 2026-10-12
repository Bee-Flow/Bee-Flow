// @typecheck
/**
 * Studio App Store — PostgreSQL persistence for App Studio apps.
 *
 * An app is a structured JSON component tree (never code) whose schema is
 * owned by ../appStudio/componentSpecs.js — this store treats the definition
 * as an opaque JSONB blob and only enforces the byte ceiling
 * (LIMITS.MAX_DEFINITION_BYTES). Validation/canonicalization happen in the
 * appStudio layer before anything reaches saveDefinition.
 *
 * Two tables:
 *   • studio_apps          — one row per app: working definition (+ optimistic
 *                            definition_version), the frozen published_definition
 *                            served to viewers, publish/share scope, and the AI
 *                            builder-session snapshot.
 *   • studio_app_versions  — immutable definition snapshots taken at publish
 *                            time (newest 20 kept per app).
 *
 * Publishing follows the same 3-mode model as agents/KBs/webpages:
 * Personal (is_published=false), Entire Org (is_published=true,
 * shared_groups=[]), Specific Groups (is_published=true, shared_groups=[...]).
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec, getClient } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const { LIMITS, emptyDefinition } = require('../appStudio/componentSpecs');
const log = require('../telemetry/log');
const { parseJSONObject: parseJSON } = require('./lib/json');
const { buildUpdate } = require('./lib/sqlBuilder');
const { changedKeysOf } = require('./lib/managedParts');

// Publish snapshots kept per app (oldest pruned beyond this).
const MAX_VERSIONS_PER_APP = 20;

const initDB = makeStoreInit('StudioAppStore', _initDB);

/**
 * The managed-write guard (stores/lib/managedParts.js): an app filed into a
 * Solution stage project is changed in Dev and deployed. `io.managedParts` is
 * a test's own instance; the app uses the module's default, required lazily
 * because it reaches projectStore.
 */
function guardOf(io) {
    return io.managedParts || require('./lib/managedParts');
}

/** Run `fn` on one client of `io.db` inside BEGIN/COMMIT (ROLLBACK on a throw). */
async function inTx(io, fn) {
    const client = await io.db.getClient();
    try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

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
    // applied as an idempotent ALTER. Via runDdl (stores/lib/_ddl.js): een
    // falend statement komt luid in de failures-lijst en de rest draait door —
    // de oude catch (_) las ook een timeout als "column already exists".
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
        try { await require(`../migrations/${name}`).up(); } catch (e) {
            log.error(`[StudioAppStore] migration ${name} FAILED: ${e.message}`);
        }
    }
    log.info('[StudioAppStore] PostgreSQL initialized');
}

// ── Helpers ─────────────────────────────────────────────────────────


/**
 * Serialize a definition for storage, enforcing the byte ceiling from
 * componentSpecs. Throws with .code='definition_too_large' when exceeded so
 * routes can map it to a 413 instead of a generic 500.
 */
function serializeDefinition(definition) {
    const payload = JSON.stringify(definition ?? {});
    if (Buffer.byteLength(payload, 'utf8') > LIMITS.MAX_DEFINITION_BYTES) {
        const err = new Error(`App definition exceeds ${LIMITS.MAX_DEFINITION_BYTES} bytes`);
        err.code = 'definition_too_large';
        throw err;
    }
    return payload;
}

// Columns safe for list rendering — never the heavy payloads (definition /
// published_definition) nor the owner-private builder_session.
const META_COLS = `id, user_id, organization_id, project_id, name, description, icon, accent_color, category,
    definition_version, published_version, is_published, shared_groups, nextcloud_menu, published_at, created_at, updated_at,
    template_id, template_version, template_install_hash`;

// ── Row mappers ─────────────────────────────────────────────────────

function mapAppMetaRow(r) {
    return {
        id: r.id,
        userId: r.user_id,
        organizationId: r.organization_id || null,
        // null = standalone; set = belongs to a Studio Project, whose members
        // are an AUDIENCE for it on top of org/group publishing — see
        // canReadStudioAppAsync for what that does and does not widen.
        projectId: r.project_id || null,
        name: r.name,
        description: r.description || '',
        icon: r.icon || null,
        accentColor: r.accent_color || null,
        // Directory category from the org's closed list; null = uncategorised.
        category: r.category || null,
        definitionVersion: parseInt(r.definition_version) || 1,
        // The definition_version that is actually live. null = never published,
        // or published before the column existed — callers must treat it as
        // "unknown", never as "in step with the draft".
        publishedVersion: r.published_version != null ? (parseInt(r.published_version) || null) : null,
        isPublished: r.is_published === true || r.is_published === 't',
        sharedGroups: parseJSON(r.shared_groups, []),
        // Template provenance — all three null on blank apps (and on apps
        // created before the columns existed). templateVersion is normalized
        // to an integer or null; consumers treat null as "unknown", never 0.
        templateId: r.template_id || null,
        templateVersion: r.template_version != null ? (parseInt(r.template_version) || null) : null,
        templateInstallHash: r.template_install_hash || null,
        nextcloudMenu: r.nextcloud_menu === true || r.nextcloud_menu === 't',
        publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

// Full row: meta + the definition payloads. builder_session deliberately has
// its own accessor (getBuilderSession) and never rides along on app rows.
function mapAppRow(r) {
    return {
        ...mapAppMetaRow(r),
        definition: parseJSON(r.definition, {}),
        publishedDefinition: r.published_definition != null ? parseJSON(r.published_definition, null) : null,
    };
}

function mapVersionMetaRow(r) {
    return {
        id: r.id,
        appId: r.app_id,
        summary: r.summary || '',
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

function mapVersionRow(r) {
    return {
        ...mapVersionMetaRow(r),
        userId: r.user_id,
        definition: parseJSON(r.definition, {}),
    };
}

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
    const engine = require('../utils/engineFlag').getDialect() === 'pg' ? 'pg' : 'sqlite';
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
        const projectStore = require('./projectStore');
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

/**
 * Toggle published state + sharing scope. When sharedGroups is undefined,
 * preserve the existing DB value (same trap as agents had — see
 * setAgentPublished). organizationId is set on first publish so visibility
 * filters can match against the owner's org without a join.
 *
 * On publish the working definition is frozen: copied into
 * published_definition (viewers keep seeing this while the owner keeps
 * editing), published_at is stamped, published_version records WHICH
 * definition_version went live, and an immutable snapshot row is written to
 * studio_app_versions (pruned to the newest MAX_VERSIONS_PER_APP).
 * Unpublish only flips is_published — the frozen copy, its version and the
 * history stay.
 */
/**
 * @param {object} [publishedDefinition] The already-canonicalized+validated
 *   definition to freeze. Passing it closes a TOCTOU: the route validates a
 *   snapshot read without a lock, so freezing `published_definition = definition`
 *   could otherwise publish a concurrently-saved, unvalidated draft. When
 *   provided, THIS exact def becomes both published_definition and the version
 *   snapshot. Omit to fall back to the (locked) current draft.
 * @param {number} [publishedVersion] The definition_version `publishedDefinition`
 *   was read at. Pass it WITH publishedDefinition: the locked row may already
 *   have moved past that snapshot, and published_version must name the version
 *   whose bytes actually went live, not the one that happened to win the race.
 */
const APP_PUBLISH_COLUMNS = {
    isPublished: 'is_published',
    sharedGroups: { col: 'shared_groups', cast: 'jsonb', transform: v => JSON.stringify(v || []) },
    organizationId: { col: 'organization_id', transform: v => v || null },
    publishedDefinition: { col: 'published_definition', cast: 'jsonb' },
    publishedVersion: 'published_version',
    accentColor: 'accent_color',
};

/** theme.primary out of a definition (object or JSON string); null if absent. */
function readThemePrimary(definition) {
    try {
        const def = typeof definition === 'string' ? JSON.parse(definition) : definition;
        const primary = def && def.theme && def.theme.primary;
        return (typeof primary === 'string' && /^#[0-9a-fA-F]{6}$/.test(primary)) ? primary : null;
    } catch (_) {
        return null;
    }
}

async function setStudioAppPublished(io, id, isPublished, ownerId, sharedGroups = undefined, organizationId = undefined, publishedDefinition = undefined, publishedVersion = undefined) {
    await io.ready();
    const client = await io.db.getClient();
    try {
        await client.query('BEGIN');
        const cur = await client.query(
            `SELECT definition, definition_version, project_id FROM studio_apps WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [id, ownerId]
        );
        if (cur.rows.length === 0) {
            await client.query('ROLLBACK');
            return false;
        }
        // ALWAYS refused on an app of a Solution stage, capability or not: a
        // publish here re-freezes the WORKING definition. The audience goes
        // through setStudioAppAudience, the published copy through a deploy's
        // publishDefinitionWith.
        await guardOf(io).assertManagedWrite({
            kind: 'app', projectId: cur.rows[0].project_id ?? null,
            changedKeys: ['isPublished', 'publishedDefinition'], managedWrite: null, client,
        });

        // The exact bytes that were validated (when supplied) become the frozen
        // published copy — never a racing concurrent draft.
        const frozenPayload = publishedDefinition !== undefined
            ? JSON.stringify(publishedDefinition ?? {})
            : (typeof cur.rows[0].definition === 'string'
                ? cur.rows[0].definition
                : JSON.stringify(cur.rows[0].definition ?? {}));
        const frozenVersion = Number.isInteger(publishedVersion)
            ? publishedVersion
            : (parseInt(cur.rows[0].definition_version) || 1);
        const write = { isPublished: !!isPublished, sharedGroups, organizationId };
        if (isPublished) {
            write.publishedDefinition = frozenPayload;
            write.publishedVersion = frozenVersion;
            // Two accent truths used to drift apart: the app gallery tiles read
            // studio_apps.accent_color while the running app uses
            // definition.theme.primary. Publishing is exactly the moment they
            // must agree — the tile then advertises the app people will see.
            const frozenPrimary = readThemePrimary(frozenPayload);
            if (frozenPrimary) write.accentColor = frozenPrimary;
        }
        // `isPublished` is always mapped, so the stamps below always fire —
        // exactly as when they were literals in the SET clause.
        const built = buildUpdate({
            table: 'studio_apps',
            updates: write,
            columnMap: APP_PUBLISH_COLUMNS,
            extraSet: isPublished ? ['updated_at = NOW()', 'published_at = NOW()'] : ['updated_at = NOW()'],
            where: [{ col: 'id', value: id }, { col: 'user_id', value: ownerId }],
        });
        await client.query(built.sql, built.params);

        if (isPublished) {
            // Same transaction as the freeze (atomic) — pass the client so the
            // snapshot never commits independently of published_definition.
            await createVersionSnapshot(id, ownerId, frozenPayload, 'Published', { client });
        }
        await client.query('COMMIT');
        return true;
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

/** The audience columns setStudioAppAudience writes; nothing else. */
const APP_AUDIENCE_COLUMNS = {
    isPublished: APP_PUBLISH_COLUMNS.isPublished,
    sharedGroups: APP_PUBLISH_COLUMNS.sharedGroups,
    organizationId: APP_PUBLISH_COLUMNS.organizationId,
};

/**
 * Who an app reaches: `is_published`, `shared_groups` and `organization_id`
 * only, plus the publish stamps (`published_at` on a publish). It never
 * touches `published_definition` or `published_version`: on an app of a
 * Solution stage those belong to the deploy (publishDefinitionWith), and the
 * audience is the stage's own setting, allowed without a deploy (design 4.3).
 * `sharedGroups` / `organizationId` left undefined keep the stored value.
 * Owner-scoped in the WHERE; false when the app is not the owner's.
 *
 * @param {any} io  the writers' context (makeStudioAppWriters)
 * @param {string} id
 * @param {string} ownerId
 * @param {{ isPublished?: boolean, sharedGroups?: string[], organizationId?: string|null,
 *           managedWrite?: { deploymentId?: string }|null }} [audience]
 */
async function setStudioAppAudience(io, id, ownerId, { isPublished, sharedGroups, organizationId, managedWrite = null } = {}) {
    await io.ready();
    const client = await io.db.getClient();
    try {
        await client.query('BEGIN');
        const cur = await client.query(
            `SELECT project_id FROM studio_apps WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [id, ownerId]
        );
        if (cur.rows.length === 0) {
            await client.query('ROLLBACK');
            return false;
        }
        const write = { isPublished: !!isPublished, sharedGroups, organizationId };
        await guardOf(io).assertManagedWrite({
            kind: 'app', projectId: cur.rows[0].project_id ?? null, managedWrite, client,
            changedKeys: Object.keys(write).filter((k) => write[k] !== undefined),
        });
        const built = buildUpdate({
            table: 'studio_apps',
            updates: write,
            columnMap: APP_AUDIENCE_COLUMNS,
            extraSet: write.isPublished ? ['updated_at = NOW()', 'published_at = NOW()'] : ['updated_at = NOW()'],
            where: [{ col: 'id', value: id }, { col: 'user_id', value: ownerId }],
        });
        await client.query(built.sql, built.params);
        await client.query('COMMIT');
        return true;
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

/**
 * A deploy's commit flip for an app: `definition` (the bound release copy,
 * already canonical and validated by the deploy) becomes the frozen
 * `published_definition` at `version`, on the commit transaction's `client`
 * (no BEGIN here; the caller owns the transaction). `is_published` and
 * `shared_groups` are untouched: whether the app is published is the stage's
 * setting, which a deploy never changes. The tile accent follows the
 * published theme, as on a publish.
 *
 * On an app of a Solution stage it needs the deploy's `managedWrite`.
 * Answers true, or false when there is no such app.
 *
 * @param {any} io  the writers' context (makeStudioAppWriters)
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} client
 * @param {string} id
 * @param {object} definition
 * @param {number} version  the definition_version the release copy was written at
 * @param {{ managedWrite?: { deploymentId?: string }|null }} [opts]
 */
async function publishDefinitionWith(io, client, id, definition, version, { managedWrite = null } = {}) {
    const payload = serializeDefinition(definition);
    const cur = await client.query(`SELECT project_id FROM studio_apps WHERE id = $1 FOR UPDATE`, [id]);
    if (cur.rows.length === 0) return false;
    await guardOf(io).assertManagedWrite({
        kind: 'app', projectId: cur.rows[0].project_id ?? null,
        changedKeys: ['publishedDefinition', 'publishedVersion'], managedWrite, client,
    });
    const write = { publishedDefinition: payload, publishedVersion: Number.isInteger(version) ? version : null };
    const primary = readThemePrimary(payload);
    if (primary) write.accentColor = primary;
    const built = buildUpdate({
        table: 'studio_apps',
        updates: write,
        columnMap: APP_PUBLISH_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: id }],
    });
    await client.query(built.sql, built.params);
    return true;
}

/**
 * Delete an app AND the data it holds.
 *
 * The Postgres rows were never the whole app: its records live in a per-app
 * database (a RustFS blob under the sqlite engine, a Postgres schema under the
 * pg one) and every uploaded file is an object in RustFS with a ledger row.
 * Deleting only the studio_apps row left all of that behind — customer e-mail
 * bodies, invoice PDFs and ID scans surviving a deletion the owner was told had
 * happened, unreachable and unforgettable. That is a GDPR erasure failure, not
 * a storage-cost footnote.
 *
 * The purge runs BEFORE the row goes (the row is how we find the data) and is
 * best-effort per artifact: a RustFS hiccup must not leave an app that cannot
 * be deleted at all, so failures are logged loudly and the deletion proceeds.
 */
async function deleteStudioApp(io, id, ownerId, { managedWrite = null } = {}) {
    await io.ready();
    const r = await io.db.getOne(`SELECT * FROM studio_apps WHERE id = $1 AND user_id = $2`, [id, ownerId]);
    if (!r) return null;
    // An app of a Solution stage is retired by a deploy, never deleted by hand.
    await guardOf(io).assertManagedWrite({ kind: 'app', projectId: r.project_id ?? null, changedKeys: ['delete'], managedWrite });

    // 1. The per-app database, through the engine facade (sqlite: local handle
    //    + RustFS blob + metadata; pg: DROP SCHEMA CASCADE).
    try {
        await require('./studioAppDbStore').reset(ownerId, id);
    } catch (e) {
        log.error(`[StudioAppStore] delete ${id}: per-app database purge FAILED: ${e.message}`);
    }

    // 2. Attachment objects (content-addressed) + their ledger rows.
    try {
        const storageStore = require('./storageStore');
        const rows = await io.db.getAll(
            `SELECT sha256 FROM studio_app_attachments WHERE app_id = $1 AND owner_user_id = $2`,
            [id, ownerId],
        );
        if (storageStore.isAvailable()) {
            // Objects are content-addressed, so the same sha can back several
            // ledger rows — delete each key once.
            for (const sha of new Set((rows || []).map((r) => r.sha256).filter(Boolean))) {
                try {
                    await storageStore.deleteFile(storageStore.buildStudioAppAttachmentKey(ownerId, id, sha));
                } catch (e) {
                    log.error(`[StudioAppStore] delete ${id}: attachment ${sha} purge failed: ${e.message}`);
                }
            }
        }
        await io.db.run(`DELETE FROM studio_app_attachments WHERE app_id = $1`, [id]);
    } catch (e) {
        log.error(`[StudioAppStore] delete ${id}: attachment purge FAILED: ${e.message}`);
    }

    // 3. The app's own Postgres rows. studio_app_data_meta / _datasets /
    //    _members / _connector_sync are app-scoped too.
    //    The guard runs again on the locked row: a filing into a stage or a
    //    deploy that landed during the purge refuses the row delete itself.
    await inTx(io, async (client) => {
        const cur = (await client.query(
            `SELECT project_id FROM studio_apps WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, ownerId],
        )).rows[0];
        if (!cur) return;
        await guardOf(io).assertManagedWrite({
            kind: 'app', projectId: cur.project_id ?? null, changedKeys: ['delete'], managedWrite, client,
        });
        await client.query(`DELETE FROM studio_apps WHERE id = $1 AND user_id = $2`, [id, ownerId]);
    });
    // No FK on studio_app_versions — remove snapshots explicitly.
    await io.db.run(`DELETE FROM studio_app_versions WHERE app_id = $1`, [id]);
    // studio_app_dataset_cache is NOT app-scoped — it keys on dataset_id and
    // cascades from studio_app_datasets, which is deleted below. It was in this
    // list anyway, so every single app delete logged
    // `cleanup of studio_app_dataset_cache skipped: column "app_id" does not
    // exist` — a warning that was permanent, harmless and therefore training
    // everyone reading these logs to skim past the line that would one day say
    // something real.
    for (const table of ['studio_app_data_meta', 'studio_app_datasets',
        'studio_app_members', 'studio_app_connector_sync']) {
        try { await io.db.run(`DELETE FROM ${table} WHERE app_id = $1`, [id]); } catch (e) {
            // A table this deployment doesn't have yet is not a reason to fail
            // the delete; anything else is worth seeing.
            log.warn(`[StudioAppStore] delete ${id}: cleanup of ${table} skipped: ${e.message}`);
        }
    }
    return mapAppRow(r);
}

// ── Publish-version history ─────────────────────────────────────────

/**
 * Insert one immutable definition snapshot into studio_app_versions and prune
 * the app's history back to the newest MAX_VERSIONS_PER_APP. THE single writer
 * of version rows: the publish path (summary 'Published') and the AI builder's
 * plan/phase checkpoints ('AI checkpoint — …') both go through here, so the
 * prune-to-20 rule lives in exactly one place.
 *
 * Runs on the caller's `client` when supplied (the publish path passes its own
 * so the snapshot is atomic with the freeze); otherwise opens a short private
 * transaction. Returns the new version id.
 *
 * @param {object|string} definition Definition object (JSON-stringified here)
 *   or an already-serialized JSON string (the publish path's frozen payload).
 */
async function createVersionSnapshot(appId, ownerId, definition, summary = 'Checkpoint', { client = null } = {}) {
    if (client) return writeVersionSnapshot(client, appId, ownerId, definition, summary);
    await initDB();
    const own = await getClient();
    try {
        await own.query('BEGIN');
        const versionId = await writeVersionSnapshot(own, appId, ownerId, definition, summary);
        await own.query('COMMIT');
        return versionId;
    } catch (e) {
        await own.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        own.release();
    }
}

async function writeVersionSnapshot(client, appId, ownerId, definition, summary) {
    const versionId = crypto.randomUUID();
    const defPayload = typeof definition === 'string' ? definition : JSON.stringify(definition ?? {});
    await client.query(
        `INSERT INTO studio_app_versions (id, app_id, user_id, definition, summary)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [versionId, appId, ownerId, defPayload, summary]
    );
    // Prune oldest snapshots beyond the cap.
    const pruned = await client.query(
        `SELECT id FROM studio_app_versions WHERE app_id = $1 ORDER BY created_at DESC, id OFFSET $2`,
        [appId, MAX_VERSIONS_PER_APP]
    );
    if (pruned.rows.length > 0) {
        await client.query(
            `DELETE FROM studio_app_versions WHERE id = ANY($1::text[])`,
            [pruned.rows.map(r => r.id)]
        );
    }
    return versionId;
}

/** Version history for an app — meta only, no definition payloads. */
async function listVersions(appId, ownerId) {
    await initDB();
    const rows = await getAll(
        `SELECT id, app_id, summary, created_at FROM studio_app_versions
         WHERE app_id = $1 AND user_id = $2
         ORDER BY created_at DESC, id`,
        [appId, ownerId]
    );
    return rows.map(mapVersionMetaRow);
}

/** One snapshot with its full definition, scoped to the app AND its owner. */
async function getVersion(appId, versionId, ownerId) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM studio_app_versions WHERE id = $1 AND app_id = $2 AND user_id = $3`,
        [versionId, appId, ownerId]
    );
    return r ? mapVersionRow(r) : null;
}

/**
 * Copy a snapshot's definition back over the working definition (bumping
 * definition_version so open editors' CAS saves conflict instead of silently
 * clobbering the restore). Returns the updated app row, or null when the
 * version/app doesn't exist or isn't owned by ownerId.
 */
async function restoreVersion(io, appId, versionId, ownerId, { managedWrite = null } = {}) {
    await io.ready();
    const client = await io.db.getClient();
    try {
        await client.query('BEGIN');
        const v = await client.query(
            `SELECT definition FROM studio_app_versions WHERE id = $1 AND app_id = $2 AND user_id = $3`,
            [versionId, appId, ownerId]
        );
        if (v.rows.length === 0) {
            await client.query('ROLLBACK');
            return null;
        }
        const app = await client.query(
            `SELECT project_id FROM studio_apps WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [appId, ownerId]
        );
        if (app.rows.length > 0) {
            await guardOf(io).assertManagedWrite({
                kind: 'app', projectId: app.rows[0].project_id ?? null, changedKeys: ['definition'], managedWrite, client,
            });
        }
        const payload = typeof v.rows[0].definition === 'string'
            ? v.rows[0].definition
            : JSON.stringify(v.rows[0].definition ?? {});
        const upd = await client.query(
            `UPDATE studio_apps SET definition = $1::jsonb, definition_version = definition_version + 1, updated_at = NOW()
             WHERE id = $2 AND user_id = $3 RETURNING *`,
            [payload, appId, ownerId]
        );
        if (upd.rows.length === 0) {
            await client.query('ROLLBACK');
            return null;
        }
        await client.query('COMMIT');
        return mapAppRow(upd.rows[0]);
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

// ── Access predicates (pure) ────────────────────────────────────────

/**
 * Single-row visibility predicate over a mapped app row. Owner always;
 * otherwise the app must be published into an org the user belongs to, with
 * shared_groups=[] meaning the whole org. Mirrors canReadWebpage.
 */
function canReadStudioApp(app, userId, userGroupIds = [], userOrgIds = []) {
    if (!app) return false;
    if (app.userId === userId) return true;
    if (!app.isPublished) return false;
    if (!app.organizationId) return false;
    const orgIds = Array.isArray(userOrgIds) ? userOrgIds : [...(userOrgIds || [])];
    if (!orgIds.includes(app.organizationId)) return false;
    const groups = Array.isArray(app.sharedGroups) ? app.sharedGroups : [];
    if (groups.length === 0) return true;
    return groups.some(g => userGroupIds.includes(g));
}

/**
 * canReadStudioApp, widened by Studio Project membership.
 *
 * Async because the project role is a DB lookup, which is why this is a
 * separate function rather than a fourth argument: the sync predicate has
 * callers that cannot await (the templates, the pure filters), and they keep
 * the old behaviour to the letter.
 *
 * ADDITIVE, NEVER A DOWNGRADE. It is only ever consulted after the sync
 * predicate has already said no, so an app that was readable stays readable.
 *
 * READ ONLY. Filing an app into a project does not make the project's members
 * its authors — canWriteStudioApp stays owner-only for the acts-as-author
 * reason below, and no write path calls this.
 *
 * PUBLICATION IS STILL REQUIRED. Project membership answers WHO may read, not
 * whether there is anything to read: without is_published there is no frozen
 * published_definition, the runtime route refuses the app before it asks any
 * predicate, and the owner's live draft is never served to anyone else. So a
 * standalone app (project_id IS NULL) and an unpublished one both stay exactly
 * as private as they were.
 */
async function canReadStudioAppAsync(app, userId, userGroupIds = [], userOrgIds = []) {
    if (canReadStudioApp(app, userId, userGroupIds, userOrgIds)) return true;
    if (!app || !app.projectId || !userId) return false;
    if (!app.isPublished) return false;
    const { getProjectRole } = require('../auth/projectAccess');
    return !!(await getProjectRole(userId, app.projectId));
}

// Owner-only, unlike canWriteWebpage. Deliberate: app actions run automations
// acts-as-author, so shared editors could otherwise point the owner's
// credentials at arbitrary automations by rewiring the definition.
function canWriteStudioApp(app, userId) {
    if (!app) return false;
    return app.userId === userId;
}

/**
 * Cheap existence check: does the user have at least one app they can see
 * (own, or published into their org/groups)? Group-share membership is
 * checked in JS (mirrors getAccessibleStudioApps), so we fetch a tiny
 * candidate window rather than a bare EXISTS.
 */
async function userHasAnyStudioAppAccess(userId, userGroupIds = [], userOrgIds = []) {
    await initDB();
    if (!userId) return false;
    const orgIds = Array.isArray(userOrgIds) ? userOrgIds : [...(userOrgIds || [])];
    const groupIds = Array.isArray(userGroupIds) ? userGroupIds : [];
    const owned = await getOne(`SELECT 1 FROM studio_apps WHERE user_id = $1 LIMIT 1`, [userId]);
    if (owned) return true;
    if (orgIds.length === 0) return false;
    const rows = await getAll(
        `SELECT id, is_published, organization_id, shared_groups
           FROM studio_apps
          WHERE is_published = TRUE AND organization_id = ANY($1::text[])
          LIMIT 50`,
        [orgIds]
    );
    return rows.some(r => {
        const groups = parseJSON(r.shared_groups, []);
        if (!Array.isArray(groups) || groups.length === 0) return true; // entire-org publish
        return groups.some(g => groupIds.includes(g));
    });
}

// ── Builder session snapshot ────────────────────────────────────────
//
// The AI builder loop persists a small snapshot {sessionId, version,
// messages, ...} into studio_apps.builder_session after every mutation so a
// dropped SSE connection can rehydrate the chat. Same mechanics as
// automationStore/builderSessions.js: a monotonically-increasing `version`
// gives optimistic locking — two-tab edits get {conflict:true} on the second
// write so the loser can refresh instead of clobbering.

const SNAPSHOT_MAX_BYTES = 64 * 1024;

// Top-level snapshot keys that must survive trimming INTACT — plan-first UX
// state the builder rehydrates from (pendingPlan/approvedPlan), checkpoint
// bookkeeping, and continuation state. Names frozen here (Wave 2C); future
// snapshot writers add to this list, and trimSnapshot may only ever squeeze
// the `messages` array — never these.
const PINNED_SNAPSHOT_KEYS = Object.freeze([
    'pendingPlan', 'approvedPlan', 'checkpoints', 'continueToken', 'lastTier',
]);

// Appended to `summary` (once) when messages were dropped, so a rehydrated
// session knows its history is partial.
const SNAPSHOT_TRIM_MARKER = '(older messages trimmed)';

function trimSnapshot(snapshot, { block = 1 } = {}) {
    if (!snapshot) return null;
    let payload = JSON.stringify(snapshot);
    if (payload.length <= SNAPSHOT_MAX_BYTES) return snapshot;
    // Drop oldest messages until we fit — ONLY the messages array is ever
    // trimmed. Keep the most recent turns intact so resume always shows the
    // user the latest model output.
    //
    // In multiples of `block` when the caller asks (the builder route passes
    // its history-window block): the model's prompt is [prefix…][history…],
    // and evicting one message at a time moves the first kept message on
    // every save, shifting every later byte the llama.cpp prefix cache could
    // have reused. Whole blocks keep the prefix stable between evictions.
    // Never below block + 2 messages, so a resume still shows the latest turn.
    const step = Number.isInteger(block) && block > 1 ? block : 1;
    const trimmed = { ...snapshot, messages: Array.isArray(snapshot.messages) ? [...snapshot.messages] : [] };
    let dropped = 0;
    while (trimmed.messages.length > Math.max(2, step + 2)) {
        trimmed.messages.splice(0, Math.min(step, trimmed.messages.length - 2));
        dropped += 1;
        payload = JSON.stringify(trimmed);
        if (payload.length <= SNAPSHOT_MAX_BYTES) break;
    }
    if (dropped > 0) {
        const summary = typeof trimmed.summary === 'string' ? trimmed.summary : '';
        if (!summary.includes(SNAPSHOT_TRIM_MARKER)) {
            trimmed.summary = summary ? `${summary} ${SNAPSHOT_TRIM_MARKER}` : SNAPSHOT_TRIM_MARKER;
        }
    }
    // Belt-and-braces: whatever future trimming strategies do, the pinned keys
    // ride through byte-identical.
    for (const k of PINNED_SNAPSHOT_KEYS) {
        if (snapshot[k] !== undefined) trimmed[k] = snapshot[k];
    }
    return trimmed;
}

async function getBuilderSession(appId, userId) {
    await initDB();
    const r = await getOne(`SELECT builder_session, user_id FROM studio_apps WHERE id = $1`, [appId]);
    if (!r) return null;
    if (userId && r.user_id !== userId) return null;
    return typeof r.builder_session === 'string'
        ? parseJSON(r.builder_session, null)
        : (r.builder_session ?? null);
}

/**
 * Persist a builder-session snapshot. When `expectedVersion` is provided,
 * the write only succeeds if the persisted snapshot's version matches —
 * mismatches return { ok: false, conflict: true, current }. When omitted,
 * the write is unconditional and the version increments by 1.
 */
async function setBuilderSession(io, appId, userId, snapshot, { expectedVersion = null, trimBlock = 1, managedWrite = null } = {}) {
    await io.ready();
    const trimmed = trimSnapshot(snapshot, { block: trimBlock }) || {};
    const client = await io.db.getClient();
    try {
        await client.query('BEGIN');
        const cur = await client.query(
            `SELECT user_id, builder_session, project_id FROM studio_apps WHERE id = $1 FOR UPDATE`,
            [appId]
        );
        if (cur.rows.length === 0) {
            await client.query('ROLLBACK');
            return { ok: false, notFound: true };
        }
        if (userId && cur.rows[0].user_id !== userId) {
            await client.query('ROLLBACK');
            return { ok: false, forbidden: true };
        }
        // An app of a Solution stage has no AI builder session (changed in Dev, deployed).
        await guardOf(io).assertManagedWrite({
            kind: 'app', projectId: cur.rows[0].project_id ?? null, changedKeys: ['builderSession'], managedWrite, client,
        });
        const currentSnap = (typeof cur.rows[0].builder_session === 'string'
            ? parseJSON(cur.rows[0].builder_session, null)
            : (cur.rows[0].builder_session ?? null)) || {};
        const currentVersion = Number.isFinite(currentSnap.version) ? currentSnap.version : 0;
        if (expectedVersion != null && currentVersion !== expectedVersion) {
            await client.query('ROLLBACK');
            return { ok: false, conflict: true, current: currentSnap };
        }
        const next = { ...trimmed, version: currentVersion + 1 };
        await client.query(
            `UPDATE studio_apps SET builder_session = $1::jsonb, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(next), appId]
        );
        await client.query('COMMIT');
        return { ok: true, snapshot: next };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

async function clearBuilderSession(appId, userId) {
    await initDB();
    if (userId) {
        await run(`UPDATE studio_apps SET builder_session = NULL WHERE id = $1 AND user_id = $2`, [appId, userId]);
    } else {
        await run(`UPDATE studio_apps SET builder_session = NULL WHERE id = $1`, [appId]);
    }
}

// ── Nextcloud app-menu publication ──────────────────────────────────

/**
 * Toggle whether this app should appear in the Nextcloud app menu of the
 * organisation's connected Nextcloud. Owner-scoped in the WHERE (IDOR-safe,
 * same contract as updateStudioApp). Returns the updated meta row or null.
 */
async function setStudioAppNextcloudMenu(id, ownerId, enabled) {
    await initDB();
    const row = await getOne(
        `UPDATE studio_apps SET nextcloud_menu = $1, updated_at = NOW()
         WHERE id = $2 AND user_id = $3
         RETURNING ${META_COLS}`,
        [!!enabled, id, ownerId]
    );
    return row ? mapAppMetaRow(row) : null;
}

/**
 * Apps the organisation's Nextcloud connector should expose as top-menu
 * entries: org-scoped, owner-opted-in (nextcloud_menu) AND currently
 * published with a frozen definition to serve. Meta only — the connector
 * needs names/icons, never definitions. Ordered by name so the menu order
 * is stable across syncs; capped because each row becomes an icon in every
 * user's Nextcloud top bar.
 */
const MAX_NEXTCLOUD_MENU_APPS = 30;
async function listNextcloudMenuApps(organizationId, { limit = MAX_NEXTCLOUD_MENU_APPS } = {}) {
    await initDB();
    if (!organizationId) return [];
    const rows = await getAll(
        `SELECT ${META_COLS} FROM studio_apps
         WHERE organization_id = $1
           AND nextcloud_menu = TRUE
           AND is_published = TRUE
           AND published_definition IS NOT NULL
         ORDER BY name ASC, id ASC
         LIMIT $2`,
        [organizationId, Math.min(limit, MAX_NEXTCLOUD_MENU_APPS)]
    );
    return rows.map(mapAppMetaRow);
}

// ── Project membership ──────────────────────────────────────────────

/** Apps filed into a project. Meta only — never the definition payloads. */
async function listProjectApps(projectId) {
    await initDB();
    if (!projectId) return [];
    const rows = await getAll(
        `SELECT ${META_COLS} FROM studio_apps WHERE project_id = $1 ORDER BY updated_at DESC`,
        [projectId]
    );
    return rows.map(mapAppMetaRow);
}

/**
 * How many apps each of these projects holds — ONE query for the whole
 * list, keyed by project id.
 *
 * The overview draws a card per Solution and every card carries a tally. Doing
 * that with the listing above would be one round-trip per project per kind, and
 * would read whole rows to throw all but their number away. A project that
 * appears in no row is genuinely EMPTY, which is why the caller distinguishes a
 * missing key (0) from a failed read (the whole call rejects) rather than
 * folding both into a zero.
 */
async function countProjectApps(projectIds) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return new Map();
    const rows = await getAll(
        `SELECT project_id, COUNT(*)::int AS n FROM studio_apps
          WHERE project_id = ANY($1) GROUP BY project_id`,
        [ids]
    );
    return new Map(rows.map(r => [r.project_id, Number(r.n) || 0]));
}

/**
 * File an app into a project, or take it out (projectId = null).
 *
 * Owner-only: filing an app into a project exposes it to every member without
 * it being org-published, which is the owner's decision. Callers check the
 * user's role on the TARGET project separately.
 */
async function setAppProject(appId, userId, projectId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE studio_apps SET project_id = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
        [projectId || null, appId, userId]
    );
    return rowCount > 0;
}

/**
 * Detach every app from a deleted project.
 *
 * Soft reference, so nothing clears it automatically — and deleting a project
 * must never destroy the apps its members built inside it.
 */
async function clearProjectFromApps(projectId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE studio_apps SET project_id = NULL WHERE project_id = $1',
        [projectId]
    );
    return rowCount;
}

// ── Public pages (anonymous entry points) ───────────────────────────
//
// The row id IS the URL token and IS the credential (automation_form_pages
// precedent). WHAT the anonymous visitor may see is not stored here — that is
// `publicAccess` in the app definition, so it versions with the app; this row
// only answers "is this URL live, and for which app?".

function mapPublicPageRow(r) {
    if (!r) return null;
    return {
        token: r.id,
        appId: r.app_id,
        createdBy: r.created_by || null,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at || null,
        visits: Number(r.visits || 0),
    };
}

/** Mint a public URL for an app. 192 bits, exactly like a form page token. */
async function createPublicPage(appId, userId) {
    await initDB();
    const token = crypto.randomBytes(24).toString('hex');
    await run(
        'INSERT INTO studio_app_public_pages (id, app_id, created_by) VALUES ($1, $2, $3)',
        [token, appId, userId || null]
    );
    return { token, appId, createdBy: userId || null, visits: 0 };
}

/** Resolve a URL token. Shape is checked by the caller before any DB work. */
async function getPublicPage(token) {
    await initDB();
    if (!token) return null;
    return mapPublicPageRow(await getOne('SELECT * FROM studio_app_public_pages WHERE id = $1', [token]));
}

async function listPublicPages(appId) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM studio_app_public_pages WHERE app_id = $1 ORDER BY created_at DESC',
        [appId]
    );
    return rows.map(mapPublicPageRow);
}

/** Revoke a public URL. Scoped by appId so a token from another app can't be
 *  deleted by guessing (the caller has already proven ownership of the app). */
async function deletePublicPage(token, appId) {
    await initDB();
    const { rowCount } = await run(
        'DELETE FROM studio_app_public_pages WHERE id = $1 AND app_id = $2',
        [token, appId]
    );
    return rowCount > 0;
}

/** Advisory visit counter — never allowed to fail a request. */
async function touchPublicPage(token) {
    try {
        await run(
            'UPDATE studio_app_public_pages SET last_seen_at = NOW(), visits = visits + 1 WHERE id = $1',
            [token]
        );
    } catch (_) { /* advisory only */ }
}

// ── The guarded writers, over one database ─────────────────────────
//
// Every writer the managed-write lock covers takes an `io` context as its first
// argument: the database, its schema init and the guard. Those functions are
// module-private under their exported names; the app binds them to db.js below;
// a pglite test builds its own set with makeStudioAppWriters, so the lock is
// proven against a real Postgres without replacing a module.

/**
 * @param {{ run: Function, getOne: Function, getAll: Function, getClient: () => Promise<any> }} db
 * @param {{ ready?: () => Promise<unknown>, managedParts?: { assertManagedWrite: Function }|null }} [opts]
 */
function makeStudioAppWriters(db, { ready = async () => {}, managedParts = null } = {}) {
    const io = { db, ready, managedParts };
    return {
        updateStudioApp: (id, updates, ownerId, opts) => updateStudioApp(io, id, updates, ownerId, opts),
        saveDefinition: (id, ownerId, definition, opts) => saveDefinition(io, id, ownerId, definition, opts),
        setStudioAppPublished: (id, isPublished, ownerId, sharedGroups, organizationId, publishedDefinition, publishedVersion) =>
            setStudioAppPublished(io, id, isPublished, ownerId, sharedGroups, organizationId, publishedDefinition, publishedVersion),
        setStudioAppAudience: (id, ownerId, audience) => setStudioAppAudience(io, id, ownerId, audience),
        publishDefinitionWith: (client, id, definition, version, opts) => publishDefinitionWith(io, client, id, definition, version, opts),
        deleteStudioApp: (id, ownerId, opts) => deleteStudioApp(io, id, ownerId, opts),
        restoreVersion: (appId, versionId, ownerId, opts) => restoreVersion(io, appId, versionId, ownerId, opts),
        setBuilderSession: (appId, userId, snapshot, opts) => setBuilderSession(io, appId, userId, snapshot, opts),
        /** null | {solutionId, stage, stageProjectId}: the stage an app belongs to (cached lookup). */
        managedInfoOfApp: (app) => guardOf(io).managedInfo(app && app.projectId ? app.projectId : null),
    };
}

// The app's set: db.js behind the store's schema init. Wrapped, not bound, so
// a test that replaces '../db' before requiring this store is still honoured.
const writers = makeStudioAppWriters({
    run: (sql, params) => run(sql, params),
    getOne: (sql, params) => getOne(sql, params),
    getAll: (sql, params) => getAll(sql, params),
    getClient: () => getClient(),
}, { ready: initDB });

// ── DE AUTOMATION-INDEX HANGT AAN DE SCHRIJVER, NIET AAN DE ROUTE ──────
//
// `automation_usage` beantwoordt "welke knop draait deze automation", en de
// automation-editor toont dat als de capsule "Gebruikt door 1 knop". Het is het
// enige scherm waarop iemand die op het punt staat een automatisering te verwijderen
// of te deactiveren ziet dat er een app-knop aan hangt.
//
// `reconcileAutomationUsage` is delete-then-insert op (consumer_kind,
// consumer_id), dus een schrijver die de reconcile overslaat laat de rijen van
// de VORIGE definitie staan: een actie die zijn automatisering kwijtraakt houdt de
// capsule in de lucht, en een die er een krijgt komt er nooit in.
//
// Daarom staat hij hier, om de DRIE functies die `studio_apps.definition`
// echt veranderen — createStudioApp, saveDefinition en restoreVersion. Dat is
// de enige plek waar "de app is veranderd" en "de index is achterhaald"
// hetzelfde feit zijn. In de routes zou elke nieuwe schrijver een nieuw gat
// zijn: naast de vier app-routes schrijven ook de installatie en de upgrade
// van een Oplossing (projects/packaging/install.js, upgrade.js) en de
// AI-bouwer (appStudio/builderTools/persistence.js) een definitie weg zonder
// ooit langs een app-route te komen. Dat zijn samen tien aanroepplekken op
// drie schrijvers; appStudio/automationUsage.savePaths.test.js TELT ze in
// plaats van er één te noemen.
//
// OOK om `setStudioAppPublished`, en dat is sinds de sluitronde van P4 een
// bewuste omkering. Die functie bevriest een KOPIE (`published_definition`) en
// raakt de werkende definitie niet — maar de index gaat over de vraag "wie
// breekt er als ik deze automatisering weggooi", en dat is een vraag over PRODUCTIE.
// Bezoekers draaien de gepubliceerde kopie, dus die telt mee: de reconciler
// bouwt de UNIE van draft en published (appStudio/automationUsageSync.js), en
// dan verandert publiceren én DEPUBLICEREN wel degelijk wat er in de index
// hoort te staan.
//
// Gedebouncet en detached: het is een index, geen bewerking. Een save wacht er
// niet op en gaat er niet aan kapot.
function reindexAutomationUsage(appId) {
    if (!appId) return;
    try {
        require('../appStudio/automationUsageSync').reconcileAppAutomationUsageDetached(appId);
    } catch (_) {
        // Een index mag een schrijfactie nooit laten omvallen.
    }
}

async function createStudioAppIndexed(args) {
    const app = await createStudioApp(args);
    reindexAutomationUsage(app && app.id);
    return app;
}

async function saveDefinitionIndexed(id, ownerId, definition, opts) {
    const out = await writers.saveDefinition(id, ownerId, definition, opts);
    // Alleen na een ECHTE schrijf. Een CAS-conflict of een niet-gevonden app
    // heeft niets veranderd, en dan is een scan alleen maar werk.
    if (out && out.ok) reindexAutomationUsage(id);
    return out;
}

async function restoreVersionIndexed(appId, versionId, ownerId, opts) {
    const out = await writers.restoreVersion(appId, versionId, ownerId, opts);
    if (out) reindexAutomationUsage(appId);
    return out;
}

async function setStudioAppPublishedIndexed(id, ...rest) {
    const out = await writers.setStudioAppPublished(id, ...rest);
    // Publiceren verandert de GEPUBLICEERDE helft van de unie, depubliceren
    // haalt hem weg. Alleen na een echte schrijf: `false` betekent dat de app
    // niet bestaat of niet van deze eigenaar is, en dan is er niets veranderd.
    if (out) reindexAutomationUsage(id);
    return out;
}

/**
 * Verwijderen ruimt de index op. Geen FK — `automations` en `automation_usage`
 * horen bij andere stores — dus zonder dit blijft een rij staan die een
 * automation-eigenaar vertelt dat een knop die hij niet kan zien zijn automatisering
 * aanzet. Ge-await, anders dan de reconcile: een purge die met de verwijdering
 * meeraced zou de rijen kunnen terugzetten. Gooit nooit (de purge vangt zelf).
 */
async function deleteStudioAppIndexed(id, ownerId, opts) {
    const out = await writers.deleteStudioApp(id, ownerId, opts);
    if (out) {
        await require('../appStudio/automationUsageSync').purgeAppAutomationUsage(id);
    }
    return out;
}

module.exports = {
    get ready() { return initDB(); },
    initDB,
    listProjectApps,
    countProjectApps,
    setAppProject,
    clearProjectFromApps,
    MAX_VERSIONS_PER_APP,
    SNAPSHOT_MAX_BYTES,
    PINNED_SNAPSHOT_KEYS,
    SNAPSHOT_TRIM_MARKER,
    // Apps — de drie definitieschrijvers en de delete gaan door hun
    // herindexerende wrapper; zie het blok hierboven.
    createStudioApp: createStudioAppIndexed,
    getStudioApp,
    getStudioAppsByUser,
    getAccessibleStudioApps,
    updateStudioApp: writers.updateStudioApp,
    setTemplateStamp,
    setTemplateProvenance,
    saveDefinition: saveDefinitionIndexed,
    setStudioAppPublished: setStudioAppPublishedIndexed,
    // Solution stages: the audience alone (never the published copy), the
    // deploy's commit flip, and the stage an app belongs to.
    setStudioAppAudience: writers.setStudioAppAudience,
    // No reindex here: it runs inside the deploy's commit, and a detached
    // reindex would read before the commit lands. The deploy's converge phase
    // reindexes the app's automation usage after the commit.
    publishDefinitionWith: writers.publishDefinitionWith,
    managedInfoOfApp: writers.managedInfoOfApp,
    makeStudioAppWriters,
    deleteStudioApp: deleteStudioAppIndexed,
    // Nextcloud app-menu publication
    setStudioAppNextcloudMenu,
    listNextcloudMenuApps,
    MAX_NEXTCLOUD_MENU_APPS,
    // Publish-version history
    createVersionSnapshot,
    listVersions,
    getVersion,
    // Ook een definitieschrijver, dus ook door de wrapper — een teruggezette
    // versie kan andere automatiseringen noemen dan de versie die eroverheen ging.
    restoreVersion: restoreVersionIndexed,
    // Access
    canReadStudioApp,
    canReadStudioAppAsync,
    canWriteStudioApp,
    userHasAnyStudioAppAccess,
    // Builder session
    getBuilderSession,
    setBuilderSession: writers.setBuilderSession,
    clearBuilderSession,
    // Public pages (anonymous entry points)
    createPublicPage,
    getPublicPage,
    listPublicPages,
    deletePublicPage,
    touchPublicPage,
};
