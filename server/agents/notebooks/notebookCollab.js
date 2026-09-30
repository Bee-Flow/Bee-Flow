// @typecheck
/**
 * Notebooks and the co-editing engine, in one place.
 *
 * While a notebook is being co-edited, the live document is the co-editing
 * state (core/collab), not the notebooks row: the row's document_content and
 * document_md are a materialised mirror that can lag by a few seconds. So:
 *
 *   - readers that must see the CURRENT document (a named version, a restore's
 *     "before" copy, the AI's first read) go through `readCurrentContent`;
 *   - server-side writers (AI tools, restore, workspace tools) go through
 *     `applyEdit`, which hands the edit to the engine when a co-editing
 *     document exists and reports `applied: false` otherwise, so the caller
 *     falls back to its compare-and-set write on the row. A writer that
 *     computed its text from an earlier read passes that read as `base`:
 *     only its own change is carried onto the live state (notebookRebase.js),
 *     so colleagues' typing since that read survives; a change to the same
 *     blocks someone else changed comes back as `conflict` and writes nothing;
 *   - the legacy whole-document PUT refuses while one is active (the route).
 *
 * The facade is resolved when used, not when this module loads, and every
 * call degrades: without the engine (not deployed, switched off, failing) a
 * notebook behaves exactly as a single-writer notebook always did. Nothing
 * here logs content — ids and outcomes only.
 */

'use strict';

const log = require('../../telemetry/log');
const { rebaseEdit } = require('./notebookRebase');

const KIND = 'notebook';
// A rebase lost the race to someone's typing this many times in a row: the
// writer's text is kept as a proposal (a conflict) rather than retried forever.
const MAX_REBASE_ATTEMPTS = 3;

/**
 * @typedef {{
 *   isActive?: (kind: string, resourceId: string) => Promise<boolean>,
 *   read?: (kind: string, resourceId: string) => Promise<{ html: string, markdown: string, seq?: number }|null>,
 *   readHtml?: (kind: string, resourceId: string) => Promise<string|null>,
 *   readMarkdown?: (kind: string, resourceId: string) => Promise<string|null>,
 *   applyServerEdit?: (kind: string, resourceId: string, who: object, edit: object) => Promise<{applied: boolean, seq?: number, stale?: boolean}>,
 * }} CollabFacade
 */

let missingLogged = false;

/**
 * The co-editing facade, or null when it is not available.
 * @returns {CollabFacade|null}
 */
function defaultFacade() {
    try {
        return require('../../core/collab');
    } catch (err) {
        if (!missingLogged) {
            missingLogged = true;
            log.info('[NotebookCollab] co-editing engine not available; notebooks stay single-writer', {
                code: /** @type {any} */ (err)?.code || null,
            });
        }
        return null;
    }
}

/**
 * Is a co-editing document active for this notebook? A failing check reads as
 * "no" (logged): the caller then takes its single-writer path, which still
 * has compare-and-set protection.
 *
 * @param {string} notebookId
 * @param {CollabFacade|null} [collab]
 */
async function isCollabActive(notebookId, collab = defaultFacade()) {
    if (!notebookId || !collab || typeof collab.isActive !== 'function') return false;
    try {
        return !!(await collab.isActive(KIND, notebookId));
    } catch (err) {
        log.warn('[NotebookCollab] isActive failed; treating as not co-edited', { notebookId, error: /** @type {any} */ (err)?.message });
        return false;
    }
}

/**
 * The live document straight from the engine, with the update sequence it
 * was read at when the engine tells it; null when the notebook is not
 * co-edited (any more). Throws when the engine cannot read it.
 *
 * @param {string} notebookId
 * @param {CollabFacade} collab
 * @returns {Promise<{ html: string, markdown: string|null, seq: number|null }|null>}
 */
async function readLive(notebookId, collab) {
    if (typeof collab.read === 'function') {
        const r = await collab.read(KIND, notebookId);
        if (!r || typeof r.html !== 'string') return null;
        return { html: r.html, markdown: typeof r.markdown === 'string' ? r.markdown : null, seq: Number.isFinite(r.seq) ? /** @type {number} */ (r.seq) : null };
    }
    const html = typeof collab.readHtml === 'function' ? await collab.readHtml(KIND, notebookId) : null;
    if (typeof html !== 'string') return null;
    const markdown = typeof collab.readMarkdown === 'function' ? await collab.readMarkdown(KIND, notebookId) : null;
    return { html, markdown: typeof markdown === 'string' ? markdown : null, seq: null };
}

/**
 * The notebook's current document. From the co-editing state when one is
 * active (fresh, even when the mirror lags), otherwise from the row.
 *
 * `active` says a co-editing document exists. `active && !live` means the
 * engine could not be read (a key or the converter unavailable): the row's
 * mirror came back, but it is NOT the document, and a write onto the row
 * would be undone by the engine's next materialisation, so a writer must
 * refuse rather than fall back to the row.
 *
 * `seq` is the live update the content was read at (null for the row, or
 * when the engine cannot say): a writer that replaces the whole document
 * from this read passes it back as `expectSeq`.
 *
 * @param {{ id: string, documentContent?: string, documentMd?: string|null }} notebook
 * @param {CollabFacade|null} [collab]
 * @returns {Promise<{ html: string, markdown: string|null, live: boolean, active: boolean, seq: number|null }>}
 */
