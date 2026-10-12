// @typecheck
/**
 * Document templates filed into a Solution (design D21), and the write guard
 * for templates a Solution stage manages.
 *
 * A template is filed through its own column, `studio_documents.solution_project_id`,
 * never through `project_id`: that column means "collaborative project content"
 * (every project editor may write it, `PROJECT_DOCUMENT_SQL`), and a template
 * keeps its own team sharing. The column and its partial index are created by
 * stores/documentStore.js, which owns the table; the functions live here so that
 * store does not grow past its size limit.
 *
 * Filing is the OWNER's act, for a template, a section or a designed document
 * (never a page), into a project of the document's own organisation. A filed
 * template grants no member access.
 *
 * A template filed into a STAGE project (UAT/PRD) is managed (stores/lib/managedParts.js):
 * its content changes only through a deploy, which carries `managedWrite`
 * ({ deploymentId }). `guardManagedLock` is the check documentStore.lockForWrite
 * runs on the row it locked, so updateDocument, restoreVersion and
 * createNamedVersion all pass through it.
 */

'use strict';

const crypto = require('crypto');
const contentCrypto = require('../lib/documentCrypto');
const { run, getOne, getAll, withTransaction } = contentCrypto.readingDb(require('../../db'));
const managedParts = require('../lib/managedParts');
const log = require('../../telemetry/log');
const versions = require('../documentVersions');

// The kinds a Solution carries as a template (design section 2).
const FILEABLE_KINDS = Object.freeze(['template', 'section', 'document']);
const PAGE_DOC_TYPE = 'page';

/** documentStore, required on use: it requires this module at load. */
const documentStore = () => require('../documentStore');

const failure = (message, status, code) => managedParts.storeError(status, code, message);

/** The stage capability check for one template write. */
function assertManaged(projectId, changedKeys, { managedWrite = null, client = null } = {}) {
    return managedParts.assertManagedWrite({ kind: 'document', projectId, changedKeys, managedWrite, client });
}

/**
 * The guard documentStore.lockForWrite runs on the row it locked. A template
 * filed into a stage project may only change what ALLOWED.document lists
 * (its sharing), unless the actor carries the deploy's capability.
 *
 * `a.changedKeysOf(row)` names the keys the write changes (updateDocument
 * passes it); without it the write is taken to change the content.
 *
 * @template {{ row: any }} L
 * @param {any} client
 * @param {L} locked
 * @param {{ changedKeysOf?: (row: any) => string[], managedWrite?: { deploymentId?: string }|null }} a
 * @returns {Promise<L>}
 */
async function guardManagedLock(client, locked, a) {
    const projectId = locked?.row?.solution_project_id;
    if (!projectId) return locked;
    const keys = typeof a?.changedKeysOf === 'function' ? a.changedKeysOf(locked.row) : ['content'];
    await assertManaged(projectId, keys, { managedWrite: a?.managedWrite || null, client });
    return locked;
}

/**
 * Refuse a write to a managed template by id (deleteVersion, archive), where
 * the caller locks nothing itself.
 *
 * @param {string} documentId
 * @param {string[]} changedKeys
 * @param {{ managedWrite?: { deploymentId?: string }|null, client?: any }} [opts]
 */
async function assertTemplateWrite(documentId, changedKeys, opts = {}) {
    if (!documentId) return { managed: false };
    const row = opts.client
        ? (await opts.client.query('SELECT solution_project_id FROM studio_documents WHERE id = $1', [documentId])).rows[0]
        : await getOne('SELECT solution_project_id FROM studio_documents WHERE id = $1', [documentId]);
    if (!row?.solution_project_id) return { managed: false };
    return assertManaged(row.solution_project_id, changedKeys, opts);
}

/**
 * What a document GET adds as `managed` (design 5.3): null, or the stage that
 * manages this template. A failed lookup answers null and is logged; a GET
 * never fails on it.
 *
 * @param {string} documentId
 */
