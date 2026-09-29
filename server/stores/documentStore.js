// @typecheck
/**
 * Document Store — rendered documents (invoices, quotes, letters) as two text
 * slots: the body markup and the stylesheet.
 *
 * WHY NOT RustFS, when webpages uses it. A webpage is a project: three slots,
 * arbitrary extra files, binary assets, a SQLite database, version snapshots of
 * all of it. An invoice is a page of markup and a stylesheet — kilobytes, read
 * on every render, never streamed. Putting those in Postgres removes a network
 * round-trip per read AND removes a hard dependency: webpageStore.writeSlot
 * throws outright when RustFS is unconfigured, which would make documents
 * unavailable on a self-host that never set object storage up. The size caps
 * below are what keeps that honest.
 *
 * WHY THE TABLES ARE `studio_documents` AND NOT `documents`. That name was
 * already taken — stores/knowledgeBases.js owns a `documents` table for
 * knowledge-base source documents (tenant_id, knowledge_base_id, chunk_count).
 * Claiming it here did not collide loudly: `CREATE TABLE IF NOT EXISTS` simply
 * did nothing, and the first `CREATE INDEX ... (user_id)` then failed against
 * somebody else's schema, so every create answered `column "user_id" does not
 * exist`. The prefix matches the route (/api/studio-documents) and the Studio
 * section, which is where the rest of this feature already lives.
 *
 * WHAT A SLOT HOLDS. `bodyHtml` is the document's BODY markup only — no
 * <html>, <head> or <body> wrapper, no <style>. `css` is the stylesheet,
 * including the @page rules that decide paper size and margins. The wrapper is
 * built at render time by services/documentCompose.js, which is what lets the
 * hand-editor round-trip: what contenteditable hands back IS body.innerHTML, so
 * it maps onto the slot with nothing to parse out.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec, withTransaction } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');

// A document is a person-sized artefact. 512 KB of markup is already a very
// long invoice; the cap exists so a runaway model or a paste-bomb cannot turn
// a Postgres row into something the PDF renderer will choke on anyway.
const MAX_HTML_BYTES = 512 * 1024;
const MAX_CSS_BYTES = 128 * 1024;

// The kinds the UI knows how to label and the model is told to pick from. An
// unknown value is stored as 'document' rather than rejected — the type is a
// display hint, never a permission. ONE of them changes what the slots hold:
// a 'presentation' keeps a slide OUTLINE (the deck markdown of
// core/documents/deckModel.js) in the body slot and nothing in `css`, and
// renders through core/documents/deckDocument.js instead of the composer.
const DOC_TYPES = Object.freeze(['invoice', 'quote', 'letter', 'report', 'security', 'document', 'presentation']);
const DEFAULT_DOC_TYPE = 'document';
const DECK_DOC_TYPE = 'presentation';

// A presentation's settings may carry a template deck (two backdrop pictures
// and a logo, as data: URLs — see core/documents/pptxTemplate.js), which a
// letter never needs. The cap is per type so a deck can hold its own template
// without every invoice being allowed to grow to it.
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_DECK_SETTINGS_BYTES = 4 * 1024 * 1024;

function normaliseType(t) {
    return DOC_TYPES.includes(t) ? t : DEFAULT_DOC_TYPE;
}

const initDB = makeStoreInit('DocumentStore', async () => {
    await exec(`
        CREATE TABLE IF NOT EXISTS studio_documents (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT 'Untitled document',
            doc_type TEXT NOT NULL DEFAULT 'document',
            description TEXT DEFAULT '',
            body_html TEXT NOT NULL DEFAULT '',
            css TEXT NOT NULL DEFAULT '',
            settings JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_documents_user ON studio_documents(user_id);
        CREATE INDEX IF NOT EXISTS idx_studio_documents_updated ON studio_documents(user_id, updated_at DESC);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS studio_document_versions (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES studio_documents(id) ON DELETE CASCADE,
            summary TEXT DEFAULT '',
            body_html TEXT NOT NULL DEFAULT '',
            css TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_studio_document_versions_doc
            ON studio_document_versions(document_id, created_at DESC);
    `);
    await exec(`
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS organization_id TEXT;
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'document';
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS folder_id TEXT;
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS categories JSONB NOT NULL DEFAULT '[]';
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS version_id TEXT;
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS baseline_version_id TEXT;
        ALTER TABLE studio_documents ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE studio_document_versions ADD COLUMN IF NOT EXISTS snapshot JSONB;
        CREATE TABLE IF NOT EXISTS studio_document_folders (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, parent_id TEXT REFERENCES studio_document_folders(id)
        );
        CREATE INDEX IF NOT EXISTS idx_studio_documents_library ON studio_documents(organization_id, visibility, kind);
        UPDATE studio_documents d SET organization_id = u."organizationId" FROM users u
            WHERE d.user_id = u.id AND d.organization_id IS NULL;
        UPDATE studio_documents SET version_id = 'baseline-' || id, baseline_version_id = 'baseline-' || id WHERE version_id IS NULL;
        INSERT INTO studio_document_versions(id, document_id, summary, body_html, css, snapshot)
            SELECT version_id, id, 'Initial revision', body_html, css,
                jsonb_build_object('id', id, 'userId', user_id, 'name', name, 'docType', doc_type,
                    'description', description, 'bodyHtml', body_html, 'css', css, 'settings', settings,
                    'kind', kind, 'versionId', version_id, 'organizationId', organization_id)
            FROM studio_documents ON CONFLICT (id) DO NOTHING;
    `);
    // Complete legacy history and freeze branding during migration, before an
    // organization can change it. Later reads must never mutate a pinned version.
    let afterId = '';
    for (;;) {
        const revisions = await getAll(`SELECT v.id, v.body_html, v.css, v.snapshot,
                b.snapshot AS baseline, d.organization_id
            FROM studio_document_versions v
            JOIN studio_documents d ON d.id = v.document_id
            JOIN studio_document_versions b ON b.id = d.baseline_version_id
            WHERE v.id > $1 AND (v.snapshot IS NULL OR NOT (COALESCE(v.snapshot->'settings','{}'::jsonb) ? 'resolvedHouseStyleCss'))
            ORDER BY v.id LIMIT 100`, [afterId]);
        if (!revisions.length) break;
        for (const revision of revisions) {
            const snapshot = { ...(revision.snapshot || revision.baseline), bodyHtml: revision.body_html, css: revision.css, versionId: revision.id };
            snapshot.settings = { ...snapshot.settings, resolvedHouseStyleCss: await require('../core/documents/renderFilledDocument').houseStyleCssFor(snapshot, revision.organization_id) };
            await run(`UPDATE studio_document_versions SET snapshot = $2::jsonb WHERE id = $1
                AND (snapshot IS NULL OR NOT (COALESCE(snapshot->'settings','{}'::jsonb) ? 'resolvedHouseStyleCss'))`, [revision.id, JSON.stringify(snapshot)]);
        }
        afterId = revisions.at(-1).id;
    }
    await exec(`UPDATE studio_documents d SET settings = COALESCE(d.settings,'{}'::jsonb)
            || jsonb_build_object('resolvedHouseStyleCss',v.snapshot->'settings'->'resolvedHouseStyleCss')
        FROM studio_document_versions v WHERE v.id = d.version_id
            AND NOT (COALESCE(d.settings,'{}'::jsonb) ? 'resolvedHouseStyleCss')`);
});

// Kick init off at require time — migrateDb.js and boot both depend on it.

function mapRow(row) {
    if (!row) return null;
    let settings = {};
    if (row.settings) {
        settings = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings;
    }
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        docType: row.doc_type,
        description: row.description || '',
        bodyHtml: row.body_html || '',
        css: row.css || '',
        settings,
        organizationId: row.organization_id || null,
        kind: row.kind || 'document', visibility: row.visibility || 'private',
        folderId: row.folder_id || null, categories: row.categories || [],
        versionId: row.version_id || null, baselineVersionId: row.baseline_version_id || null,
        archived: row.archived === true,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * The list row deliberately omits the slots. A documents list renders names,
 * types and dates; shipping every document's full markup to paint a list is
 * the kind of thing that only hurts once somebody has three hundred of them.
 */
function mapListRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        docType: row.doc_type,
        description: row.description || '',
        kind: row.kind || 'document', visibility: row.visibility || 'private',
        folderId: row.folder_id || null, categories: row.categories || [], versionId: row.version_id,
        htmlSize: Number(row.html_size) || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * Refuse oversized slot content rather than truncating it. A silently cut-off
 * invoice is worse than an error: it looks complete and is missing its total.
 */
/** @param {{ bodyHtml?: string, css?: string }} slots */
function assertWithinCaps({ bodyHtml, css }) {
    if (typeof bodyHtml === 'string' && Buffer.byteLength(bodyHtml, 'utf8') > MAX_HTML_BYTES) {
        throw Object.assign(
            new Error(`The document body is larger than the ${Math.round(MAX_HTML_BYTES / 1024)} KB limit.`),
            { errorClass: 'document_too_large', status: 413 },
        );
    }
    if (typeof css === 'string' && Buffer.byteLength(css, 'utf8') > MAX_CSS_BYTES) {
        throw Object.assign(
            new Error(`The document stylesheet is larger than the ${Math.round(MAX_CSS_BYTES / 1024)} KB limit.`),
            { errorClass: 'document_too_large', status: 413 },
        );
    }
}

// ── CRUD ─────────────────────────────────────────────────────────────

