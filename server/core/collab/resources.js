// @typecheck
/**
 * The resources a co-edited document belongs to, and the hooks co-editing
 * calls on their owners.
 *
 *   notebook   notebooks.document_content (HTML) / document_md (Markdown)
 *   document   studio_documents.body_html, only for doc_type 'page' — a
 *              designed Studio document (letters, decks, reports) is edited in
 *              its own frame and is not co-edited (COLLAB_UNSUPPORTED)
 *
 * Reading a resource here is a narrow, read-only SELECT of the columns
 * co-editing needs (where it is filed, its legacy content). Every WRITE goes
 * through the owning store's hook, which keeps that store's own rules
 * (sanitising, caps, version numbering, content hashes):
 *
 *   notebookStore.writeCollabContent(id, {html, markdown, text, wordCount}) → {version}
 *   notebookStore.recordVersion(id, {html, markdown, source, name?, contributors, stats?, createdBy?})
 *   documentStore.writeCollabBody(id, {html}) → {versionId?}
 *   documentStore.recordVersion(id, {html, source, name?, contributors, stats?, createdBy?})
 *
 * The recordVersion hooks write a version, never the mirror columns: those
 * have one writer, lifecycle.materialise (writeMirror), under the mirror
 * lease and only over an older state.
 *
 * A hook that is not there yet degrades to "not written" with a log line; it
 * never crashes the caller. An owner that REFUSES the content (a page body
 * over documentStore's byte cap) answers "not written, refused": that is an
 * outcome the caller must handle (keep the state, never drop it), not a
 * failure to retry. The same cap is offered up front as
 * `maxContentBytes(kind)`, so co-editing refuses the edit that would pass it
 * instead of accepting content the owner cannot store.
 */

'use strict';

const log = require('../../telemetry/log');

/**
 * @typedef {{ id: string, kind: 'notebook'|'document', projectId: string|null, ownerId: string|null,
 *   orgId: string|null, html: string, markdown: string|null, supported: boolean, archived?: boolean }} CollabResource
 */

const KINDS = Object.freeze(['notebook', 'document']);
const PAGE_DOC_TYPE = 'page';

/** What the change feed and the compliance scan call each kind. */
const FEED_ITEM_TYPE = Object.freeze({ notebook: 'notebook', document: 'document' });
const SCAN_SUBJECT = Object.freeze({ notebook: 'notebook_document', document: 'studio_document' });

/**
 * @param {{ getOne?: (sql: string, params?: any[]) => Promise<any>,
 *           notebookStore?: any, documentStore?: any, log?: any }} [deps]
 */
