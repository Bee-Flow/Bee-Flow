// @typecheck
/**
 * How one notebook chat turn persists the AI's document edits without
 * overwriting anyone (routes/ai/notebookChat.js builds one per turn).
 *
 *   - co-edited notebook: through the co-editing engine, every open editor
 *     follows. The model edits the copy it read, which stands still while the
 *     turn runs (tens of seconds) and colleagues keep typing, so only the
 *     model's own change (from what it read to what it wrote) is carried onto
 *     the live document (notebookCollab.applyEdit with a base). A change to a
 *     block someone else changed meanwhile writes nothing;
 *   - otherwise: compare-and-set on the row, over the version the page had
 *     loaded, never blindly over a newer save by the user or a colleague;
 *   - a real conflict keeps the AI's edit as a 'conflict' version (a proposal
 *     the user can compare and restore) and writes nothing;
 *   - the state before the turn's first write is kept as a checkpoint: a model
 *     can be talked into rewriting a document by text inside an ingested
 *     source, so every machine-authored change needs its own undo point.
 *
 * Content in, ids and outcomes out: nothing here logs text.
 */

'use strict';

const log = require('../../telemetry/log');
const notebookCollab = require('./notebookCollab');

/** The HTML as the store keeps it, for "is this the same document?". @param {unknown} html */
function canonicalHtml(html) {
    const { sanitizeDocumentHtml } = require('../../utils/htmlSanitizer');
    const { looksLikeHtml } = require('../../core/markdown');
    const text = String(html || '');
    return (looksLikeHtml(text) ? sanitizeDocumentHtml(text) : text).trim();
}

/**
 * @typedef {object} AiDocWriterOptions
 * @property {string} notebookId
 * @property {string} userId
 * @property {string} baseHtml  the document the model's view stands for (real values)
 * @property {number|null} expectedVersion  the row version the turn may write over
 * @property {any} [store]  stores/notebookStore
 * @property {() => any} [collab]  the co-editing facade, resolved per write
 */

/**
 * @param {AiDocWriterOptions} opts
 */
function makeAiDocWriter({ notebookId, userId, baseHtml, expectedVersion, store = require('../../stores/notebookStore'), collab = () => notebookCollab.defaultFacade() }) {
    const contributors = [{ userId, kind: 'ai' }];
    // The row version the next compare-and-set write may replace; each write
    // advances it, so a turn's chained edits do not trip over each other.
    let casVersion = expectedVersion;
    // The document the model's edits are based on, as the store keeps it. A
    // conflict where the server still holds exactly this (the page's own
    // autosave of the text the turn started from landed meanwhile) is not a
    // real conflict and is retried once over the newer version.
    let casBase = canonicalHtml(baseHtml);
    // The same base as it is, for the live path: what the model's current
    // view of the document stands for.
    let liveBase = baseHtml || '';
    let snapshotTaken = false;

    /** @param {string} html @param {string|null} markdown */
    async function keepAsProposal(html, markdown) {
        try {
            await store.recordVersion(notebookId, { html, markdown, source: 'conflict', createdBy: userId, contributors });
        } catch (e) {
            log.warn('[NotebookChat] could not keep the AI proposal as a version', { notebookId, error: /** @type {Error} */ (e).message });
        }
        return { ok: false, conflict: true };
    }

    /** @param {string} realHtml @param {any} facade */
    async function snapshotBefore(realHtml, facade) {
        try {
            const fresh = await store.getNotebook(notebookId, userId);
            const current = fresh ? await notebookCollab.readCurrentContent(fresh, facade) : null;
            if (current && current.html.trim() && canonicalHtml(current.html) !== canonicalHtml(realHtml)) {
                await store.recordVersion(notebookId, {
                    html: current.html, markdown: current.markdown, source: 'checkpoint', createdBy: userId,
                    contributors: fresh.lastEditedBy ? [{ userId: fresh.lastEditedBy, kind: 'user' }] : [],
                });
            }
        } catch (e) {
            log.warn('[NotebookChat] snapshot before AI edit failed', { notebookId, error: /** @type {Error} */ (e).message });
        }
    }

    /** @param {string} realHtml @param {string|null} realMd */
    async function writeRow(realHtml, realMd) {
        const write = (/** @type {number|null} */ version) => store.updateNotebookCas(notebookId, userId, {
            documentContent: realHtml,
            ...(realMd != null ? { documentMd: realMd } : {}),
            expectedVersion: version,
        });
        let saved = await write(casVersion);
        if (!saved.ok && saved.conflict) {
            const fresh = await store.getNotebook(notebookId, userId).catch(() => null);
            if (fresh && canonicalHtml(fresh.documentContent) === casBase) saved = await write(fresh.version);
        }
        if (saved.ok) {
            if (saved.version != null) casVersion = saved.version;
            casBase = canonicalHtml(realHtml);
            liveBase = realHtml;
            return { ok: true, version: saved.version };
        }
        if (saved.conflict) return keepAsProposal(realHtml, realMd);
        return { ok: false };
    }

    /**
     * Persist one AI edit: the whole document as the model now has it.
     * `html` in the answer is the live document the edit produced (the AI's
     * change merged with everyone's typing), when it went through the engine.
     *
     * @param {string} realHtml
     * @param {string|null} realMd
     * @param {{ snapshot?: boolean }} [opts]
     * @returns {Promise<{ ok: boolean, conflict?: boolean, live?: boolean, version?: number, html?: string }>}
     */
    async function write(realHtml, realMd, { snapshot = true } = {}) {
        const facade = collab();
        if (snapshot && !snapshotTaken) {
            snapshotTaken = true;
            await snapshotBefore(realHtml, facade);
        }
        try {
            const live = await notebookCollab.applyEdit(notebookId, { origin: 'ai', actorId: userId },
                { html: realHtml, markdown: realMd, base: { html: liveBase } }, facade);
            if (live.conflict) return keepAsProposal(realHtml, realMd);
            if (live.applied) {
                liveBase = realHtml;
                return { ok: true, live: true, ...(live.html ? { html: live.html } : {}) };
            }
        } catch (e) {
            log.error('[NotebookChat] AI edit through co-editing failed', { notebookId, error: /** @type {Error} */ (e).message });
            return { ok: false };
        }
        return writeRow(realHtml, realMd);
    }

    return { write, contributors };
}

module.exports = { makeAiDocWriter, canonicalHtml };
