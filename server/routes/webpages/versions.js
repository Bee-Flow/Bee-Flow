// @typecheck
/**
 * ── Version Control ─────────────────────────────────────────────────
 *
 * Versiebeheer: de geschiedenislijst, één momentopname, handmatig een
 * momentopname maken, terugzetten en verwijderen.
 *
 * GET /:id/versions  ·  GET /:id/versions/:vid  ·  POST /:id/versions
 * POST /:id/versions/:vid/restore  ·  DELETE /:id/versions/:vid
 */

const crypto = require('crypto');

const webpageStore = require('../../stores/webpageStore');
const webpageDbStore = require('../../stores/webpageDbStore');
const storageStore = require('../../stores/storageStore');
const { requireAuth } = require('../../auth/permissions');
const webpageUsageSync = require('../../core/webpages/webpageUsageSync');
const versionFacts = require('../../core/webpages/versionFacts');
const { versionActorNames, versionCoverage, decorateVersionRow } = require('./versionListing');
const { validate } = require('../../core/http/validate');
const { z } = require('../../utils/zod');
const { worded, bodyOf, whole, NOTHING, NO_QUERY } = require('./schemas');
const log = require('../../telemetry/log');

// The bookmark of the history list. `.strict()`, because every other parameter one would
// expect here — a filter on source, on maker — came back as "the last 50", and that is a
// DIFFERENT answer to the question.
const ListQuery = z.object({ limit: whole('limit'), offset: whole('offset') }).strict();

const SummaryBody = bodyOf({
    summary: worded('Een samenvatting is tekst.').trim().max(500, 'Een samenvatting is hoogstens 500 tekens.').optional(),
});

