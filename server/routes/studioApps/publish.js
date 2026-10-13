/**
 * Publish, the Nextcloud app menu, and the publish-version history (routes/studioApps/).
 *
 * Every route here that changes who can reach an app writes an audit row
 * (appStudio/publicationAudit.js).
 */

const express = require('express');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const studioAppStore = require('../../stores/studioAppStore');
const userStore = require('../../stores/userStore');
const { validateSharedGroupsForOrg } = require('../../auth');
const { canonicalizeAppDefinition } = require('../../appStudio/canonicalize');
const { validateAppDefinition } = require('../../appStudio/validate');
const { requireAuth } = require('../../auth/permissions');
// Who can reach an app is an access-control fact, so a change to it is an
// audit event — see appStudio/publicationAudit.js.
const publicationAudit = require('../../appStudio/publicationAudit');
// "Show in the Nextcloud app menu" is served by the org's connector; these
// routes tell it to sync the moment the desired list changes, instead of
// leaving the owner to wait for its poll — see appStudio/nextcloudMenuSync.js.
const nextcloudMenuSync = require('../../appStudio/nextcloudMenuSync');
// Publish / unpublish / groups, shared with a Solution stage's on/off.
const appAudience = require('../../appStudio/appAudience');
const { PublishBody, NextcloudMenuBody } = require('./schemas');
const { requireManageApps, audienceFor } = require('./access');
const { rethrowClientError, loadOwnedAutomations, loadDataRefs } = require('./appHelpers');

const router = express.Router();

// ── Publish (org/group visibility; freezes the draft) ───────────────

router.patch('/:id/publish', requireAuth, requireManageApps, validate({ body: PublishBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const app = await studioAppStore.getStudioApp(req.params.id);
        if (!app) return res.status(404).json({ error: 'App not found' });

        // Publish is owner-only (canWriteStudioApp) — app actions run automations
        // acts-as-author. Readers get a 403; everyone else the same 404 as GET.
        if (!studioAppStore.canWriteStudioApp(app, userId)) {
            const { orgIdArr, userGroups } = await audienceFor(req);
            if (studioAppStore.canReadStudioApp(app, userId, userGroups, orgIdArr)) {
                return res.status(403).json({ error: 'Only the owner can change publish state' });
            }
            return res.status(404).json({ error: 'App not found' });
        }

        const { isPublished, sharedGroups } = req.body || {};
        const publishing = !!isPublished;

        // appStudio/appAudience.js: an ordinary app freezes its validated
        // draft; an app of a Solution stage moves only its audience (its
        // published copy is the deployed release).
        const out = await appAudience.setAppAudience({
            app, publishing, sharedGroups, actorId: userId,
            // Refuse to freeze a broken draft: canonicalize + validate the
            // CURRENT stored definition, including publish-time automation checks
            // against the owner's automations (dangling/foreign/inactive
            // automationIds block publish) AND data-reference checks against
            // the app's data model + datasets (a binding/step referencing a
            // nonexistent table/dataset/field blocks publish — hard errors
            // here, warnings on draft saves). The exact validated bytes are
            // what gets frozen, which closes the publish TOCTOU.
            validateDraft: async () => {
                const { def: canonical } = canonicalizeAppDefinition(app.definition);
                const ownedAutomations = await loadOwnedAutomations(app.userId);
                const dataRefs = await loadDataRefs(req.params.id, app.userId);
                const { ok, errors, warnings } = validateAppDefinition(canonical, { ownedAutomations, ...dataRefs });
                return { ok, def: canonical, errors, warnings };
            },
            deps: {
                store: studioAppStore,
                userStore,
                validateSharedGroupsForOrg,
                // The publication audit row (appStudio/publicationAudit.js).
                audit: { auditPublishChange: (entry) => publicationAudit.auditPublishChange(entry) },
                notifyMenuChange: (orgId, meta) => nextcloudMenuSync.notifyMenuChange(orgId, meta),
            },
        });
        if (!out.ok) return res.status(out.status).json(out.body);
        res.json({
            success: true,
            isPublished: out.isPublished,
            sharedGroups: out.sharedGroups,
            // Unpublish leaves the frozen copy (and its version) untouched.
            publishedVersion: out.publishedVersion,
        });
    } catch (err) {
        rethrowClientError(err);
        log.error('[StudioApps] Publish failed:', err);
        res.status(500).json({ error: 'Failed to update publish state' });
    }
});

