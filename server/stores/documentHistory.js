// @typecheck
/**
 * A Studio document's history, as the uniform versions API reads and writes
 * it (list, read one, name, checkpoint, restore, delete), and the two hooks
 * the live co-editing layer calls for a page (writeCollabBody, recordVersion).
 *
 * Built by stores/documentStore.js over its own access rules
 * (`makeDocumentHistory(deps)`): who may read a document and who may write it
 * are decided there, once, and every function here asks through them. The
 * revision rows themselves are documentVersions.js's.
 *
 *   read    anybody who may read the document (a project viewer included)
 *   write   its owner, an org admin for a team template or section, and the
 *           editors and owner of the project it is filed in
 *   delete  a version: the document's OWNER only
 *
 * A template filed into a Solution stage (solution_project_id) is managed:
 * restore and naming go through documentStore.lockForWrite, which refuses
 * them (409 managed_part), and deleteVersion asks the same guard.
 */

'use strict';

const crypto = require('crypto');
const versions = require('./documentVersions');
const solutionTemplates = require('./document/solutionTemplates');

/**
 * @param {object} deps
 * @param {Function} deps.initDB
 * @param {Function} deps.withTransaction
 * @param {(sql: string, params: any[]) => Promise<any[]>} deps.getAll
 * @param {Function} deps.getOne
 * @param {Function} deps.run
 * @param {Function} deps.getDocument          (id, context) => document | null (read access)
 * @param {Function} deps.getDocumentVersion   (id, context, versionId) => document at that revision | null
 * @param {Function} deps.updateDocument       (id, context, updates) => document | null (write access)
 * @param {Function} deps.lockForWrite         (client, id, actor) => { row, asMember } | null
 * @param {Function} deps.mapRow
 * @param {Function} deps.sanitizePageBody
 * @param {Function} deps.assertWithinCaps
 * @param {Function} deps.failure              (message, status, errorClass) => Error
 * @param {string}   deps.PAGE_DOC_TYPE
 */
