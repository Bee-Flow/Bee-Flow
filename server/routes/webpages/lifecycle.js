/**
 * Het einde en de aftakking van een pagina: klonen en verwijderen.
 *
 * POST /:id/clone  ·  DELETE /:id
 *
 * De twee staan bij elkaar omdat ze dezelfde vraag stellen vanaf twee kanten:
 * wat hangt er aan deze pagina, en wat moet er dan mee? De verwijderpoort zelf
 * staat in ./deleteGuard.js.
 */

const webpageStore = require('../../stores/webpageStore');
const webpageDbStore = require('../../stores/webpageDbStore');
const kbStore = require('../../stores/knowledgeBases');
const { resolveAudienceContext } = require('../../auth/audience');
const { requireAuth } = require('../../auth/permissions');
const webpageUsageSync = require('../../core/webpages/webpageUsageSync');
const { describeWebpageDeleteBlock } = require('./deleteGuard');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { worded, bodyOf, flag, NOTHING, NO_QUERY } = require('./schemas');
const log = require('../../telemetry/log');

const CloneBody = bodyOf({
    name: worded('Een naam is tekst.').trim().max(200, 'Een naam is hoogstens 200 tekens.').optional(),
});

// De bevestiging van de 409-poort. Beide spellingen die een URL kan dragen
// tellen — zo stond het er al — maar `?confrim=1` is nu een 400 in plaats van
// stilzwijgend "nee": op deze route is "nee" een tweede ronde door een dialoog
// die de lijst al had laten zien.
const CONFIRM_TEXT = 'confirm is true of false.';
const DeleteQuery = z.object({ confirm: flag(CONFIRM_TEXT) }).strict();

function register(router) {
    router.post('/:id/clone', requireAuth, validate({ body: CloneBody, query: NO_QUERY }), async (req, res) => {
        try {
            const sourceId = req.params.id;
            const { name } = req.body;
            const { userId, orgIds, userGroups } = await resolveAudienceContext(req);
            const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);

            // Visibility gate: owner OR audience member of an org/group the source
            // is published to. Mirrors the GET /:id rules so anyone who can read
            // the page can also fork it onto their own account.
            const source = await webpageStore.getWebpageRaw(sourceId);
            if (!source || !webpageStore.canReadWebpage(source, userId, userGroups, orgIdArr)) {
                return res.status(404).json({ error: 'Webpage not found' });
            }

            // Flush as the SOURCE owner — they're the only one who can hold an
            // open SQLite handle. Best-effort: when the handle isn't loaded in
            // this server process the call rejects and we proceed regardless.
            try { await webpageDbStore.flush(source.userId, sourceId); } catch (_) { /* not loaded or not the owner — fine */ }

            const cloned = await webpageStore.cloneWebpage({ sourceId, newOwnerId: userId, newName: name });
            if (!cloned) return res.status(404).json({ error: 'Webpage not found' });
            // De KLOON, niet de bron: die kreeg de code én de tabelbindingen mee en
            // is vanaf nu een tweede gebruiker van dezelfde tabellen. Zonder deze
            // regel is de enige pagina die niet in de index staat degene die er net
            // bij kwam. De reconcile leest als de NIEUWE eigenaar (hij zoekt de
            // eigenaar zelf op), dus een kloon op een ander account werkt ook.
            webpageUsageSync.reconcileWebpageUsageDetached(cloned.id);
            res.json({ success: true, webpage: cloned });
        } catch (err) {
            // A refusal worded for the caller (409 managed_part) keeps its status and code.
            if (err?.status && err.status < 500) throw err;
            log.error('[Webpages] Clone failed:', err);
            res.status(500).json({ error: 'Failed to clone webpage' });
        }
    });

    router.delete('/:id', requireAuth, validate({ body: NOTHING, query: DeleteQuery }), async (req, res) => {
        try {
            const userId = req.session.user.id;
            const confirmed = req.query.confirm === true;

            // Eigenaar-gescoopt, net als de verwijdering zelf: een niet-eigenaar
            // krijgt dezelfde 404 als altijd en leert niets over de pagina.
            const wp = await webpageStore.getWebpage(req.params.id, userId);
            if (!wp) return res.status(404).json({ error: 'Webpage not found' });

            // A managed page (a Solution stage) is retired by a deploy, never
            // deleted. Refused here, before invalidate() below drops the
            // unflushed data.db writes of the page.
            await webpageStore.assertWebpageWrite(req.params.id, ['delete'], { projectId: wp.projectId || null });

            if (!confirmed) {
                const blocked = await describeWebpageDeleteBlock(wp, userId);
                if (blocked) return res.status(409).json(blocked);
            }

            // Drop any cached DB handle/local file before the row goes away —
            // purgeWebpageObjects (called inside deleteWebpage) wipes the RustFS
            // blob, so leaving a stale handle open would only confuse the next
            // access to the (now-deleted) webpage.
            try { await webpageDbStore.invalidate(req.params.id); } catch (_) {}
            const result = await webpageStore.deleteWebpage(req.params.id, userId);
            if (!result) return res.status(404).json({ error: 'Webpage not found' });

            // Er is geen FK van automation_datatable_usage naar `webpages` — die
            // tabel hoort bij een andere store — dus niets ruimt deze rijen op.
            // Blijven ze staan, dan vertelt de "Wordt gebruikt door"-lijst van een
            // tabel dat iets wat niemand kan openen hem gebruikt, en houdt de
            // 409-poort een verwijdering tegen op een pagina die niet meer bestaat.
            // Ge-await, in tegenstelling tot de reconcile: dit is het laatste moment
            // waarop iemand deze pagina noemt. purgeWebpageUsage gooit nooit.
            await webpageUsageSync.purgeWebpageUsage(req.params.id);

            // Clean up auto-created KBs
            if (result.knowledgeBaseIds?.length > 0) {
                for (const kbId of result.knowledgeBaseIds) {
                    try { await kbStore.deleteKB(kbId); } catch (e) {
                        log.warn(`[Webpages] KB cleanup for ${kbId}:`, e.message);
                    }
                }
            }

            res.json({ success: true });
        } catch (err) {
            // A refusal worded for the caller (409 managed_part) keeps its status and code.
            if (err?.status && err.status < 500) throw err;
            log.error('[Webpages] Delete failed:', err);
            res.status(500).json({ error: 'Failed to delete webpage' });
        }
    });
}

module.exports = { register };
