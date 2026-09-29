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
const { z } = require('zod');
const { worded, bodyOf, whole, NOTHING, NO_QUERY } = require('./schemas');
const log = require('../../telemetry/log');

// De bladwijzer van de geschiedenislijst. `.strict()`, want elke andere
// parameter die iemand hier verwacht — een filter op bron, op maker — komt
// terug als "de laatste 50", en dat is een ANDER antwoord dan de vraag.
const ListQuery = z.object({ limit: whole('limit'), offset: whole('offset') }).strict();

const SummaryBody = bodyOf({
    summary: worded('Een samenvatting is tekst.').trim().max(500, 'Een samenvatting is hoogstens 500 tekens.').optional(),
});

function register(router) {
    router.get('/:id/versions', requireAuth, validate({ query: ListQuery }), async (req, res) => {
        try {
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

            // WELKE versie het publiek leest, als eigen veld — niet als iets dat de
            // client uit de rijen moet afleiden. De gepinde rij kan buiten deze
            // bladzijde vallen (of, bij een wijzer naar een verdwenen rij,
            // helemaal niet meer bestaan), en dan zou "zoek hem in de lijst" een
            // pagina zonder chip opleveren terwijl er wél iets gepubliceerd is.
            let published = null;
            if (publishedVersionId) {
                const meta = await webpageStore.getVersionMeta(publishedVersionId);
                // getVersionMeta leest op id alleen; de pagina-check hoort erbij,
                // anders zou een wijzer naar een andere pagina hier een nummer
                // krijgen dat in déze lijst niets betekent.
                published = (meta && meta.webpageId === req.params.id)
                    ? { versionId: meta.id, seq: meta.seq }
                    : null;
            }

            res.json({
                versions: page.map(r => decorateVersionRow(r, { viewerId: userId, names, publishedVersionId })),
                hasMore,
                published,
                // WAT deze lijst dekt. Zonder dit veld kan het scherm een lege lijst
                // alleen verklaren met "je hebt nog niet genoeg bewerkt", en op het
                // standaard projecttype is dat onwaar.
                coverage: versionCoverage(wp),
            });
        } catch (err) {
            log.error('[Webpages] List versions failed:', err);
            res.status(500).json({ error: 'Failed to list versions' });
        }
    });

    router.get('/:id/versions/:vid', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
        try {
            const userId = req.session.user.id;
            const wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });

            const version = await webpageStore.getVersion(userId, req.params.vid);
            if (!version || version.webpageId !== req.params.id) {
                return res.status(404).json({ error: 'Version not found' });
            }
            // Dezelfde vorm als een rij uit de lijst — "Bekijk" opent een rij die
            // de gebruiker daar zag, en die mag niet opeens een andere maker of een
            // ander nummer dragen omdat hij via een tweede route binnenkomt.
            const names = await versionActorNames([version], req.session.user);
            res.json({
                version: decorateVersionRow(version, {
                    viewerId: userId,
                    names,
                    publishedVersionId: wp.publishedVersionId || null,
                }),
            });
        } catch (err) {
            log.error('[Webpages] Get version failed:', err);
            res.status(500).json({ error: 'Failed to get version' });
        }
    });

    router.post('/:id/versions', requireAuth, validate({ body: SummaryBody, query: NO_QUERY }), async (req, res) => {
        try {
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
                log.warn('[Webpages] Pre-snapshot DB flush failed:', e.message);
            }

            const version = await webpageStore.createVersion(userId, req.params.id, summary);
            res.json({ success: true, version });
        } catch (err) {
            log.error('[Webpages] Create version failed:', err);
            res.status(500).json({ error: 'Failed to create version' });
        }
    });

    /**
     * Restore a version: copy the snapshot's three slot objects back over
     * "current/*" and update the webpage's metadata hashes.
     */
    router.post('/:id/versions/:vid/restore', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (req, res) => {
        try {
            const userId = req.session.user.id;
            const wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });

            const version = await webpageStore.getVersion(userId, req.params.vid);
            if (!version || version.webpageId !== req.params.id) {
                return res.status(404).json({ error: 'Version not found' });
            }
            // De rij bestaat, maar zijn bytes niet meer. Terugzetten zou dan de
            // LEGE strings over de levende pagina schrijven — een blanco pagina,
            // terwijl de bevestiging net beloofde dat je het kon terugdraaien.
            // Weigeren is hier het enige eerlijke antwoord.
            if (version.readable === false) {
                return res.status(409).json({
                    error: 'This snapshot cannot be read any more, so it cannot be restored.',
                    code: 'snapshot_unreadable',
                });
            }

            // Snapshot the *current* state first so the restore is itself reversible.
            // Flush the DB first so the pre-restore snapshot captures pending writes too.
            try { await webpageDbStore.flush(userId, req.params.id); } catch (e) {
                log.warn('[Webpages] Pre-restore DB flush failed:', e.message);
            }
            const hadContent = wp.htmlSize + wp.cssSize + wp.jsSize + (wp.dbSize || 0) > 0;
            if (hadContent) {
                try {
                    // Het regelverschil van DEZE gebeurtenis: van wat er nu staat
                    // naar wat er wordt teruggezet. De huidige bytes moeten daarvoor
                    // gelezen worden — dat mag hier, terugzetten is zeldzaam en de
                    // route doet toch al een volledige RustFS-ronde.
                    let lineDelta = null;
                    try {
                        if (!webpageStore.slotsAreReadable()) throw new Error('object storage unavailable');
                        const live = await webpageStore.readAllSlots(userId, req.params.id);
                        lineDelta = versionFacts.slotsLineDelta(live, version, webpageStore.SLOTS);
                    } catch (e) {
                        // Niet kunnen meten is geen 0 — de rij zegt dan niets over
                        // het aantal regels, in plaats van "er veranderde niets".
                        log.warn('[Webpages] Restore line delta unavailable:', e.message);
                    }
                    await webpageStore.createVersion(userId, req.params.id,
                        versionFacts.restoreSummary(version.seq), {
                            htmlSha: wp.htmlSha,
                            cssSha: wp.cssSha,
                            jsSha: wp.jsSha,
                            contentLength: wp.htmlSize + wp.cssSize + wp.jsSize,
                        }, 'restore', { actorUserId: userId, lineDelta });
                } catch (e) {
                    log.warn('[Webpages] Pre-restore snapshot failed:', e.message);
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

            // Terugzetten is een save als elke andere: de slots dragen nu ANDERE
            // `bf-*`-elementen dan een seconde geleden, dus de index moet mee. Dit
            // is bovendien het pad waarop een tabel weer VERSCHIJNT die er in de
            // tussentijd uit was gehaald.
            webpageUsageSync.reconcileWebpageUsageDetached(req.params.id);

            // Wat er BUITEN de momentopname viel, met naam en toenaam. Een
            // momentopname draagt alleen de drie slots plus de paginadatabank
            // (stores/webpage/shared.js: VERSIONED_SLOTS); de extra bestanden van een
            // multi-file project blijven op de nieuwe stand staan. Dat verzwijgen zou
            // van een half teruggezette pagina een hele lijken maken.
            let extraFilesUntouched = 0;
            try {
                const extras = await webpageStore.listExtraFiles(req.params.id);
                extraFilesUntouched = Array.isArray(extras) ? extras.length : 0;
            } catch (e) {
                // Niet kunnen tellen is geen 0: `null` zegt "we weten het niet".
                extraFilesUntouched = null;
            }
            res.json({
                success: true,
                files: { html: version.html, css: version.css, js: version.js },
                extraFilesUntouched,
            });
        } catch (err) {
            log.error('[Webpages] Restore version failed:', err);
            res.status(500).json({ error: 'Failed to restore version' });
        }
    });

    router.delete('/:id/versions/:vid', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (req, res) => {
        try {
            const userId = req.session.user.id;
            const wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });

            // Scope the delete to THIS webpage so a foreign version id (belonging to
            // another tenant) can't be removed via a webpage the caller happens to
            // own. Mirrors the ownership check the GET/restore routes already do.
            const ok = await webpageStore.deleteVersion(userId, req.params.vid, req.params.id);
            if (!ok) return res.status(404).json({ error: 'Version not found' });
            res.json({ success: true });
        } catch (err) {
            log.error('[Webpages] Delete version failed:', err);
            res.status(500).json({ error: 'Failed to delete version' });
        }
    });
}

module.exports = { register };