function register(router) {
    router.get('/:id/versions', requireAuth, validate({ query: ListQuery }), async (/** @type {import('express').Request<{ id: string }, any, any, import('zod').infer<typeof ListQuery>>} */ req, /** @type {import('express').Response} */ res) => {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        // Store defaults to 50 while up to 200 versions can exist per webpage
        // (MAX_VERSIONS_PER_WEBPAGE) — without pagination, versions 51-200 were
        // permanently unreachable from the UI. Clamp to the same 200 ceiling and
        // fetch one extra row to report hasMore without a separate COUNT query.
        const limit = Math.min(Math.max(req.query.limit ?? 50, 1), 200);
        const offset = Math.max(req.query.offset ?? 0, 0);
        const rows = await webpageStore.getVersions(req.params.id, { limit: limit + 1, offset });
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        const names = await versionActorNames(page, req.session.user);
        const publishedVersionId = wp.publishedVersionId || null;

        // WHICH version the public reads, as its own field — not something that the client must
        // derive from the rows. The pinned row may fall outside this page (or, with a pointer to a
        // vanished row, may not exist at all any more), and then "look for it in the list" would
        // yield a page without a chip while something IS published.
        let published = null;
        if (publishedVersionId) {
            const meta = await webpageStore.getVersionMeta(publishedVersionId);
            // getVersionMeta looks up by id only; the page check belongs with it, otherwise a pointer
            // to another page would get a number here that means nothing in THIS list.
            published = (meta && meta.webpageId === req.params.id)
                ? { versionId: meta.id, seq: meta.seq }
                : null;
        }

        res.json({
            versions: page.map(r => decorateVersionRow(r, { viewerId: userId, names, publishedVersionId })),
            hasMore,
            published,
            // WHAT this list covers. Without this field the screen can explain an empty list only
            // with "you have not edited enough yet", and on the default project type that is untrue.
            coverage: versionCoverage(wp),
            managed: await webpageStore.managedPayloadOf(wp),
        });
    });

    router.get('/:id/versions/:vid', requireAuth, validate({ query: NO_QUERY }), async (/** @type {import('express').Request<{ id: string, vid: string }, any, any, import('zod').infer<typeof NO_QUERY>>} */ req, /** @type {import('express').Response} */ res) => {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const version = await webpageStore.getVersion(userId, req.params.vid);
        if (!version || version.webpageId !== req.params.id) {
            return res.status(404).json({ error: 'Version not found' });
        }
        // The same shape as a row from the list — "View" opens a row that the user saw
        // there, and it must not suddenly carry a different maker or a different number just
        // because it came in via a second route.
        const names = await versionActorNames([version], req.session.user);
        res.json({
            version: decorateVersionRow(version, {
                viewerId: userId,
                names,
                publishedVersionId: wp.publishedVersionId || null,
            }),
            managed: await webpageStore.managedPayloadOf(wp),
        });
    });

    router.post('/:id/versions', requireAuth, validate({ body: SummaryBody, query: NO_QUERY }), async (/** @type {import('express').Request<{ id: string }, any, import('zod').infer<typeof SummaryBody>, import('zod').infer<typeof NO_QUERY>>} */ req, /** @type {import('express').Response} */ res) => {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const summary = req.body.summary || 'Manual snapshot';
        if (wp.htmlSize + wp.cssSize + wp.jsSize + (wp.dbSize || 0) === 0) {
            return res.status(400).json({ error: 'Webpage is empty — nothing to snapshot' });
        }

        // Flush any pending DB writes before snapshotting so the version
        // contains everything the user's done up to this moment.
        try { await webpageDbStore.flush(userId, req.params.id); } catch (e) {
            log.warn('[Webpages] Pre-snapshot DB flush failed:', /** @type {Error} */ (e).message);
        }

        const version = await webpageStore.createVersion(userId, req.params.id, summary);
        res.json({ success: true, version });
    });

    /**
     * Restore a version: copy the snapshot's three slot objects back over
     * "current/*" and update the webpage's metadata hashes.
     */
    router.post('/:id/versions/:vid/restore', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (/** @type {import('express').Request<{ id: string, vid: string }, any, import('zod').infer<typeof NOTHING>, import('zod').infer<typeof NO_QUERY>>} */ req, /** @type {import('express').Response} */ res) => {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const version = await webpageStore.getVersion(userId, req.params.vid);
        if (!version || version.webpageId !== req.params.id) {
            return res.status(404).json({ error: 'Version not found' });
        }
        // The row exists, but its bytes do not any more. Restoring would then write the
        // EMPTY strings over the live page — a blank page, while the confirmation had just promised
        // that you could undo it. Refusing is the only honest answer here.
        if (version.readable === false) {
            return res.status(409).json({
                error: 'This snapshot cannot be read any more, so it cannot be restored.',
                code: 'snapshot_unreadable',
            });
        }

        // A managed page (a Solution stage) changes only through a deploy:
        // refused here, before the pre-restore snapshot below is written.
        await webpageStore.assertWebpageWrite(req.params.id, ['files'], { projectId: wp.projectId || null });

        // Snapshot the *current* state first so the restore is itself reversible.
        // Flush the DB first so the pre-restore snapshot captures pending writes too.
        try { await webpageDbStore.flush(userId, req.params.id); } catch (e) {
            log.warn('[Webpages] Pre-restore DB flush failed:', /** @type {Error} */ (e).message);
        }
        const hadContent = wp.htmlSize + wp.cssSize + wp.jsSize + (wp.dbSize || 0) > 0;
        if (hadContent) {
            try {
                // The line difference of THIS event: from what stands now to what is restored. The current
                // bytes must be read for that — that is allowed here, restoring is rare and the route
                // already does a full RustFS round anyway.
                /** @type {number | null} */
                let lineDelta = null;
                try {
                    if (!webpageStore.slotsAreReadable()) throw new Error('object storage unavailable');
                    const live = await webpageStore.readAllSlots(userId, req.params.id);
                    lineDelta = versionFacts.slotsLineDelta(live, version, webpageStore.SLOTS);
                } catch (e) {
                    // Not being able to measure is not a 0 — the row then says nothing about the
                    // number of lines, instead of "nothing changed".
                    log.warn('[Webpages] Restore line delta unavailable:', /** @type {Error} */ (e).message);
                }
                await webpageStore.createVersion(userId, req.params.id,
                    versionFacts.restoreSummary(version.seq), {
                        htmlSha: wp.htmlSha,
                        cssSha: wp.cssSha,
                        jsSha: wp.jsSha,
                        contentLength: wp.htmlSize + wp.cssSize + wp.jsSize,
                    }, 'restore', { actorUserId: userId, lineDelta });
            } catch (e) {
                log.warn('[Webpages] Pre-restore snapshot failed:', /** @type {Error} */ (e).message);
            }
        }

        // Write the snapshot's contents back to "current/" via the store helpers
        // (which also recompute sha + size).
        const updates = {};
        for (const slot of webpageStore.SLOTS) {
            const content = version[slot] || '';
            const { sha, size } = await webpageStore.writeSlot(userId, req.params.id, slot, content);
            updates[`${slot}Sha`] = sha;
            updates[`${slot}Size`] = size;
        }

        // Restore the SQLite DB binary-side: copy the version's data.db over
        // current/data.db (or delete it if the version has none), then drop
        // the cached engine handle so the next access re-opens the restored bytes.
        const restored = await webpageStore.restoreSlotFromVersion(userId, req.params.id, req.params.vid, 'db');
        await webpageDbStore.invalidate(req.params.id);
        if (restored) {
            // Re-derive sha + size from the restored object so the metadata
            // matches the at-rest blob (we don't store db sha in the version row).
            const { stream } = await storageStore.streamFile(
                storageStore.buildWebpageKey(userId, req.params.id, 'db')
            );
            const chunks = [];
            for await (const c of stream) chunks.push(c);
            const buf = Buffer.concat(chunks);
            updates.dbSha = crypto.createHash('sha256').update(buf).digest('hex');
            updates.dbSize = buf.length;
        } else {
            updates.dbSha = '';
            updates.dbSize = 0;
        }

        await webpageStore.updateWebpageMetadata(req.params.id, userId, updates);

        // Restoring is a save like any other: the slots now carry DIFFERENT `bf-*` elements from
        // a second ago, so the index must come along. This is moreover the path on which a table
        // that had been taken out in the meantime APPEARS again.
        webpageUsageSync.reconcileWebpageUsageDetached(req.params.id);

        // What fell OUTSIDE the snapshot, by name and in full. A snapshot carries only the
        // three slots plus the page database (stores/webpage/shared.js: VERSIONED_SLOTS); the extra
        // files of a multi-file project stay at the new state. Keeping quiet about that would make a
        // half-restored page look like a whole one.
        let extraFilesUntouched = 0;
        try {
            const extras = await webpageStore.listExtraFiles(req.params.id);
            extraFilesUntouched = Array.isArray(extras) ? extras.length : 0;
        } catch (e) {
            // Not being able to count is not 0: `null` says "we do not know".
            extraFilesUntouched = null;
        }
        res.json({
            success: true,
            files: { html: version.html, css: version.css, js: version.js },
            extraFilesUntouched,
        });
    });

    router.delete('/:id/versions/:vid', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (/** @type {import('express').Request<{ id: string, vid: string }, any, import('zod').infer<typeof NOTHING>, import('zod').infer<typeof NO_QUERY>>} */ req, /** @type {import('express').Response} */ res) => {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        // Scope the delete to THIS webpage so a foreign version id (belonging to
        // another tenant) can't be removed via a webpage the caller happens to
        // own. Mirrors the ownership check the GET/restore routes already do.
        const ok = await webpageStore.deleteVersion(userId, req.params.vid, req.params.id);
        if (!ok) return res.status(404).json({ error: 'Version not found' });
        res.json({ success: true });
    });
}

module.exports = { register };