/**
 * PATCH /:id/nextcloud-menu — owner-only toggle for the Nextcloud app menu.
 *
 * When enabled (and the app is org-published), the organisation's Nextcloud
 * connector registers a top-menu entry for this app on its next sync, so the
 * app opens on its own page inside Nextcloud. The flag survives unpublish —
 * the connector list (routes/nextcloudStudioApps.js) filters on is_published,
 * so the entry disappears with the publish state and returns with it.
 *
 * Body: { enabled: boolean }. Enabling requires a live published copy: a menu
 * entry pointing at an app every viewer 404s on is a broken icon, not a
 * feature.
 *
 * After the write, the org's connector is asked to sync NOW and the route
 * waits (briefly) for its verdict, so the response can carry
 *   `ncConnected` — does the org have a paired connector at all, and
 *   `ncSync`      — 'synced' when the connector confirmed the OCS rows exist,
 *                   else why not (see appStudio/nextcloudMenuSync.js),
 * and the dialog can say "reload Nextcloud to see it" only when that is true,
 * and "within a few minutes" (the poll backstop) when it is not.
 */
router.patch('/:id/nextcloud-menu', requireAuth, requireManageApps, validate({ body: NextcloudMenuBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const app = await studioAppStore.getStudioApp(req.params.id);
        if (!app) return res.status(404).json({ error: 'App not found' });

        // Same gate shape as publish: owner-only; readers 403, strangers 404.
        if (!studioAppStore.canWriteStudioApp(app, userId)) {
            const { orgIdArr, userGroups } = await audienceFor(req);
            if (studioAppStore.canReadStudioApp(app, userId, userGroups, orgIdArr)) {
                return res.status(403).json({ error: 'Only the owner can change the Nextcloud menu setting' });
            }
            return res.status(404).json({ error: 'App not found' });
        }

        const enabled = !!(req.body && req.body.enabled);
        if (enabled && (!app.isPublished || !app.publishedDefinition)) {
            return res.status(409).json({
                error: 'Publish the app first — the Nextcloud menu can only show published apps',
                code: 'not_published',
            });
        }

        const updated = await studioAppStore.setStudioAppNextcloudMenu(req.params.id, app.userId, enabled);
        if (!updated) return res.status(500).json({ error: 'Failed to update Nextcloud menu setting' });
        // Not an access change on its own — the app is already org-published to
        // get here — but it puts the app in front of everyone in the
        // organisation, so it belongs on the same trail.
        await publicationAudit.auditNextcloudMenu({ app, actorId: req.session.user.id, enabled });

        // Never throws; a connector that is down or absent is an outcome, not
        // an error — the toggle itself has already been saved.
        const sync = app.organizationId
            ? await nextcloudMenuSync.requestMenuSync(app.organizationId, { reason: 'nextcloud_menu', appId: app.id })
            : { outcome: 'not_connected' };

        res.json({
            success: true,
            nextcloudMenu: updated.nextcloudMenu,
            ncConnected: sync.outcome !== 'not_connected',
            ncSync: sync.outcome,
        });
    } catch (err) {
        rethrowClientError(err);
        log.error('[StudioApps] Nextcloud menu toggle failed:', err);
        res.status(500).json({ error: 'Failed to update Nextcloud menu setting' });
    }
});

// ── Publish-version history (owner-only) ────────────────────────────

router.get('/:id/versions', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const app = await studioAppStore.getStudioApp(req.params.id);
        if (!app || app.userId !== userId) return res.status(404).json({ error: 'App not found' });
        const versions = await studioAppStore.listVersions(req.params.id, userId);
        res.json({ versions });
    } catch (err) {
        rethrowClientError(err);
        log.error('[StudioApps] List versions failed:', err);
        res.status(500).json({ error: 'Failed to list versions' });
    }
});

router.post('/:id/versions/:versionId/restore', requireAuth, requireManageApps, async (req, res) => {
    try {
        const userId = req.session.user.id;
        // restoreVersion is scoped to app AND owner; it bumps definition_version
        // so open editors' CAS saves conflict instead of clobbering the restore.
        const updated = await studioAppStore.restoreVersion(req.params.id, req.params.versionId, userId);
        if (!updated) return res.status(404).json({ error: 'Version not found' });
        res.json({ success: true, version: updated.definitionVersion });
    } catch (err) {
        rethrowClientError(err);
        log.error('[StudioApps] Restore version failed:', err);
        res.status(500).json({ error: 'Failed to restore version' });
    }
});

module.exports = router;