async function managedOf(documentId) {
    if (!documentId) return null;
    try {
        const row = await getOne('SELECT solution_project_id FROM studio_documents WHERE id = $1', [documentId]);
        if (!row?.solution_project_id) return null;
        return await require('../solutionStageStore').managedPayloadFor({
            projectId: row.solution_project_id, kind: 'document', entityId: documentId,
        });
    } catch (err) {
        log.warn(`[SolutionTemplates] managed lookup for ${documentId} failed: ${err.message}`);
        return null;
    }
}

// ── Filing ───────────────────────────────────────────────────────────

/**
 * File a template into a Solution. Owner-only, matched in the statement: the
 * caller owns it, its kind is template/section/document, it is not a page
 * and not archived, and the project is of the document's own organisation.
 * Filing into or out of a stage project is a managed write.
 *
 * @param {string} documentId
 * @param {string} userId
 * @param {string} projectId
 * @param {{ managedWrite?: { deploymentId?: string }|null }} [opts]
 * @returns {Promise<boolean>}
 */
async function setTemplateSolution(documentId, userId, projectId, opts = {}) {
    await documentStore().initDB();
    if (!documentId || !userId || !projectId) return false;
    // Ownership first: someone else's template answers false, as it always
    // did, and never a managed_part that names the Solution it belongs to.
    if (!await getOne('SELECT id FROM studio_documents WHERE id = $1 AND user_id = $2', [documentId, userId])) return false;
    await assertManaged(projectId, ['solutionProjectId'], opts);
    await assertTemplateWrite(documentId, ['solutionProjectId'], opts);
    const { rowCount } = await run(
        `UPDATE studio_documents d SET solution_project_id = $1
          WHERE d.id = $2 AND d.user_id = $3 AND d.kind = ANY($4::text[]) AND d.doc_type <> $5
            AND d.archived = false
            AND EXISTS (SELECT 1 FROM projects p
                         WHERE p.id = $1 AND COALESCE(p.organization_id, '') = COALESCE(d.organization_id, ''))`,
        [projectId, documentId, userId, [...FILEABLE_KINDS], PAGE_DOC_TYPE],
    );
    return (rowCount || 0) > 0;
}

/**
 * Take a template out of ONE Solution. With `userId`, only when that person
 * owns it; with null, whoever owns it (the membership registry allows that only
 * the Solution's owner). Scoped to `projectId` either way.
 *
 * @param {string} documentId
 * @param {string} projectId
 * @param {string|null} [userId]
 * @param {{ managedWrite?: { deploymentId?: string }|null }} [opts]
 */
async function clearTemplateSolution(documentId, projectId, userId = null, opts = {}) {
    await documentStore().initDB();
    if (!documentId || !projectId) return false;
    await assertManaged(projectId, ['solutionProjectId'], opts);
    const { rowCount } = await run(
        `UPDATE studio_documents SET solution_project_id = NULL
          WHERE id = $1 AND solution_project_id = $2 AND ($3::text IS NULL OR user_id = $3)`,
        [documentId, projectId, userId],
    );
    return (rowCount || 0) > 0;
}

function mapCard(r) {
    return {
        id: r.id,
        name: r.name,
        docType: r.doc_type,
        kind: r.kind || 'document',
        userId: r.user_id,
        solutionProjectId: r.solution_project_id || null,
        versionId: r.version_id || null,
        updatedAt: r.updated_at,
        createdAt: r.created_at,
    };
}

/**
 * The templates filed into one Solution, as cards (no slots), newest first.
 *
 * @param {string} projectId
 */
async function listSolutionTemplates(projectId) {
    await documentStore().initDB();
    if (!projectId) return [];
    const rows = await getAll(
        `SELECT id, name, doc_type, kind, user_id, solution_project_id, version_id, created_at, updated_at
           FROM studio_documents
          WHERE solution_project_id = $1 AND archived = false
          ORDER BY updated_at DESC, id`,
        [projectId],
    );
    return rows.map(mapCard);
}

/**
 * How many templates each of these Solutions holds, in ONE query. A project
 * missing from the map holds none.
 *
 * @param {string[]} projectIds
 * @returns {Promise<Map<string, number>>}
 */