async function readCurrentContent(notebook, collab = defaultFacade()) {
    const stored = { html: notebook.documentContent || '', markdown: notebook.documentMd ?? null, live: false, active: false, seq: null };
    if (!(await isCollabActive(notebook.id, collab)) || !collab) return stored;
    try {
        const current = await readLive(notebook.id, collab);
        // Folded back into the row between the check and the read: the row is current.
        if (!current) return stored;
        return { html: current.html, markdown: current.markdown, live: true, active: true, seq: current.seq };
    } catch (err) {
        log.warn('[NotebookCollab] live read failed; using the stored mirror', { notebookId: notebook.id, error: /** @type {any} */ (err)?.message });
        return { ...stored, active: true };
    }
}

/** @param {{ origin: string, actorId: string|null, agentId?: string|null, recordVersions?: boolean }} who */
const actorOf = (who) => ({
    origin: who.origin,
    actorId: who.actorId || null,
    recordVersions: who.recordVersions === true,
    ...(who.agentId ? { agentId: who.agentId } : {}),
});

/** @param {any} r */
const seqOf = (r) => (Number.isFinite(r?.seq) ? { seq: /** @type {number} */ (r.seq) } : {});

/**
 * Apply a server-side edit through the co-editing engine.
 *
 * Without `content.base` the edit is the whole document (a restore). A
 * whole-document writer that composed its text from an earlier read passes
 * that read's `expectSeq` (readCurrentContent's `seq`): once anything was
 * appended since, nothing is written and the answer is `stale` (read again),
 * because the text would take out what others typed after that read. With
 * `base`, `content` is what the writer made of `base`, and only that change is
 * carried onto the live document as it is NOW: typing by others since the
 * writer read `base` stays. The rebase is computed against the state at one
 * update sequence and the engine refuses it (`stale`) once anything was
 * appended after that, so it is read and rebased again; nothing typed in
 * between is ever overwritten.
 *
 * `recordVersions` (default false) lets the engine write the versions around
 * the edit itself (a checkpoint before, an 'ai' or 'restore' version after).
 * The notebook routes record their own — one AI version per chat turn, a
 * restore with the version it came from — so they leave it off; a caller that
 * records nothing turns it on.
 *
 * @param {string} notebookId
 * @param {{ origin: 'ai'|'system'|'restore', actorId: string|null, agentId?: string|null, recordVersions?: boolean }} who
 * @param {{ html?: string|null, markdown?: string|null, base?: { html?: string|null, markdown?: string|null }|null,
 *           expectSeq?: number|null }} content
 * @param {CollabFacade|null} [collab]
 * @returns {Promise<{ applied: boolean, conflict?: boolean, stale?: boolean, html?: string, seq?: number }>}
 *   `applied: false` without `conflict` or `stale` when no co-editing
 *   document exists (the caller writes the row instead); `conflict: true`
 *   when the change collides with someone else's, `stale: true` when the
 *   document moved on since `expectSeq` (nothing was written either way:
 *   never write the row); `html` is the document the rebase produced
 */
async function applyEdit(notebookId, who, content, collab = defaultFacade()) {
    if (!collab || typeof collab.applyServerEdit !== 'function') return { applied: false };
    if (!(await isCollabActive(notebookId, collab))) return { applied: false };
    if (content.base) return applyRebased(notebookId, who, content, collab);
    const replaceWith = typeof content.html === 'string' && content.html
        ? { html: content.html }
        : { markdown: content.markdown || '' };
    const expectSeq = Number.isInteger(content.expectSeq) ? { expectSeq: /** @type {number} */ (content.expectSeq) } : {};
    const r = await collab.applyServerEdit(KIND, notebookId, actorOf(who), { replaceWith, ...expectSeq });
    if (r?.stale) return { applied: false, stale: true, ...seqOf(r) };
    return { applied: !!r?.applied, ...seqOf(r) };
}

/**
 * @param {string} notebookId
 * @param {{ origin: 'ai'|'system'|'restore', actorId: string|null, agentId?: string|null, recordVersions?: boolean }} who
 * @param {{ html?: string|null, markdown?: string|null, base?: { html?: string|null, markdown?: string|null }|null }} content
 * @param {CollabFacade} collab
 * @returns {Promise<{ applied: boolean, conflict?: boolean, html?: string, seq?: number }>}
 */
async function applyRebased(notebookId, who, content, collab) {
    const next = { html: content.html ?? null, markdown: content.markdown ?? null };
    for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt++) {
        const current = await readLive(notebookId, collab);
        if (!current) return { applied: false };
        const r = rebaseEdit(/** @type {any} */ (content.base), next, current.html);
        if (r.conflict || r.html == null) return { applied: false, conflict: true };
        if (!r.changed) return { applied: true, html: current.html, ...seqOf(current) };
        const res = await collab.applyServerEdit(KIND, notebookId, actorOf(who), {
            replaceWith: { html: r.html },
            ...(current.seq != null ? { expectSeq: current.seq } : {}),
        });
        if (res?.stale) continue;
        return { applied: !!res?.applied, ...(res?.applied ? { html: r.html } : {}), ...seqOf(res) };
    }
    log.info('[NotebookCollab] an edit kept losing the race to live typing; kept as a proposal', { notebookId });
    return { applied: false, conflict: true };
}

module.exports = { KIND, defaultFacade, isCollabActive, readCurrentContent, applyEdit };
