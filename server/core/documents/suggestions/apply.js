'use strict';

/**
 * Accept / reject suggestions of one document.
 *
 * Accepting loads the open suggestions, applies their hunks to the CURRENT body
 * with the engine (a hunk that no longer fits is stale, never forced) and writes
 * the result ONCE:
 *   - a page edited live: collab.read -> applyHunks -> collab.applyServerEdit
 *     with expectSeq, up to LIVE_ATTEMPTS times when somebody types in between;
 *   - otherwise documentStore.updateDocument with a revision of source 'ai'.
 * Applied suggestions become 'accepted' (+ the version they went in), the ones
 * that did not fit 'stale'. Nothing applied means nothing written.
 *
 * Access is the caller's job (routes/documentSuggestions.js); every collaborator
 * is injected so tests run with fakes.
 */

const { HttpError } = require('../../http/errors');
const { engine: realEngine } = require('./engine');
const { announceSuggestions } = require('./events');

const LIVE_ATTEMPTS = 3;
const AI_SUMMARY = 'Accepted AI suggestions';

/**
 * @param {{
 *   store: any, documents: any, feed?: any, engine?: () => any, announce?: Function,
 *   liveCollabFor?: (doc: any) => Promise<any>, wordStats?: Function, log?: any
 * }} deps
 */
function makeSuggestionApplier(deps) {
    const { store, documents } = deps;
    const engine = deps.engine || realEngine;
    const announce = deps.announce || announceSuggestions;
    const liveCollabFor = deps.liveCollabFor || ((doc) => require('../documentFeed').liveCollabFor(doc));
    const feed = deps.feed || { recordContentChange: (...a) => require('../documentFeed').recordContentChange(...a) };
    const wordStats = deps.wordStats || ((a, b) => require('../../../stores/lib/documentText').wordStats(a, b));

    const hunkOf = (s) => ({ anchor: s.anchor, before: s.before, after: s.after, summary: s.summary });

    /** Open suggestions of THIS document among `ids`, in the order they were made. */
    async function openOnes(documentId, ids, statuses = ['open']) {
        const rows = [];
        for (const id of [...new Set(ids.map(String))]) {
            const s = await store.get(id);
            if (s && s.targetId === documentId && statuses.includes(s.status)) rows.push(s);
        }
        return rows;
    }

    async function afterChange(doc, batchId) {
        const open = await store.countOpen('document', doc.id);
        await announce({ documentId: doc.id, projectId: doc.projectId || null, batchId, open });
        return open;
    }

    /** @returns {Promise<{ versionId: string|null, applied: number[], stale: number[] }|null>} null: the page is not live */
    async function applyLive(doc, live, hunks, actor) {
        const eng = engine();
        for (let attempt = 0; attempt < LIVE_ATTEMPTS; attempt += 1) {
            // Opened once: the relative positions resolve in the same state the hunks apply to.
            const state = typeof live.withFragment === 'function'
                ? await live.withFragment('document', doc.id, ({ ydoc, fragment, html, seq }) => ({
                    seq, result: eng.applyHunks(eng.htmlToAst(html), hunks, eng.relResolver ? eng.relResolver(fragment, ydoc) : null),
                }))
                : await readState(live, doc.id, eng, hunks);
            if (!state) return null;
            const { result } = state;
            if (result.applied.length === 0) return { versionId: null, applied: [], stale: result.stale };
            const out = await live.applyServerEdit('document', doc.id, { origin: 'ai', actorId: actor.userId },
                { replaceWith: { ast: result.doc }, expectSeq: Number.isInteger(state.seq) ? state.seq : undefined });
            if (out?.stale) continue;
            if (!out?.applied) return null;
            return { versionId: out.versionId || (Number.isInteger(out.seq) ? `${doc.versionId || ''}@live:${out.seq}` : doc.versionId || null), applied: result.applied, stale: result.stale };
        }
        throw new HttpError(409, 'document_busy', 'Somebody keeps typing in this page. Try again in a moment.');
    }

    /** A live facade without withFragment: the rendering only, no relative positions. */
    async function readState(live, id, eng, hunks) {
        const read = await live.read('document', id);
        if (!read || typeof read.html !== 'string') return null;
        return { seq: read.seq, result: eng.applyHunks(eng.htmlToAst(read.html), hunks, null) };
    }

    async function applyStored(doc, hunks, actor) {
        const eng = engine();
        const result = eng.applyHunks(eng.htmlToAst(doc.bodyHtml || ''), hunks, null);
        if (result.applied.length === 0) return { versionId: null, applied: [], stale: result.stale };
        let updated;
        try {
            updated = await documents.updateDocument(doc.id, { userId: actor.userId, isAdmin: actor.isAdmin === true }, {
                bodyHtml: eng.astToHtml(result.doc), expectedVersionId: doc.versionId,
                source: 'ai', summary: AI_SUMMARY, contributors: [{ userId: actor.userId, kind: 'ai' }],
            });
        } catch (e) {
            if (e?.errorClass === 'document_conflict' || e?.errorClass === 'document_live') throw new HttpError(409, 'document_changed', e.message);
            throw e;
        }
        if (!updated) throw new HttpError(403, 'document_read_only', 'You cannot change this document.');
        if (updated.versionId !== doc.versionId) {
            await feed.recordContentChange(updated, {
                actorId: actor.userId, source: 'ai', versionId: updated.versionId,
                contributors: [{ userId: actor.userId, kind: 'ai' }], stats: wordStats(doc.bodyHtml, updated.bodyHtml),
            });
        }
        return { versionId: updated.versionId, applied: result.applied, stale: result.stale };
    }

    /**
     * @param {{ doc: any, ids: string[], actor: { userId: string, isAdmin?: boolean } }} input
     * @returns {Promise<{ accepted: string[], rejected: string[], stale: string[], versionId: string|null }>}
     */
    async function accept({ doc, ids, actor }) {
        const rows = await openOnes(doc.id, ids);
        if (rows.length === 0) return { accepted: [], rejected: [], stale: [], versionId: null };
        const hunks = rows.map(hunkOf);
        const live = await liveCollabFor(doc);
        let outcome = live ? await applyLive(doc, live, hunks, actor) : null;
        if (!outcome) outcome = await applyStored(doc, hunks, actor);

        const acceptedRows = outcome.applied.map((i) => rows[i]);
        const staleRows = outcome.stale.map((i) => rows[i]);
        const accepted = await store.setStatus(acceptedRows.map((s) => s.id), 'accepted', { resolvedBy: actor.userId, appliedVersionId: outcome.versionId });
        const stale = await store.setStatus(staleRows.map((s) => s.id), 'stale', { resolvedBy: actor.userId });
        await afterChange(doc, rows[0].batchId);
        return { accepted, rejected: [], stale, versionId: outcome.versionId };
    }

    /** @param {{ doc: any, ids: string[], actor: { userId: string } }} input */
    async function reject({ doc, ids, actor }) {
        // A stale suggestion is dismissed the same way.
        const rows = await openOnes(doc.id, ids, ['open', 'stale']);
        const rejected = await store.setStatus(rows.map((s) => s.id), 'rejected', { resolvedBy: actor.userId, from: ['open', 'stale'] });
        if (rows.length) await afterChange(doc, rows[0].batchId);
        return { accepted: [], rejected, stale: [], versionId: null };
    }

    return { accept, reject };
}

module.exports = { makeSuggestionApplier, LIVE_ATTEMPTS };