function makeDocumentHistory(deps) {
    const { initDB, withTransaction, getAll, getOne, run, getDocument, getDocumentVersion, updateDocument,
        lockForWrite, mapRow, sanitizePageBody, assertWithinCaps, failure, PAGE_DOC_TYPE } = deps;
    const actorOf = (context) => (typeof context === 'string' ? { userId: context } : context || {});
    const cleanName = (name) => {
        if (name == null) return null;
        const text = String(name).replace(/\s+/g, ' ').trim();
        if (!text) return null;
        if (text.length > versions.MAX_VERSION_NAME) throw failure(`A version name is at most ${versions.MAX_VERSION_NAME} characters.`, 422, 'version_name_invalid');
        return text;
    };

    /** One page of the history, newest first; null when the caller may not read the document. */
    async function listVersions(documentId, context, options = {}) {
        if (!await getDocument(documentId, context)) return null;
        return versions.listRows(getAll, documentId, options);
    }

    /**
     * One version with its content. `ref` is a version id, or 'current' for
     * the document as it is now (described by the row its revision id names).
     */
    async function getVersion(documentId, context, ref) {
        const doc = await getDocument(documentId, context);
        if (!doc) return null;
        const id = ref === 'current' ? doc.versionId : ref;
        const row = id ? await getOne(`SELECT ${versions.META_COLUMNS}, body_html, css FROM studio_document_versions
            WHERE id = $1 AND document_id = $2`, [id, documentId]) : null;
        if (ref !== 'current' && !row) return null;
        const meta = versions.mapVersion(row) || {
            id: doc.versionId, seq: null, source: 'legacy', name: null, summary: '', createdAt: doc.updatedAt,
            createdBy: doc.updatedBy || doc.userId, contributors: [], stats: null, pinned: false, restoredFrom: null,
        };
        const html = ref === 'current' ? doc.bodyHtml : (row.body_html || '');
        return { document: doc, version: { ...meta, content: { html, markdown: null } } };
    }

    /**
     * Name the document's current state. When the newest row already holds
     * exactly this state it is that row that gets the name; otherwise (a page
     * edited live moved on since its last checkpoint) a new 'named' row is
     * written and becomes the current revision.
     */
    async function createNamedVersion(documentId, context, name) {
        await initDB();
        const label = cleanName(name);
        if (!label) throw failure('Give the version a name.', 422, 'version_name_invalid');
        const a = actorOf(context);
        return withTransaction(async (client) => {
            const locked = await lockForWrite(client, documentId, a);
            if (!locked) return null;
            const current = mapRow(locked.row);
            const head = await versions.headRow(client, documentId, current.versionId);
            if (head && head.content_hash === versions.contentHash(current)) {
                const { rows } = await client.query(`UPDATE studio_document_versions SET name = $3, superseded_by = NULL
                    WHERE id = $1 AND document_id = $2 RETURNING ${versions.META_COLUMNS}`, [head.id, documentId, label]);
                return versions.mapVersion(rows[0]);
            }
            const saved = { ...current, versionId: crypto.randomUUID() };
            await client.query('UPDATE studio_documents SET version_id = $2 WHERE id = $1', [documentId, saved.versionId]);
            await versions.writeRevision(client, saved, { summary: 'Named version', source: 'named', name: label, actorId: a.userId || null }, current);
            const { rows } = await client.query(`SELECT ${versions.META_COLUMNS} FROM studio_document_versions WHERE id = $1`, [saved.versionId]);
            return versions.mapVersion(rows[0]);
        });
    }

    /** Give a version a name, or take it away (null). Undefined when the version does not exist. */
    async function nameVersion(documentId, context, ref, name) {
        await initDB();
        const label = cleanName(name);
        const a = actorOf(context);
        return withTransaction(async (client) => {
            const locked = await lockForWrite(client, documentId, a);
            if (!locked) return null;
            const id = ref === 'current' ? locked.row.version_id : ref;
            // A named version is always listed, so naming a row folded into an
            // autosave session brings it back into the list.
            const { rows } = await client.query(`UPDATE studio_document_versions
                SET name = $3::text, superseded_by = CASE WHEN $3::text IS NULL THEN superseded_by ELSE NULL END
                WHERE id = $1 AND document_id = $2 RETURNING ${versions.META_COLUMNS}`, [id, documentId, label]);
            return rows[0] ? versions.mapVersion(rows[0]) : undefined;
        });
    }

    /**
     * Put an earlier version back, as a new version ('restore', pointing at the
     * one restored); the state it replaces stays in the history ('pre_restore'
     * when it had no row of its own). Null when the caller may not read the
     * document or the version does not exist; the store's own refusals (a
     * viewer, a stale expectedVersionId) are thrown.
     */
    /**
     * @param {string} documentId
     * @param {any} context
     * @param {string} ref
     * @param {{ expectedVersionId?: string }} [options]
     */
    async function restoreVersion(documentId, context, ref, { expectedVersionId } = {}) {
        const v = await getDocumentVersion(documentId, context, ref);
        if (!v) return null;
        const updated = await updateDocument(documentId, context, {
            name: v.name, description: v.description, bodyHtml: v.bodyHtml, css: v.css, settings: v.settings,
            expectedVersionId, summary: 'Restored revision', source: 'restore', restoredFrom: ref,
        });
        if (!updated) return updated;
        const row = await getOne(`SELECT ${versions.META_COLUMNS} FROM studio_document_versions WHERE id = $1 AND document_id = $2`,
            [updated.versionId, documentId]);
        return { current: updated, version: versions.mapVersion(row) };
    }

    /**
     * Delete one version. The document's owner only, and never the current
     * revision, the baseline an automation falls back to, or a revision something
     * else pins: `referencedIds` (the ids an automation or an app step prints, which
     * only the caller can collect; an iterable, or a function answering one, so
     * the lookup runs only for the owner) would otherwise fail on its next run.
     *
     * @param {string} documentId @param {string} userId @param {string} ref
     * @param {{ referencedIds?: Iterable<string> | (() => Promise<Iterable<string>>) }} [options]
     */
    async function deleteVersion(documentId, userId, ref, { referencedIds = [] } = {}) {
        const doc = await getDocument(documentId, userId);
        if (!doc) return null;
        if (doc.userId !== userId) throw failure('Only the owner of this document can delete versions of it.', 403, 'document_owner_only');
        // A template a Solution stage manages keeps the revisions its automations are pinned to.
        await solutionTemplates.assertTemplateWrite(documentId, ['versions']);
        if (ref === doc.versionId || ref === doc.baselineVersionId) {
            throw failure('This version is the document\'s current or first revision and stays.', 409, 'version_in_use');
        }
        const pinned = new Set(typeof referencedIds === 'function' ? await referencedIds() : referencedIds);
        if (pinned.has(ref)) {
            throw failure('An automation or an app uses this version of the document, so it stays.', 409, 'version_in_use');
        }
        const result = await run('DELETE FROM studio_document_versions WHERE id = $1 AND document_id = $2', [ref, documentId]);
        return (result?.rowCount || 0) > 0;
    }

    // ── Live co-editing (pages) ─────────────────────────────────────────
    //
    // Called by the co-editing layer (server/core/collab) with a document it
    // has already authorised: the live state materialised as HTML. Only a page
    // is ever edited live; any other document is left alone (null).

    /**
     * The live state as the page's stored body, without a new version.
     *
     * @param {string} documentId
     * @param {{ html?: string }} [input]
     */
    async function writeCollabBody(documentId, { html } = {}) {
        await initDB();
        const body = sanitizePageBody(html);
        assertWithinCaps({ bodyHtml: body });
        return withTransaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM studio_documents WHERE id = $1 AND doc_type = $2 FOR UPDATE', [documentId, PAGE_DOC_TYPE]);
            if (!rows[0]) return null;
            const contentCrypto = require('./lib/documentCrypto');
            const storedBody = await contentCrypto.seal(body, contentCrypto.resourceOf(rows[0]), 'body_html');
            const { rows: saved } = await client.query('UPDATE studio_documents SET body_html = $2, updated_at = NOW() WHERE id = $1 RETURNING version_id', [documentId, storedBody]);
            return saved[0] ? { versionId: saved[0].version_id } : null;
        });
    }

    /**
     * A checkpoint of the live state as a version: a revision row that
     * becomes the current revision. Skipped when it is exactly the newest
     * version already (and not being named).
     *
     * It never writes the stored body. While a page is edited live the body
     * is the live state's mirror, and its one writer is the co-editing
     * layer's materialise (writeCollabBody), under the document's mirror
     * lease and only over an older state. A checkpoint built from a state
     * loaded a moment earlier would otherwise put that older text back over
     * a newer mirror (an AI edit's, a restore's) while the co-editing layer
     * went on believing the mirror current, and nothing would repair it.
     *
     * @param {string} documentId
     * @param {{ html?: string, source?: string, name?: string|null, contributors?: Array<object>, stats?: object|null,
     *           createdBy?: string|null, restoredFrom?: string|null }} [input]
     */
    async function recordVersion(documentId, { html, source = 'checkpoint', name = null, contributors = [], stats = null, createdBy = null, restoredFrom = null } = {}) {
        await initDB();
        const body = sanitizePageBody(html);
        assertWithinCaps({ bodyHtml: body });
        const label = cleanName(name);
        return withTransaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM studio_documents WHERE id = $1 AND doc_type = $2 FOR UPDATE', [documentId, PAGE_DOC_TYPE]);
            if (!rows[0]) return null;
            const current = mapRow(rows[0]);
            const head = await versions.headRow(client, documentId, current.versionId);
            const nextHash = versions.contentHash({ ...current, bodyHtml: body });
            if (!label && head && head.content_hash === nextHash) return { versionId: head.id, seq: head.seq == null ? null : Number(head.seq), skipped: true };
            const people = versions.cleanContributors(contributors);
            const editor = createdBy || people.find((c) => c.userId)?.userId || null;
            const versionId = crypto.randomUUID();
            const { rows: savedRows } = await client.query(`UPDATE studio_documents SET version_id = $2,
                updated_by = COALESCE($3, updated_by), updated_at = NOW() WHERE id = $1 RETURNING *`, [documentId, versionId, editor]);
            // The revision holds the state it was made from; the stored body is the mirror's.
            const saved = { ...mapRow(savedRows[0]), bodyHtml: body };
            const written = await versions.writeRevision(client, saved, {
                summary: label ? 'Named version' : '', source: versions.VERSION_SOURCES.includes(source) ? source : 'checkpoint',
                // Nobody named: the person who made the checkpoint, when known.
                name: label, actorId: editor, contributors: people.length ? people : undefined, stats, restoredFrom,
            }, current);
            return { versionId, seq: written.seq };
        });
    }

    /**
     * Keep a page body a save could not store (the page went live meanwhile)
     * as a 'conflict' version: listed in the history for its writer to copy
     * from, never the current revision and never the stored body. Answers its
     * id; null when the caller may not write the document.
     *
     * @param {string} documentId @param {any} context @param {string} html
     */
    async function keepConflictCopy(documentId, context, html) {
        await initDB();
        const body = sanitizePageBody(html);
        assertWithinCaps({ bodyHtml: body });
        const a = actorOf(context);
        return withTransaction(async (client) => {
            const locked = await lockForWrite(client, documentId, a);
            if (!locked) return null;
            const current = mapRow(locked.row);
            const copy = { ...current, bodyHtml: body, versionId: crypto.randomUUID() };
            await versions.writeRevision(client, copy, {
                summary: 'Not saved: the page was being edited live', source: 'conflict', actorId: a.userId || null,
            }, current);
            return copy.versionId;
        });
    }

    /**
     * Thin out old versions of one document by a retention policy the caller
     * hands in (core/versioning/retention.js selectPrunable; the store does
     * not reach into core by itself). Never removed, whatever the policy says:
     * the current and first revision, the revision a copy or a section was
     * made from (settings.source, the sections' sources), the open autosave
     * session's starting point, and every id in `referencedIds` (an
     * automation or app step that pins a revision, or the version a project
     * member last saw: the caller knows those). A row folded into a later save
     * of its autosave session (`superseded_by`) is handed over as hidden, so
     * the policy never keeps it in place of a row the history list shows.
     * Answers how many rows were deleted; ids only, never content.
     *
     * @param {string} documentId
     * @param {{ selectPrunable: (rows: object[], now: number) => string[], referencedIds?: string[], now?: number }} options
     */
    async function pruneVersions(documentId, { selectPrunable, referencedIds = [], now = Date.now() }) {
        await initDB();
        if (typeof selectPrunable !== 'function') return 0;
        const doc = await getOne('SELECT version_id, baseline_version_id, settings FROM studio_documents WHERE id = $1', [documentId]);
        if (!doc) return 0;
        const settings = (typeof doc.settings === 'string' ? JSON.parse(doc.settings) : doc.settings) || {};
        const sources = [settings.source?.versionId, ...((settings.contract?.sections || []).map((section) => section?.source?.versionId))];
        const rows = await getAll(`SELECT id, created_at, source, name, pinned, session_base_id, superseded_by
            FROM studio_document_versions WHERE document_id = $1`, [documentId]);
        // The open autosave session measures its word counts from its start.
        const head = rows.find((r) => r.id === doc.version_id);
        const openSession = head?.source === 'autosave' ? head.session_base_id : null;
        const keep = new Set([doc.version_id, doc.baseline_version_id, openSession, ...sources, ...referencedIds].filter(Boolean));
        const ids = selectPrunable(rows.map((r) => ({
            id: r.id, createdAt: r.created_at, source: r.source, name: r.name, pinned: r.pinned === true,
            referenced: keep.has(r.id), hidden: r.superseded_by != null,
        })), now).filter((id) => !keep.has(id));
        if (!ids.length) return 0;
        const result = await run('DELETE FROM studio_document_versions WHERE document_id = $1 AND id = ANY($2::text[])', [documentId, ids]);
        return result?.rowCount || 0;
    }

    /**
     * Who first put one of these strings into the document: the author of its
     * OLDEST revision whose content (body, and the snapshot with its
     * settings) holds any of them. `{ createdBy, seq }` (createdBy null for a
     * revision from before authors were recorded, seq null for one from
     * before revisions were numbered), or null when no revision holds one.
     * `afterSeq` reads only the revisions numbered after it: the caller looked
     * through those up to it before and found none. The caller has checked
     * that its reader may read the document; the answer is an id, never content.
     *
     * Oldest first through an index, so the scan stops at the first revision
     * that holds a needle: the unnumbered ones (older than any numbered one),
     * then by seq. One ORDER BY over both (`seq NULLS FIRST`) matched neither
     * index, and every render read the whole history, body and snapshot of
     * every revision, once per picture.
     *
     * @param {string} documentId @param {string[]} needles
     * @param {{ afterSeq?: number|null }} [opts]
     * @returns {Promise<{ createdBy: string|null, seq: number|null } | null>}
     */
    async function firstAuthorOf(documentId, needles, { afterSeq = null } = {}) {
        await initDB();
        const list = [...new Set((Array.isArray(needles) ? needles : []).filter((n) => typeof n === 'string' && n))];
        if (!documentId || !list.length) return null;
        const encrypted = await getOne('SELECT id, settings FROM studio_documents WHERE id = $1', [documentId]);
        if (encrypted?._contentCryptoContext) {
            const revisions = await getAll('SELECT id, body_html, snapshot, created_by, seq FROM studio_document_versions WHERE document_id = $1 ORDER BY seq ASC NULLS FIRST, created_at ASC', [documentId]);
            const match = revisions.find((row) => (afterSeq == null || (row.seq != null && Number(row.seq) > Number(afterSeq))) && list.some((needle) => (row.body_html || '').includes(needle) || JSON.stringify(row.snapshot || {}).includes(needle)));
            return match ? { createdBy: match.created_by || null, seq: match.seq == null ? null : Number(match.seq) } : null;
        }
        const holds = `EXISTS (SELECT 1 FROM unnest($2::text[]) AS n(needle)
            WHERE position(n.needle IN v.body_html) > 0 OR position(n.needle IN COALESCE(v.snapshot::text, '')) > 0)`;
        if (afterSeq == null) {
            const unnumbered = await getOne(`SELECT created_by FROM studio_document_versions v
                WHERE v.document_id = $1 AND v.seq IS NULL AND ${holds}
                ORDER BY v.created_at ASC, v.id ASC LIMIT 1`, [documentId, list]);
            if (unnumbered) return { createdBy: unnumbered.created_by || null, seq: null };
        }
        const row = await getOne(`SELECT created_by, seq FROM studio_document_versions v
            WHERE v.document_id = $1 AND v.seq IS NOT NULL AND v.seq > $3 AND ${holds}
            ORDER BY v.seq ASC LIMIT 1`, [documentId, list, afterSeq == null ? -1 : Number(afterSeq)]);
        return row ? { createdBy: row.created_by || null, seq: Number(row.seq) } : null;
    }

    /**
     * The number of the document's latest revision (0 before any), or null
     * when there is no such document. Every revision saved later is numbered
     * above it, so `firstAuthorOf(..., { afterSeq })` finds whatever came since.
     *
     * @param {string} documentId
     * @returns {Promise<number|null>}
     */
    async function revisionSeqOf(documentId) {
        await initDB();
        if (!documentId) return null;
        const row = await getOne('SELECT version_seq FROM studio_documents WHERE id = $1', [documentId]);
        return row ? Number(row.version_seq) || 0 : null;
    }

    return {
        listVersions, getVersion, createNamedVersion, nameVersion, restoreVersion, deleteVersion, writeCollabBody, recordVersion,
        keepConflictCopy, pruneVersions, firstAuthorOf, revisionSeqOf,
    };
}

module.exports = { makeDocumentHistory };
