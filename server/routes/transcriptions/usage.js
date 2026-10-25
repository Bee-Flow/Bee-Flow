// @typecheck
/**
 * Meeting notes — what happens to one (M2), and how to undo one thing that did.
 *
 *   GET    /:id/usage         →  { usage: [...], unchecked: [...] }
 *   DELETE /:id/filed-lines   →  { removedLines, removedDocuments, errors }
 *
 * Feeds three things off one derivation: the "what happens to this meeting"
 * bar under the tag row, the Used-by tab, and the 409 the delete guard
 * answers with. See core/meetingNotes/meetingUsage.js for why it is a scan
 * and not a link table, and for the two things about it that look like bugs.
 *
 * ── MOUNTED BEFORE ./notes ──────────────────────────────────────────
 * `GET /:id` in notes.js captures every literal path that is not in its
 * RESERVED_GET_PATHS — that is how `GET /tags` came to answer 404 for a
 * release. This one is a two-segment path and would survive either order,
 * but it sits with its sibling so the ordering rule stays visible rather
 * than being rediscovered. transcriptions.mount.test.js pins it.
 *
 * ── AUTHORISATION IS THE READ RIGHT ─────────────────────────────────
 * Whoever may open the note may ask what happens to it — it is the same
 * population that already sees its tags, which is what most of this list is
 * derived from. What the answer does NOT do is name things the asker cannot
 * see for themselves: `redactForeign` keeps the kind and the role of somebody
 * else's automation or knowledge base and drops its name, so the tab cannot
 * become a way to enumerate an organisation from one shared meeting.
 *
 * ── THE STORES ARE REQUIRED INSIDE THE HANDLER ──────────────────────
 * stores/knowledgeBases.js, stores/transcriptionStore.js and
 * stores/automationStore/core.js all kick off their own initDB() at module
 * load. routes/transcriptions.payload.test.js requires this whole router
 * tree with a hand-stubbed require cache, and a top-level require here would
 * drag real database init into a test that has no database. The house does
 * this too — routes/knowledgeBases/detail.js requires kbUsage inside the
 * handler for the same reason.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { requireAuth } = require('../../auth/permissions');
const { resolveAccessContext } = require('./shared');
const { validate } = require('../../core/http/validate');
const { NOTHING, NO_QUERY } = require('./schemas');

router.get('/:id/usage', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const transcriptionStore = require('../../stores/transcriptionStore');
    const { usageForMeeting, redactForeign } = require('../../core/meetingNotes/meetingUsage');

    const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
    const note = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
    // 404 rather than 403 for a note outside the caller's reach: the same
    // answer every other route on this id gives, so this one cannot be
    // used to probe which ids exist.
    if (!note) return res.status(404).json({ error: 'Not found' });

    const { rows, partial } = await usageForMeeting(note);
    res.json({
        usage: redactForeign(rows, userId),
        // "I could not check notebooks" is a different sentence from "no
        // notebook uses this", and only one of them is safe to delete on.
        // The client says the first out loud; the delete guard treats it
        // as in-use.
        unchecked: partial,
    });
});

/**
 * ── A WRONGLY LANDED RULE, REMOVED AGAIN (M4) ───────────────────────
 *
 * `POST /api/kb/:id/sources` with `kind:'text'` writes `config.metadata =
 * { transcriptionId, segmentIndex }` and thereby lets that rule LAND on the
 * timeline of a meeting: it appears in the bar below the tag row, in the
 * "Used by" tab and in "Extracted from this transcript", and it keeps the
 * delete gate of that meeting at 409.
 *
 * Since M4 the writer must be able to open that meeting itself
 * (routes/knowledgeBases/sources.js), so new untrue rules can no longer get in.
 * Rows that already exist stay in place — and for the victim,
 * `DELETE /api/kb/:id/sources/:sid` is no way out: it requires management of the
 * knowledge base of the writer, which the victim by definition does not have.
 * Without this route, the only remaining exit is the confirmed escape hatch of
 * DELETE /:id — throwing away one's own meeting to get rid of someone else's claim.
 *
 * THE AUTHORITY BELONGS TO OWNERSHIP OF THE MEETING, not to read access to it. A
 * colleague with whom the note is shared may do nothing here: this removes rows
 * from the knowledge base of someone else, and that authority belongs to exactly
 * one person — the one over whose meeting the row makes a claim.
 *
 * THE WRITE-SIDE GATE IS DELIBERATELY ABSENT HERE. Whether the MAKER of the row
 * may (still) see the meeting does not matter for a removal: a row that should
 * NOT have been visible is exactly the row that must go. A readability check on
 * this path would turn every wrongly landed rule into an unremovable one — precisely
 * the state this closes.
 *
 * The chunks go first, and that is done by `core/kb/purgeSourceDocuments` — the same
 * loop that routes/knowledgeBases/sources.js uses, not a second variant beside it.
 * Why a LOOP and not one page: the FK cascades the document rows as soon as the
 * source falls, so a document that did not go through `deleteDocumentChunks` does
 * disappear from the table and keeps its embeddings. A single `listDocuments` with
 * limit 200 would leave one behind at 201 documents — silently, because nothing went
 * wrong that could be reported. In a privacy product, deleted text that keeps
 * answering questions is the bug.
 *
 * THEREFORE THE SOURCE FALLS ONLY WHEN THE CLEANUP IS DONE. If something remains,
 * the source row also remains: the rule is then not gone, but neither is it half
 * gone with leftover vectors. The row goes into `errors` and does not count in
 * `removedLines`, so the owner still sees the meeting at 409 instead of getting a
 * clean notice.
 *
 * Per row separately, and what did not succeed is in `errors`: "I could not remove
 * this" is a different sentence from "there was nothing", and only with the first
 * must the owner not think that he is clean.
 */
