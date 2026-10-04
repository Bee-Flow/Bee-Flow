// @typecheck
'use strict';
/**
 * GET /learn-media/* — the Learning Center's video pack, served from disk.
 *
 * Lesson videos are deliberately NOT in git or in the image: a pack is a few
 * hundred MB of binaries that change on a different rhythm than the code. An
 * operator installs one with `npm run learn-media:fetch` (scripts/
 * learn-media-fetch.mjs) into LEARN_MEDIA_DIR (default server/data/learn-media,
 * gitignored). Without a pack every request here is a 404 and the lesson
 * player quietly drops its video steps (agent-hub .../onboarding/learnMedia.ts).
 *
 * What this mount allows, and nothing more:
 *   • only .mp4 / .vtt / .jpg / .webp / .json, each with an explicit type;
 *   • no directory listing, no index file, no dot files, no `..`, no
 *     encoded slashes or backslashes — the path is checked here BEFORE
 *     serve-static resolves it, and serve-static's own root check stays on;
 *   • range requests (seeking in a video) via serve-static;
 *   • caching: a content-hashed name (`clip.3f9a2b1c.mp4`) is immutable for a
 *     year, manifest.json is revalidated every time (it is what points at the
 *     new hashes), anything else gets an hour.
 *
 * The content is generic product training, identical for every tenant, so the
 * mount is public like /assets. It sits ahead of every router and the SPA
 * renderer, and answers a miss with a plain 404 — never the SPA shell, which
 * the client would otherwise try to parse as a manifest.
 */

const path = require('node:path');
const express = require('express');

const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'learn-media');

const TYPES = Object.freeze({
    '.mp4': 'video/mp4',
    '.vtt': 'text/vtt; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.json': 'application/json; charset=utf-8',
});

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const HASHED = /\.[0-9a-f]{8,64}\.[a-z0-9]+$/i;

/** The directory packs live in: LEARN_MEDIA_DIR when set, else server/data/learn-media. */
function learnMediaDir(env = process.env) {
    const configured = typeof env.LEARN_MEDIA_DIR === 'string' ? env.LEARN_MEDIA_DIR.trim() : '';
    return configured ? path.resolve(configured) : DEFAULT_DIR;
}

/**
 * Is this request path (relative to the mount, still URL-encoded) one we are
 * willing to hand to serve-static? Rejects rather than normalises: a request
 * that needs normalising is not one a real client makes.
 */
function isServablePath(urlPath) {
    if (typeof urlPath !== 'string' || urlPath.length < 2 || urlPath.length > 256) return false;
    if (!urlPath.startsWith('/')) return false;
    // Encoded separators / dots and backslashes are never part of a pack name.
    if (/%2e|%2f|%5c|\\/i.test(urlPath)) return false;
    const parts = urlPath.slice(1).split('/');
    if (parts.length > 4) return false;
    if (!parts.every((p) => SEGMENT.test(p) && !p.includes('..'))) return false;
    return Object.prototype.hasOwnProperty.call(TYPES, path.extname(urlPath).toLowerCase());
}

/** Cache-Control for a served file name. */
function cacheControlFor(fileName) {
    const base = path.basename(fileName);
    if (base === 'manifest.json') return 'no-cache';
    if (HASHED.test(base)) return 'public, max-age=31536000, immutable';
    return 'public, max-age=3600';
}

/**
 * The router mounted at /learn-media. `dir` is resolved per app start; a pack
 * installed while the server runs is picked up without a restart because
 * serve-static reads from disk on each request.
 */
function createLearnMediaRouter({ dir = learnMediaDir() } = {}) {
    const router = express.Router();
    const serve = express.static(dir, {
        index: false,
        redirect: false,
        dotfiles: 'deny',
        fallthrough: true,
        acceptRanges: true,
        etag: true,
        lastModified: true,
        // Cache-Control is ours, per file — see cacheControlFor().
        cacheControl: false,
        setHeaders(res, filePath) {
            res.setHeader('Content-Type', TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
            res.setHeader('Cache-Control', cacheControlFor(filePath));
            res.setHeader('X-Content-Type-Options', 'nosniff');
            // A CDN or another origin may front this mount; the files are
            // public and carry no credentials, so any origin may read them
            // (a <track> on a crossOrigin video needs it).
            res.setHeader('Access-Control-Allow-Origin', '*');
        },
    });

    router.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.setHeader('Allow', 'GET, HEAD');
            return res.status(405).end();
        }
        if (!isServablePath(req.path)) return res.status(404).end();
        return serve(req, res, next);
    });
    // Anything serve-static did not find: a bare 404, never the SPA shell.
    router.use((req, res) => res.status(404).end());
    return router;
}

module.exports = { createLearnMediaRouter, learnMediaDir, isServablePath, cacheControlFor, DEFAULT_DIR };