function makeResources(deps = {}) {
    const getOne = async (/** @type {string} */ sql, /** @type {any[]} */ params) => require('../../stores/lib/documentCrypto').openRow(await (deps.getOne || require('../../db').getOne)(sql, params));
    const notebookStore = () => deps.notebookStore || require('../../stores/notebookStore');
    const documentStore = () => deps.documentStore || require('../../stores/documentStore');
    const logger = deps.log || log;
    const warned = new Set();

    /** @param {string} what */
    function warnOnce(what) {
        if (warned.has(what)) return;
        warned.add(what);
        logger.warn(`[Collab] ${what} is not available; that step is skipped`);
    }

    /**
     * `lock`: the read that seeds a new co-editing document. It takes the
     * row's share lock, so a single-writer save in flight is waited for and
     * its text is the one imported; a save after it finds the document
     * (created before the seed) and is refused by its store
     * (notebookStore/documentStore write only while none exists).
     *
     * @param {string} kind @param {string} id @param {{ lock?: boolean }} [opts]
     * @returns {Promise<CollabResource|null>}
     */
    async function load(kind, id, { lock = false } = {}) {
        if (!id || typeof id !== 'string') return null;
        const share = lock ? ' FOR SHARE' : '';
        if (kind === 'notebook') {
            const r = await getOne(
                `SELECT id, user_id, project_id, organization_id, document_content, document_md FROM notebooks WHERE id = $1${share}`,
                [id],
            );
            if (!r) return null;
            return {
                id: r.id, kind, projectId: r.project_id || null, ownerId: r.user_id || null, orgId: r.organization_id || null,
                html: r.document_content || '', markdown: r.document_md ?? null, supported: true,
            };
        }
        if (kind === 'document') {
            const r = await getOne(
                `SELECT id, user_id, project_id, organization_id, doc_type, kind, archived, body_html
                   FROM studio_documents WHERE id = $1${share}`,
                [id],
            );
            if (!r) return null;
            // Templates and sections are never project content; a designed
            // document is filed but not co-edited. An archived page is not
            // co-edited either, but it is still its own row, which can be
            // brought back: a live document left from before the archive is
            // folded back into it (those edits exist nowhere else), never
            // deleted unopened as if the page were gone.
            if (r.kind !== 'document') return null;
            return {
                id: r.id, kind, projectId: r.project_id || null, ownerId: r.user_id || null, orgId: r.organization_id || null,
                html: r.body_html || '', markdown: null, supported: r.doc_type === PAGE_DOC_TYPE && !r.archived,
                ...(r.archived ? { archived: true } : {}),
            };
        }
        return null;
    }

    /**
     * Write the materialised state into the resource's own columns.
     * @param {string} kind @param {string} id
     * @param {{ html: string, markdown: string, text: string, wordCount: number, editedBy?: string|null }} content
     * @returns {Promise<{ written: boolean, version?: any, versionId?: string|null, refused?: boolean, reason?: string }>}
     */
    async function writeMirror(kind, id, content) {
        try {
            if (kind === 'notebook') {
                const store = notebookStore();
                if (typeof store.writeCollabContent !== 'function') { warnOnce('notebookStore.writeCollabContent'); return { written: false }; }
                const r = await store.writeCollabContent(id, content);
                return { written: true, version: r && r.version };
            }
            if (kind === 'document') {
                const store = documentStore();
                if (typeof store.writeCollabBody !== 'function') { warnOnce('documentStore.writeCollabBody'); return { written: false }; }
                const r = await store.writeCollabBody(id, { html: content.html });
                // null: the document is not a page (any more), so nothing was written.
                if (!r) return { written: false };
                return { written: true, versionId: r.versionId || null };
            }
        } catch (err) {
            if (isRefusal(err)) return { written: false, refused: true, reason: /** @type {any} */ (err).errorClass || 'refused' };
            throw err;
        }
        return { written: false };
    }

    /**
     * The owner's cap on the stored body, in bytes of HTML, or null for none
     * (a notebook). A page's is documentStore.MAX_HTML_BYTES.
     * @param {string} kind
     * @returns {number|null}
     */
    function maxContentBytes(kind) {
        if (kind !== 'document') return null;
        const cap = Number(documentStore().MAX_HTML_BYTES);
        return Number.isFinite(cap) && cap > 0 ? cap : null;
    }

    /**
     * Record a version in the resource's own version table. Answers the new
     * version id, or null when nothing was written (a hook is missing, or the
     * owner skipped an identical snapshot).
     *
     * @param {string} kind @param {string} id
     * @param {{ html: string, markdown?: string, source: string, name?: string|null,
     *           contributors: Array<{ userId: string|null, kind: 'user'|'ai', agentId?: string }>,
     *           stats?: object|null, createdBy?: string|null, restoredFrom?: string|null }} v
     * @returns {Promise<string|null>}
     */
    async function recordVersion(kind, id, v) {
        const store = kind === 'notebook' ? notebookStore() : kind === 'document' ? documentStore() : null;
        if (!store) return null;
        if (typeof store.recordVersion !== 'function') { warnOnce(`${kind === 'notebook' ? 'notebookStore' : 'documentStore'}.recordVersion`); return null; }
        const payload = kind === 'notebook' ? v : { ...v, markdown: undefined };
        const r = await store.recordVersion(id, payload);
        if (!r) return null;
        if (typeof r === 'string') return r;
        // The owner found the snapshot identical to its newest version and
        // wrote nothing (documents say `skipped`, notebooks `deduped`): the id
        // it hands back is the OLD version's, so it is not a new version.
        if (r.skipped || r.deduped) return null;
        return r.id || r.versionId || (r.version && r.version.id) || null;
    }

    return { load, writeMirror, recordVersion, maxContentBytes };
}

/**
 * The owner refused the content itself (documentStore's `document_too_large`,
 * or any 4xx it answers), as opposed to failing to store it.
 * @param {unknown} err
 */
function isRefusal(err) {
    const e = /** @type {any} */ (err);
    if (!e) return false;
    const status = Number(e.status);
    return e.errorClass === 'document_too_large' || (status >= 400 && status < 500);
}

module.exports = {
    KINDS,
    PAGE_DOC_TYPE,
    FEED_ITEM_TYPE,
    SCAN_SUBJECT,
    makeResources,
    isRefusal,
};