function actor(context) { return typeof context === 'string' ? { userId: context } : context; }
const { normalizeContract, getContract } = require('../core/documents/documentContract');
const failure = (message, status = 422, errorClass = 'document_invalid') => Object.assign(new Error(message), { status, errorClass });
function metadata(input) {
    if (input.settings != null && (typeof input.settings !== 'object' || Array.isArray(input.settings))) throw failure('Settings must be an object');
    input.settings ||= {};
    if (!['document', 'template', 'section'].includes(input.kind || 'document')) throw failure('Invalid document kind');
    if (!['private', 'team'].includes(input.visibility || 'private')) throw failure('Invalid visibility');
    if (input.visibility === 'team' && input.kind === 'document') throw failure('Only templates and sections can be shared');
    if (input.settings?.contract) input.settings.contract = normalizeContract(input.settings.contract);
    if (input.kind !== 'document' && input.settings) {
        input.settings = { ...input.settings }; delete input.settings.sampleValues; delete input.settings.sectionOverrides;
    }
    const isDeck = normaliseType(input.docType) === DECK_DOC_TYPE;
    if (isDeck) {
        // The per-deck look is validated the way a routine's overrides are: an
        // unknown key or a bad colour is dropped, never an error, and '' means
        // "as the house style has it" — so only real choices are stored.
        const { normaliseDeckOverrides } = require('../core/documents/deckThemeOptions');
        input.settings = { ...input.settings, deck: normaliseDeckOverrides(input.settings.deck) };
        if (input.kind === 'section') throw failure('A presentation cannot be a reusable section');
    }
    const cap = isDeck ? MAX_DECK_SETTINGS_BYTES : MAX_SETTINGS_BYTES;
    if (Buffer.byteLength(JSON.stringify(input.settings || {})) > cap) throw failure(`Document settings exceed ${Math.round(cap / 1024)} KB`);
    input.categories = [...new Set((Array.isArray(input.categories) ? input.categories : []).map(x => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, 30);
    return input;
}
async function createDocument(input) {
    await initDB();
    const d = metadata({ ...input }); assertWithinCaps(d);
    const id = crypto.randomUUID(); const versionId = crypto.randomUUID();
    // Verify membership even when a trusted caller supplies an organization.
    const owner = await getOne('SELECT "organizationId" FROM users WHERE id = $1', [d.userId]);
    const org = d.organizationId || owner?.organizationId || null;
    if (d.organizationId && owner?.organizationId !== d.organizationId) throw failure('Organization mismatch', 403);
    if (d.visibility === 'team' && !org) throw failure('Team libraries require an organization');
    if (d.folderId) await assertFolder(d.folderId, d.userId);
    const doc = { id, userId: d.userId, organizationId: org, name: d.name || 'Untitled document',
        docType: normaliseType(d.docType), description: d.description || '', bodyHtml: d.bodyHtml || '', css: d.css || '',
        settings: d.settings || {}, kind: d.kind || 'document', visibility: d.visibility || 'private',
        folderId: d.folderId || null, categories: d.categories, versionId, baselineVersionId: versionId };
    doc.settings = { ...doc.settings, resolvedHouseStyleCss: await require('../core/documents/renderFilledDocument').houseStyleCssFor(doc,org) };
    return withTransaction(async client => {
        const { rows } = await client.query(`INSERT INTO studio_documents
            (id,user_id,organization_id,name,doc_type,description,body_html,css,settings,kind,visibility,folder_id,categories,version_id,baseline_version_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`,
        [id,d.userId,org,doc.name,doc.docType,doc.description,doc.bodyHtml,doc.css,JSON.stringify(doc.settings),doc.kind,doc.visibility,doc.folderId,JSON.stringify(doc.categories),versionId]);
        await writeRevision(client, doc, 'Created');
        return rows[0] ? mapRow(rows[0]) : doc;
    });
}
function accessSql(alias = 'd', write = false) {
    return `((${alias}.user_id = $2 AND (${alias}.organization_id IS NULL OR ${alias}.organization_id = (SELECT "organizationId" FROM users WHERE id = $2))) OR (${alias}.visibility = 'team' AND ${alias}.kind IN ('template','section')
        AND ${alias}.organization_id = (SELECT "organizationId" FROM users WHERE id = $2)${write ? ' AND $3::boolean' : ''}))`;
}
async function getDocument(documentId, context) {
    await initDB(); const a = actor(context);
    return mapRow(await getOne(`SELECT d.* FROM studio_documents d WHERE d.id = $1 AND ${accessSql()}`, [documentId, a.userId]));
}
async function getDocumentVersion(documentId, context, versionId) {
    const doc = await getDocument(documentId, context);
    if (!doc) return null;
    const id = versionId || doc.baselineVersionId || doc.versionId;
    const v = await getOne('SELECT * FROM studio_document_versions WHERE id = $1 AND document_id = $2', [id, documentId]);
    if (!v) return null;
    const snapshot = typeof v.snapshot === 'string' ? JSON.parse(v.snapshot) : v.snapshot;
    return { ...doc, ...(snapshot || { bodyHtml: v.body_html, css: v.css }), versionId: id };
}
async function listDocuments(context, options = {}) {
    await initDB(); const a = actor(context);
    const { limit = 50, offset = 0, query = '', kind, visibility, folderId, category, sort } = options;
    const params = [null, a.userId]; const where = [accessSql(), 'd.archived = false'];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', '$' + params.length)); };
    if (query) add('(d.name ILIKE ? OR d.description ILIKE ?)', '%' + String(query).slice(0, 200) + '%');
    // A search uses the same parameter for both columns.
    if (query) where[where.length - 1] = where.at(-1).replace('?', '$' + params.length);
    if (kind) add('d.kind = ?', kind);
    else if (options.onlyFillable) where.push("d.kind != 'section'");
    // `docType` narrows to one type; 'page' is every type that is NOT a
    // presentation — the two halves of the library.
    if (options.docType === 'page') add('d.doc_type <> ?', DECK_DOC_TYPE);
    else if (options.docType && DOC_TYPES.includes(options.docType)) add('d.doc_type = ?', options.docType);
    if (visibility) add('d.visibility = ?', visibility);
    if (folderId !== undefined) folderId ? add('d.folder_id = ?', folderId) : where.push('d.folder_id IS NULL');
    if (category) add('d.categories @> ?::jsonb', JSON.stringify([category]));
    params[0] = Math.min(Math.max(Number(limit) || 50, 1), 200);
    params.push(Math.max(Number(offset) || 0, 0));
    const order = sort === 'name' ? 'd.name ASC, d.id' : 'd.updated_at DESC, d.id';
    const rows = await getAll(`SELECT d.*, OCTET_LENGTH(d.body_html) AS html_size FROM studio_documents d
        WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $1 OFFSET $${params.length}`, params);
    return rows.map(mapListRow);
}
async function listTemplates(context, options = {}) {
    const list = await listDocuments(context, { ...options, onlyFillable:true });
    return Promise.all(list.filter(d => d.kind !== 'section').map(async d => {
        const doc = await getDocument(d.id, context);
        return { ...d, ...getContract(doc), placeholders: getContract(doc).placeholders };
    }));
}
async function writeRevision(client, doc, summary) {
    await client.query(`INSERT INTO studio_document_versions(id, document_id, summary, body_html, css, snapshot)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
    [doc.versionId,doc.id,String(summary || '').slice(0,500),doc.bodyHtml,doc.css,JSON.stringify(doc)]);
}
async function updateDocument(documentId, context, updates = {}) {
    await initDB(); const a = actor(context); assertWithinCaps(updates);
    return withTransaction(async client => {
        const { rows } = await client.query(`SELECT d.* FROM studio_documents d WHERE d.id = $1 AND ${accessSql('d', true)} FOR UPDATE`, [documentId,a.userId,a.isAdmin === true]);
        if (!rows[0]) return null;
        const current = mapRow(rows[0]);
        if (updates.expectedVersionId && updates.expectedVersionId !== current.versionId) throw failure('This document changed. Reload or recover your changes before saving.', 409, 'document_conflict');
        const keys = ['name','docType','description','bodyHtml','css','settings','kind','visibility','folderId','categories'];
        const next = metadata({ ...current, ...Object.fromEntries(keys.filter(k => updates[k] !== undefined).map(k => [k,updates[k]])) });
        if (!Object.hasOwn(next.settings,'resolvedHouseStyleCss') && typeof current.settings.resolvedHouseStyleCss === 'string') {
            next.settings = {...next.settings,resolvedHouseStyleCss:current.settings.resolvedHouseStyleCss};
        }
        if (next.settings.houseStyle !== current.settings.houseStyle) { next.settings = { ...next.settings }; delete next.settings.resolvedHouseStyleCss; }
        if (next.visibility === 'team' && !current.organizationId) throw failure('Team libraries require an organization');
        if (next.folderId) await assertFolder(next.folderId, current.userId);
        if (keys.every(k => JSON.stringify(current[k]) === JSON.stringify(next[k]))) return current;
        const { houseStyleCssFor } = require('../core/documents/renderFilledDocument');
        next.settings = { ...next.settings, resolvedHouseStyleCss: await houseStyleCssFor(next, next.organizationId) };
        next.versionId = crypto.randomUUID();
        const result = await client.query(`UPDATE studio_documents SET name=$2,doc_type=$3,description=$4,body_html=$5,css=$6,settings=$7,
            kind=$8,visibility=$9,folder_id=$10,categories=$11,version_id=$12,updated_at=NOW() WHERE id=$1 RETURNING *`,
        [documentId,String(next.name).slice(0,200),normaliseType(next.docType),String(next.description).slice(0,2000),next.bodyHtml,next.css,JSON.stringify(next.settings),next.kind,next.visibility,next.folderId,JSON.stringify(next.categories),next.versionId]);
        await writeRevision(client, next, updates.summary || 'Edited');
        return mapRow(result.rows[0]);
    });
}
async function deleteDocument(documentId, context) {
    await initDB(); const a = actor(context);
    const result = await run(`UPDATE studio_documents d SET archived = true WHERE d.id = $1 AND ${accessSql('d', true)}`, [documentId,a.userId,a.isAdmin === true]);
    return (result?.rowCount || 0) > 0;
}
async function assertFolder(id, userId) {
    if (!await getOne('SELECT id FROM studio_document_folders WHERE id = $1 AND user_id = $2', [id,userId])) throw failure('Folder not found',404);
}
async function listFolders(userId) { await initDB(); return getAll('SELECT id, name, parent_id AS "parentId" FROM studio_document_folders WHERE user_id = $1 ORDER BY name', [userId]); }
async function createFolder(userId, name, parentId = null) {
    await initDB(); if (!String(name || '').trim()) throw failure('Folder name is required');
    if (parentId) await assertFolder(parentId,userId);
    const id = crypto.randomUUID();
    await run('INSERT INTO studio_document_folders(id,user_id,name,parent_id) VALUES ($1,$2,$3,$4)', [id,userId,String(name).trim().slice(0,200),parentId]);
    return { id, name, parentId };
}
async function deleteFolder(userId, id) {
    await initDB();
    return withTransaction(async client => {
        const { rows } = await client.query('SELECT * FROM studio_document_folders WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId]);
        if (!rows[0]) throw failure('Folder not found',404);
        await client.query('UPDATE studio_documents SET folder_id=$2 WHERE folder_id=$1 AND user_id=$3',[id,rows[0].parent_id,userId]);
        await client.query('UPDATE studio_document_folders SET parent_id=$2 WHERE parent_id=$1 AND user_id=$3',[id,rows[0].parent_id,userId]);
        await client.query('DELETE FROM studio_document_folders WHERE id=$1 AND user_id=$2',[id,userId]);
    });
}

// ── Versions ─────────────────────────────────────────────────────────

/**
 * Compatibility entry point. Edits and their complete immutable revision are
 * committed together by updateDocument; callers cannot create partial history.
 */
async function snapshotVersion(documentId, context) {
    // Revisions are created atomically by updateDocument. Kept for old callers.
    const doc = await getDocument(documentId, context);
    return doc ? { id: doc.versionId, documentId } : null;
}
async function listVersions(documentId, context, { limit = 50 } = {}) {
    if (!await getDocument(documentId, context)) return [];
    const rows = await getAll('SELECT id,summary,created_at FROM studio_document_versions WHERE document_id=$1 ORDER BY created_at DESC LIMIT $2',[documentId,limit]);
    return rows.map(r => ({ id:r.id, summary:r.summary, createdAt:r.created_at }));
}
async function restoreVersion(documentId, context, versionId, expectedVersionId) {
    const v = await getDocumentVersion(documentId,context,versionId);
    if (!v) return null;
    return updateDocument(documentId,context,{ name:v.name,docType:v.docType,description:v.description,bodyHtml:v.bodyHtml,css:v.css,settings:v.settings,expectedVersionId,summary:'Restored revision' });
}

module.exports = {
    getDocumentVersion, listFolders, createFolder, deleteFolder,
    DOC_TYPES,
    DEFAULT_DOC_TYPE,
    DECK_DOC_TYPE,
    MAX_SETTINGS_BYTES,
    MAX_DECK_SETTINGS_BYTES,
    MAX_HTML_BYTES,
    MAX_CSS_BYTES,
    initDB,
    createDocument,
    listDocuments,
    listTemplates,
    getDocument,
    updateDocument,
    deleteDocument,
    snapshotVersion,
    listVersions,
    restoreVersion,
    _test: { mapRow, mapListRow, normaliseType, assertWithinCaps },
};
