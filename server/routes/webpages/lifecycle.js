// @typecheck
/**
 * The end and the branch of a page: cloning and deleting.
 *
 * POST /:id/clone  ·  DELETE /:id
 *
 * The two stand together because they ask the same question from two sides:
 * what hangs on this page, and what must happen to it then? The delete gate itself
 * is in ./deleteGuard.js.
 */

const webpageStore = require('../../stores/webpageStore');
const webpageDbStore = require('../../stores/webpageDbStore');
const kbStore = require('../../stores/knowledgeBases');
const { resolveAudienceContext } = require('../../auth/audience');
const { requireAuth } = require('../../auth/permissions');
const webpageUsageSync = require('../../core/webpages/webpageUsageSync');
const { describeWebpageDeleteBlock } = require('./deleteGuard');
const { validate } = require('../../core/http/validate');
const { z } = require('../../utils/zod');
const { worded, bodyOf, flag, NOTHING, NO_QUERY } = require('./schemas');
const log = require('../../telemetry/log');

const CloneBody = bodyOf({
    name: worded('Een naam is tekst.').trim().max(200, 'Een naam is hoogstens 200 tekens.').optional(),
});

// The confirmation of the 409 gate. Both spellings a URL can carry count — that is how
// it already stood — but `?confrim=1` is now a 400 instead of silently "no": on this
// route, "no" is a second round through a dialog that had already shown the list.
const CONFIRM_TEXT = 'confirm is true of false.';
const DeleteQuery = z.object({ confirm: flag(CONFIRM_TEXT) }).strict();

function register(router) {
    router.post('/:id/clone', requireAuth, validate({ body: CloneBody, query: NO_QUERY }), async (req, res) => {
        const sourceId = req.params.id;
        const { name } = req.body;
        const { userId, orgIds, userGroups } = await resolveAudienceContext(req);
        const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);

        // Visibility gate: owner OR audience member of an org/group the source
        // is published to. Mirrors the GET /:id rules so anyone who can read
        // the page can also fork it onto their own account.
        const source = await webpageStore.getWebpageRaw(sourceId);
        if (!source || !await webpageStore.canReadWebpageAsync(source, userId, userGroups, orgIdArr)) {
            return res.status(404).json({ error: 'Webpage not found' });
        }

        // Flush as the SOURCE owner — they're the only one who can hold an
        // open SQLite handle. Best-effort: when the handle isn't loaded in
        // this server process the call rejects and we proceed regardless.
        try { await webpageDbStore.flush(source.userId, sourceId); } catch (err) { log.debug('not loaded or not the owner — fine', err); }

        const cloned = await webpageStore.cloneWebpage({ sourceId, newOwnerId: userId, newName: name });
        if (!cloned) return res.status(404).json({ error: 'Webpage not found' });
        // The CLONE, not the source: that got the code AND the table bindings along and is from
        // now on a second user of the same tables. Without this line, the only page that is not
        // in the index is the one that just came into being. The reconcile reads as the NEW owner
        // (it looks up the owner itself), so a clone on another account works too.
        webpageUsageSync.reconcileWebpageUsageDetached(cloned.id);
        res.json({ success: true, webpage: cloned });
    });

    router.delete('/:id', requireAuth, validate({ body: NOTHING, query: DeleteQuery }), async (req, res) => {
        const userId = req.session.user.id;
        const confirmed = req.query.confirm === true;

        // Owner-scoped, just like the deletion itself: a non-owner gets the same 404 as always and
        // learns nothing about the page.
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
        try { await webpageDbStore.invalidate(req.params.id); } catch (_) { log.debug('no cached database handle to invalidate', _); }
        const result = await webpageStore.deleteWebpage(req.params.id, userId);
        if (!result) return res.status(404).json({ error: 'Webpage not found' });

        // There is no FK from automation_datatable_usage to `webpages` — that table belongs to
        // another store — so nothing cleans up these rows. If they stay, the "Used by" list of a
        // table says that something nobody can open uses it, and the 409 gate holds a deletion
        // back on a page that no longer exists. Awaited, unlike the reconcile: this is the last
        // moment at which someone names this page. purgeWebpageUsage never throws.
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
    });
}

module.exports = { register };