router.delete('/:id/filed-lines', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (req, res) => {
    const userId = req.session.user.id;
    const transcriptionStore = require('../../stores/transcriptionStore');
    const { filedTranscriptSources } = require('../../core/meetingNotes/meetingUsage');

    const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
    const note = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
    // Same 404 as every other route on this id, so that this one cannot be used
    // either to discover which ids exist.
    if (!note) return res.status(404).json({ error: 'Not found' });
    if (!note.isOwner) return res.status(403).json({ error: 'Only the owner can remove filed lines', code: 'not_owner' });

    const filed = await filedTranscriptSources(note.id);

    const kbStore = require('../../stores/knowledgeBases');
    const kbSourcesStore = require('../../stores/kbSources');
    const { deleteDocumentChunks } = require('../../core/kb/kbIngestionHelpers');
    const { purgeSourceDocuments } = require('../../core/kb/purgeSourceDocuments');

    let removedLines = 0;
    let removedDocuments = 0;
    const errors = [];
    for (const row of filed) {
        try {
            const purge = await purgeSourceDocuments({
                kbStore, deleteDocumentChunks,
                kbId: row.kbId, sourceId: row.sourceId, tenantId: row.tenantId,
            });
            // What is done DOES count, even if the rest stayed: that is not a clean notice,
            // it is an honest count.
            removedDocuments += purge.deleted;
            if (!purge.complete) {
                // Do NOT remove the source — the FK would drag the remaining document rows along
                // and leave their embeddings searchable for good. A half-cleaned source that is
                // reported as removed is the same mistake in another guise.
                const why = purge.errors.length > 0
                    ? purge.errors[0].error
                    : 'documents remained after cleanup';
                log.warn('[Transcriptions] filed line kept, documents remain:', row.sourceId, why);
                errors.push({ sourceId: row.sourceId, error: why, documents: purge.errors });
                continue;
            }
            await kbSourcesStore.remove(row.sourceId);
            removedLines += 1;
        } catch (e) {
            log.warn('[Transcriptions] filed line not removed:', /** @type {Error} */ (e).message);
            // The SAME shape as the branch above: a client that later shows "these documents
            // did not want to" reads `e.documents` and must not find `undefined` there.
            // Empty is the honest answer here — the cleanup did not even get to documents.
            errors.push({ sourceId: row.sourceId, error: /** @type {Error} */ (e).message, documents: [] });
        }
    }
    res.json({ removedLines, removedDocuments, errors });
});

module.exports = router;
