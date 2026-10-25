// @typecheck noImplicitAny
'use strict';
/**
 * Static file serving, moved verbatim out of server/index.js. Two halves, at
 * opposite ends of the chain:
 *
 *   mountStaticAssets  ahead of every router: the built SPA's assets (production
 *                      only), the allow-listed /uploads and the Learning Center
 *                      video pack
 *   mountSpaFallback   after every router and the marketing renderer: index.html
 *                      for whatever path is left (production only)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const defaultLog = require('../telemetry/log');

const AGENT_HUB_DIST_PATH = path.resolve(__dirname, '../../agent-hub/dist');
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');

/**
 * @param {{ use: Function }} app
 * @param {{ log?: { info: Function } }} [opts]
 */
function mountStaticAssets(app, { log = defaultLog } = {}) {
    const agentHubDistPath = AGENT_HUB_DIST_PATH;
    if (process.env.NODE_ENV === 'production' && fs.existsSync(agentHubDistPath)) {
        // Hashed Vite assets get long-lived immutable cache; everything else (index.html) gets no-cache
        app.use('/assets', express.static(path.join(agentHubDistPath, 'assets'), {
            maxAge: '1y',
            immutable: true,
        }));
        app.use(express.static(agentHubDistPath, {
            maxAge: 0,
            setHeaders: (res, filePath) => {
                if (filePath.endsWith('.html')) {
                    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                    res.setHeader('Pragma', 'no-cache');
                    res.setHeader('Expires', '0');
                }
            },
        }));
        log.info('[Production] Serving static files from agent-hub:', agentHubDistPath);
    }
    // `data/uploads` mixes public images (avatars, org logos, agents/) with private
    // user content (`saved-recordings/` — every meeting's raw audio). This mount
    // authenticates nothing and sits ahead of every router, so it is gated by an
    // allowlist. See middleware/publicUploads.js for why.
    app.use('/uploads', require('../middleware/publicUploads').publicUploadsOnly);
    app.use('/uploads', express.static(UPLOADS_DIR));
    // Learning Center video pack (LEARN_MEDIA_DIR, outside git and the image).
    // Public, allow-listed file types, a bare 404 on a miss so the SPA renderer
    // never answers for it. See learning/learnMedia.js.
    app.use('/learn-media', require('../learning/learnMedia').createLearnMediaRouter());
}

/** @param {{ use: Function }} app */
function mountSpaFallback(app) {
    const agentHubDistPath = AGENT_HUB_DIST_PATH;
    if (process.env.NODE_ENV === 'production') {
        const indexPath = path.join(agentHubDistPath, 'index.html');
        if (fs.existsSync(indexPath)) {
            app.use((/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
                res.sendFile(indexPath);
            });
        }
    }
}

module.exports = { mountStaticAssets, mountSpaFallback, AGENT_HUB_DIST_PATH, UPLOADS_DIR };