async function countSolutionTemplates(projectIds) {
    await documentStore().initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter((id) => typeof id === 'string' && id);
    if (!ids.length) return new Map();
    const rows = await getAll(
        `SELECT solution_project_id, COUNT(*)::int AS n FROM studio_documents
          WHERE solution_project_id = ANY($1::text[]) AND archived = false
          GROUP BY solution_project_id`,
        [ids],
    );
    return new Map(rows.map((r) => [r.solution_project_id, Number(r.n) || 0]));
}

/**
 * Detach every template from a deleted Solution. They stay their owners'
 * documents; deleting a project never deletes them.
 *
 * @param {string} projectId
 */
async function clearSolutionFromTemplates(projectId) {
    await documentStore().initDB();
    if (!projectId) return 0;
    const { rowCount } = await run('UPDATE studio_documents SET solution_project_id = NULL WHERE solution_project_id = $1', [projectId]);
    return rowCount || 0;
}

// ── Writes a deploy makes ───────────────────────────────────────────

/**
 * The carried fields of a template, from an allow-list (design section 2):
 * name, docType, description, bodyHtml, css, settings and kind. Ownership,
 * organisation, folder, categories and visibility are never taken from a release.
 */
function carriedFields(fields) {
    const f = fields && typeof fields === 'object' ? fields : {};
    const kind = FILEABLE_KINDS.includes(f.kind) ? f.kind : 'template';
    const docType = typeof f.docType === 'string' && f.docType ? f.docType : 'document';
    if (docType === PAGE_DOC_TYPE) throw failure('A page is never a Solution template.', 422, 'document_invalid');
    const settings = f.settings && typeof f.settings === 'object' && !Array.isArray(f.settings) ? { ...f.settings } : {};
    if (kind !== 'document') {
        delete settings.sampleValues;
        delete settings.sectionOverrides;
    }
    const out = {
        name: String(f.name || 'Untitled document').slice(0, 200),
        docType,
        description: String(f.description || '').slice(0, 2000),
        bodyHtml: typeof f.bodyHtml === 'string' ? f.bodyHtml : '',
        css: typeof f.css === 'string' ? f.css : '',
        settings,
        kind,
    };
    documentStore().assertWithinCaps(out);
    return out;
}

/**
 * Create or update a template in a stage project, on the deploy's client.
 * Without `id` the row is created (owned by `ownerId`, filed through
 * `solution_project_id`); with `id` the row filed in `projectId` is updated.
 * Each write is a new revision ('import'), which becomes the current one.
 *
 * @param {any} client  a transaction client ({ query })
 * @param {{ id?: string|null, ownerId: string, orgId?: string|null, projectId: string, fields: object }} input
 * @param {{ managedWrite?: { deploymentId?: string }|null }} [opts]
 * @returns {Promise<{ id: string, versionId: string, created: boolean }>}
 */
