/**
 * Studio-app listing for the Nextcloud connector.
 *
 * The connector polls this to learn which App Studio apps it should expose as
 * top-menu entries in the organisation's Nextcloud (one icon per app, each
 * opening on its own embedded page). See
 * `nextcloud-connector/src/studioAppMenus.js` for the other half: it
 * reconciles this list against AppAPI's `ui/top-menu` registrations.
 *
 * Auth: the connector's tenant-key HMAC (auth/connectorSig) — machine-to-
 * machine, no user session; the org is identified by its NC instance id.
 * That org scoping is the whole security story here: a connector only ever
 * sees the menu list of the org its instance id is bound to, and the payload
 * is card metadata only (never definitions, never data).
 *
 * The list is owner-opted-in per app (studio_apps.nextcloud_menu) AND filtered
 * to currently-published apps — an unpublished app drops off the menu on the
 * connector's next sync. That sync is no longer only the connector's poll:
 * every route that changes this list pushes `/hooks/studio-menus` on the
 * connector first (appStudio/nextcloudMenuSync.js), and the poll is the
 * backstop. Access enforcement for actually OPENING an app stays with the
 * normal viewer path (canReadStudioApp + RLS): a menu entry is instance-wide
 * in Nextcloud (AppAPI offers no per-group entries), so an org member outside
 * the app's audience gets the "shared with specific groups" screen.
 *
 * ── Deliberately NOT behind a zod schema ────────────────────────────────
 *
 * The route reads nothing but the two signed headers. Its query string is
 * part of the signed message (`originalUrl`, see auth/connectorSig.js), so
 * only the tenant-key holder can put one there, and the connector's poll
 * sends none (studioAppMenus.js signs the bare LIST_PATH). The connector
 * ships inside each customer's Nextcloud and upgrades on its own schedule:
 * a strict query would turn a parameter a newer connector adds into a menu
 * that stops syncing against an older server. Ignoring one is the safe side
 * here — whatever is asked, the answer is the org's published, opted-in
 * apps, never more.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();

const { verifyConnectorSig } = require('../auth/connectorSig');

// GET /api/nextcloud/studio-apps
router.get('/', async (req, res) => {
    try {
        const org = await verifyConnectorSig(req);
        if (!org) return res.status(401).json({ error: 'unauthorized' });

        const studioAppStore = require('../stores/studioAppStore');
        const apps = await studioAppStore.listNextcloudMenuApps(org.id);
        res.json({
            apps: apps.map(a => ({
                id: a.id,
                name: a.name,
                description: a.description || '',
                // The Studio icon is a Lucide icon NAME (e.g. 'Scissors'), not
                // an image. The connector renders its own monochrome SVG for
                // the NC top bar; the name and accent ride along for future use.
                icon: a.icon || null,
                accentColor: a.accentColor || null,
                updatedAt: a.updatedAt,
                publishedAt: a.publishedAt,
            })),
        });
    } catch (err) {
        log.error(`[NextcloudStudioApps] list failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to list apps' });
    }
});

module.exports = router;
