// @typecheck
/**
 * Studio App Template Store — PostgreSQL persistence for templates CAPTURED
 * from a live app (appStudio/templateCapture.js).
 *
 * The twenty templates the product ships are CODE (appStudio/templates/), and
 * they stay code: they are reviewed, versioned with the repo and identical on
 * every instance. This table is the other half — a template someone made out of
 * their own app, which exists only on their instance and must not require a
 * release to create.
 *
 * Both halves are read through appStudio/templateRegistry.js, so every consumer
 * (the gallery route, create-from-template, the builder tools) sees ONE list.
 * Ids are prefixed `utpl_` and built-in ids are not, which makes provenance
 * unambiguous in a log line, a URL and an app row's template_id.
 *
 * VISIBILITY is the organisation, not the world: a template belongs to the org
 * of the app it came from, and any member of that org can install it. A capture
 * from an app with no organisation is private to its creator. Only the creator
 * (or an org admin, via the route) can delete one.
 *
 * The payload — { definition, dataModel, seed, datasets } — is an opaque JSONB
 * blob here exactly as studio_apps.definition is: it was canonicalized and
 * validated by templateCapture before it ever reached this store, and it is
 * canonicalized again on install. This layer enforces the byte ceiling and
 * nothing else.
 */

'use strict';

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { MAX_TEMPLATE_BYTES } = require('../appStudio/templateCapture');

// Per-org ceiling. A gallery is a place you choose from; a few hundred entries
// is a search problem, not a gallery, and an unbounded table of multi-megabyte
// JSONB blobs is a storage problem too.
const MAX_TEMPLATES_PER_ORG = 100;

const initDB = makeStoreInit('StudioAppTemplateStore', _initDB);