async function writeManagedTemplate(client, { id = null, ownerId, orgId = null, projectId, fields }, { managedWrite = null } = {}) {
    await documentStore().initDB();
    if (!projectId || !ownerId) throw failure('A template needs a project and an owner.', 422, 'document_invalid');
    client = contentCrypto.readingClient(client);
    await assertManaged(projectId, ['content'], { managedWrite, client });
    const carried = carriedFields(fields);
    const { mapRow } = documentStore();
    const versionId = crypto.randomUUID();
    if (!id) {
        const newId = crypto.randomUUID();
        const stored = await contentCrypto.sealFields({ body_html: carried.bodyHtml, css: carried.css, settings: carried.settings }, { type: 'document', id: newId, userId: ownerId, organizationId: orgId, projectId }, contentCrypto.DOCUMENT_FIELDS);
        await client.query(
            `INSERT INTO studio_documents
                (id, user_id, organization_id, name, doc_type, description, body_html, css, settings, kind, visibility,
                 folder_id, categories, version_id, baseline_version_id, solution_project_id, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'private',NULL,'[]'::jsonb,$11,$11,$12,$2)`,
            [newId, ownerId, orgId || null, carried.name, carried.docType, carried.description, stored.body_html,
                stored.css, JSON.stringify(stored.settings), carried.kind, versionId, projectId],
        );
        const { rows } = await client.query('SELECT * FROM studio_documents WHERE id = $1', [newId]);
        await versions.writeRevision(client, mapRow(rows[0]), { summary: 'Deployed', source: 'import', actorId: ownerId });
        return { id: newId, versionId, created: true };
    }
    const { rows: lockedRows } = await client.query(
        'SELECT * FROM studio_documents WHERE id = $1 AND solution_project_id = $2 FOR UPDATE', [id, projectId]);
    if (!lockedRows[0]) throw failure('Template not found in this stage.', 404, 'document_not_found');
    const previous = mapRow(lockedRows[0]);
    const stored = await contentCrypto.sealFields({ body_html: carried.bodyHtml, css: carried.css, settings: carried.settings }, { ...contentCrypto.resourceOf(lockedRows[0]), projectId }, contentCrypto.DOCUMENT_FIELDS);
    const { rows } = await client.query(
        `UPDATE studio_documents SET name=$2, doc_type=$3, description=$4, body_html=$5, css=$6, settings=$7, kind=$8,
                version_id=$9, updated_by=$10, updated_at=NOW()
          WHERE id=$1 RETURNING *`,
        [id, carried.name, carried.docType, carried.description, stored.body_html, stored.css,
            JSON.stringify(stored.settings), carried.kind, versionId, ownerId],
    );
    await versions.writeRevision(client, mapRow(rows[0]), { summary: 'Deployed', source: 'import', actorId: ownerId }, previous);
    return { id, versionId, created: false };
}

/**
 * Write one revision row for a template WITHOUT making it current: the
 * version a stage `fill_document` step is pinned to. The document row keeps
 * its content and its current revision; the new row carries the given body,
 * stylesheet and settings.
 *
 * @param {string} documentId
 * @param {{ bodyHtml?: string, css?: string, settings?: object, summary?: string }} content
 * @param {{ managedWrite?: { deploymentId?: string }|null, client?: any, actorId?: string|null }} [opts]
 * @returns {Promise<string|null>} the version id, or null when there is no such document
 */
async function createVersionRow(documentId, { bodyHtml = '', css = '', settings = {}, summary = 'Release' } = {}, opts = {}) {
    await documentStore().initDB();
    const { mapRow, assertWithinCaps } = documentStore();
    assertWithinCaps({ bodyHtml, css });
    const write = async (client) => {
        const { rows } = await client.query('SELECT * FROM studio_documents WHERE id = $1 FOR UPDATE', [documentId]);
        if (!rows[0]) return null;
        if (rows[0].solution_project_id) {
            await assertManaged(rows[0].solution_project_id, ['content'], { managedWrite: opts.managedWrite || null, client });
        }
        const current = mapRow(rows[0]);
        const cleanSettings = settings && typeof settings === 'object' && !Array.isArray(settings) ? { ...settings } : {};
        if (current.kind !== 'document') {
            delete cleanSettings.sampleValues;
            delete cleanSettings.sectionOverrides;
        }
        const revision = {
            ...current, bodyHtml: String(bodyHtml ?? ''), css: String(css ?? ''), settings: cleanSettings,
            versionId: crypto.randomUUID(),
        };
        const written = await versions.writeRevision(client, revision, {
            summary: String(summary || 'Release'), source: 'import', actorId: opts.actorId ?? current.userId ?? null,
        });
        return written.id;
    };
    return opts.client ? write(opts.client) : withTransaction(write);
}

module.exports = {
    FILEABLE_KINDS,
    guardManagedLock,
    assertTemplateWrite,
    managedOf,
    setTemplateSolution,
    clearTemplateSolution,
    listSolutionTemplates,
    countSolutionTemplates,
    clearSolutionFromTemplates,
    writeManagedTemplate,
    createVersionRow,
};
