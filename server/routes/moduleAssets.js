/**
 * Module frontend assets — serves the static frontend bundle of an ACTIVE
 * remote module, and ONLY of its currently-active version.
 *
 * GET /api/module-assets/:id/:version/frontend/<path>
 *   → the file at <versionDir>/frontend/<path>, root-scoped (no traversal),
 *     with an immutable cache header (assets are content-addressed per version).
 *   → 404 for an unknown/inactive module, a non-active version, or a miss.
 *   → 500 when the module state cannot be read (the SPA shows the same Retry card).
 *
 * Session-authenticated (the SPA loads these while logged in). Mounted at
 * /api/module-assets, BEFORE the SPA catch-all.
 *
 * The year-long immutable header rides on the FILE only. It used to be set
 * before sendFile ran, so a miss answered 404 with `public, max-age=31536000,
 * immutable` still on it. A version can be active in the database before
 * this replica has its files — activated on another replica, or a container
 * restarted without them, until the reconciler heals the package from the
 * hub — and a chunk requested in that window was remembered as missing by the
 * browser, and by any shared cache, for a year: `immutable` means no reload
 * asks again. The miss now carries no cache header.
 *
 * ── Deliberately NOT behind a zod schema ────────────────────────────────
 *
 * The browser's module loader fetches these URLs (`import()`, `<link>`, and
 * whatever a bundle references in turn), not our client code, and bundles
 * append query strings of their own (`font.woff2?v=4.7.0`, cache-busters);
 * a strict query would break a module's fonts, not protect a file. The route
 * reads nothing but its path, and every part of that path is already held to
 * the store: an id that is not an active module, or a version that is not its
 * active version, is a 404 before the disk is touched, and sendFile's `root`
 * refuses any `rel` that climbs out of the version's frontend directory.
 */

'use strict';

const express = require('express');
const path = require('path');
const router = express.Router();

const { requireAuth } = require('../auth/permissions');
const modules = require('../modules');
const packageLoader = require('../modules/packageLoader');
const packageStore = require('../stores/platformModulePackageStore');

router.use(requireAuth);

const ONE_YEAR_MS = 31536000 * 1000;

// Regex route (Express 5 / path-to-regexp v8): capture id, version and the
// remaining asset path under /frontend/.
router.get(/^\/([^/]+)\/([^/]+)\/frontend\/(.+)$/, async (req, res) => {
    const id = req.params[0];
    const version = req.params[1];
    const rel = req.params[2];
    // No catch around the store reads: a database that does not answer is a
    // 500 through the terminal handler, logged with a correlation id — not a
    // 404, which said "this file does not exist" and left no trace of the
    // outage in any log.
    if (!(await modules.isModuleActive(id))) return res.status(404).end();
    const active = await packageStore.getActive(id);
    if (!active || active.version !== version) return res.status(404).end();

    const root = path.join(packageLoader.versionDir(id, version), 'frontend');
    // maxAge/immutable make send() write `public, max-age=31536000,
    // immutable` when — and only when — it is about to stream the file.
    return res.sendFile(rel, { root, dotfiles: 'deny', maxAge: ONE_YEAR_MS, immutable: true }, (err) => {
        if (err && !res.headersSent) res.status(404).end();
    });
});

module.exports = router;