async function _initDB() {

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_templates (
            id TEXT PRIMARY KEY,
            organization_id TEXT,
            created_by TEXT NOT NULL,
            source_app_id TEXT,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            category TEXT,
            icon TEXT,
            tags JSONB NOT NULL DEFAULT '[]'::jsonb,
            version INTEGER NOT NULL DEFAULT 1,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_templates_org
            ON studio_app_templates(organization_id) WHERE organization_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_studio_app_templates_creator
            ON studio_app_templates(created_by);
    `);
}

function newId() {
    return `utpl_${crypto.randomBytes(8).toString('hex')}`;
}

/** True for an id this store owns — the discriminator templateRegistry reads. */
function isCapturedTemplateId(id) {
    return typeof id === 'string' && id.startsWith('utpl_');
}

/**
 * DB row → the template shape templates.js entries have, so a caller cannot
 * tell a captured template from a built-in one by its keys alone. `source`
 * and the provenance fields are ADDITIVE — nothing in the install path reads
 * them, and the gallery uses them to label and to offer a delete.
 */
function mapRow(row, { includePayload = true } = {}) {
    if (!row) return null;
    const payload = (row.payload && typeof row.payload === 'object') ? row.payload : {};
    const meta = {
        id: row.id,
        version: Number.isInteger(row.version) && row.version > 0 ? row.version : 1,
        title: row.title,
        description: row.description || '',
        category: row.category || 'Van je team',
        icon: row.icon || 'LayoutGrid',
        tags: Array.isArray(row.tags) ? row.tags : [],
        source: 'captured',
        createdBy: row.created_by,
        sourceAppId: row.source_app_id || null,
        organizationId: row.organization_id || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    if (!includePayload) return meta;
    return {
        ...meta,
        definition: payload.definition || {},
        ...(payload.dataModel ? { dataModel: payload.dataModel } : {}),
        ...(payload.seed ? { seed: payload.seed } : {}),
        ...(payload.datasets ? { datasets: payload.datasets } : {}),
    };
}

/**
 * Create a captured template, or replace the payload of one that already
 * exists (`id`), bumping its version.
 *
 * Re-saving is a VERSION BUMP rather than a silent overwrite because apps
 * created from a captured template carry its version, and templateUpgrade
 * offers a pristine app the newer one — the same contract the built-in
 * templates have. Saving the improved app back over its own template is the
 * obvious thing to want, and it should reach the copies.
 * @param {{ id?: string|null, organizationId?: string|null, createdBy?: string, sourceAppId?: string|null, title?: string, description?: string, category?: string|null, icon?: string|null, tags?: string[], payload?: any }} [opts]
 */
async function saveTemplate({
    id = null, organizationId = null, createdBy, sourceAppId = null,
    title, description = '', category = null, icon = null, tags = [], payload,
} = {}) {
    await initDB();
    if (!createdBy) throw new Error('createdBy is required');
    if (!title) throw new Error('title is required');
    if (!payload || typeof payload !== 'object') throw new Error('payload is required');

    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, 'utf8') > MAX_TEMPLATE_BYTES) {
        throw new Error(`Template payload exceeds ${MAX_TEMPLATE_BYTES} bytes`);
    }

    if (id) {
        const existing = await getOne('SELECT * FROM studio_app_templates WHERE id = $1', [id]);
        if (!existing) throw new Error('Template not found');
        if (existing.created_by !== createdBy) throw new Error('Only the template\'s creator can replace it');
        const row = await getOne(
            `UPDATE studio_app_templates
                SET title = $2, description = $3, category = $4, icon = $5, tags = $6::jsonb,
                    payload = $7::jsonb, version = version + 1, source_app_id = $8, updated_at = NOW()
              WHERE id = $1
              RETURNING *`,
            [id, title, description || '', category, icon, JSON.stringify(tags || []), json, sourceAppId],
        );
        return mapRow(row);
    }

    const scope = organizationId
        ? await getOne('SELECT COUNT(*)::int AS n FROM studio_app_templates WHERE organization_id = $1', [organizationId])
        : await getOne('SELECT COUNT(*)::int AS n FROM studio_app_templates WHERE created_by = $1 AND organization_id IS NULL', [createdBy]);
    if (scope && scope.n >= MAX_TEMPLATES_PER_ORG) {
        throw new Error(`Template limit reached (${MAX_TEMPLATES_PER_ORG}). Delete one before saving another.`);
    }

    const row = await getOne(
        `INSERT INTO studio_app_templates
            (id, organization_id, created_by, source_app_id, title, description, category, icon, tags, version, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 1, $10::jsonb)
         RETURNING *`,
        [newId(), organizationId, createdBy, sourceAppId, title, description || '',
            category, icon, JSON.stringify(tags || []), json],
    );
    return mapRow(row);
}

/**
 * Templates this user may install: their org's, plus their own private ones.
 * Meta only — the gallery never needs the payload, and these blobs are large.
 * @param {{ userId?: string, orgIds?: string[] }} [opts]
 */
async function listTemplatesFor({ userId, orgIds = [] } = {}) {
    await initDB();
    const orgs = (Array.isArray(orgIds) ? orgIds : []).filter(Boolean);
    const rows = await getAll(
        `SELECT id, organization_id, created_by, source_app_id, title, description,
                category, icon, tags, version, created_at, updated_at,
                '{}'::jsonb AS payload
           FROM studio_app_templates
          WHERE (created_by = $1 AND organization_id IS NULL)
             OR (organization_id = ANY($2::text[]))
          ORDER BY updated_at DESC`,
        [userId || '', orgs],
    );
    return (rows || []).map((r) => mapRow(r, { includePayload: false }));
}

/** One template WITH its payload, or null. Visibility is the caller's job. */
async function getTemplateById(id) {
    await initDB();
    if (!isCapturedTemplateId(id)) return null;
    const row = await getOne('SELECT * FROM studio_app_templates WHERE id = $1', [id]);
    return mapRow(row);
}

/**
 * True when this user may install `template` (org member, or its creator).
 * @param template
 * @param {{ userId?: string, orgIds?: string[] }} [opts]
 */
function canRead(template, { userId, orgIds = [] } = {}) {
    if (!template) return false;
    if (template.createdBy === userId) return true;
    if (!template.organizationId) return false;
    return (Array.isArray(orgIds) ? orgIds : []).includes(template.organizationId);
}

/** Delete — creator only (the route additionally allows an org admin). */
async function deleteTemplate(id, userId, { force = false } = {}) {
    await initDB();
    const row = await getOne('SELECT * FROM studio_app_templates WHERE id = $1', [id]);
    if (!row) return { ok: false, notFound: true };
    if (!force && row.created_by !== userId) return { ok: false, forbidden: true };
    await run('DELETE FROM studio_app_templates WHERE id = $1', [id]);
    return { ok: true };
}

module.exports = {
    initDB,
    saveTemplate,
    listTemplatesFor,
    getTemplateById,
    deleteTemplate,
    canRead,
    isCapturedTemplateId,
    MAX_TEMPLATES_PER_ORG,
    _mapRow: mapRow,
};
