// @typecheck
/**
 * Customer stories of the CMS: the public read behind the "Customer stories"
 * grid block.
 *
 *   PUBLIC (no auth, mounted as /api/cms/stories):
 *     GET  /?locale=&limit=&sector=   the story cards of the LIVE site's
 *                                     published pages (pages that carry a
 *                                     story-header block), in page order.
 *
 * The stories themselves are ordinary pages, edited and published like any
 * other: there is no admin endpoint here. Only the last PUBLISHED snapshot is
 * read, so a draft story never reaches a visitor through this route.
 */

'use strict';

const express = require('express');
const { getPublishedStories } = require('../stores/cms/stories');
const { STORY_GRID_MAX } = require('../i18n/defaults/cmsDefaults');

const LOCALE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
/** @param {unknown} v */
const first = (v) => (typeof v === 'string' ? v : '');

function createPublicRouter() {
    const router = express.Router();
    // No schema on this query on purpose, like GET /api/cms/blog/posts: it
    // feeds a public page, and a refusal would blank a block instead of
    // degrading it to "no stories".
    router.get('/', async (req, res) => {
        res.set('Cache-Control', 'public, max-age=60, s-maxage=120');
        const siteId = await require('./cmsShared').getLiveSiteId();
        if (!siteId) return res.json({ stories: [] });
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- LOCALE_RE repeats a group that starts with a '-' its class excludes (linear), and the input is cut at the first '-'
        const locale = first(req.query.locale).toLowerCase().split('-')[0];
        const limit = Number.parseInt(first(req.query.limit), 10);
        const { stories, locale: served } = await getPublishedStories(siteId, {
            locale: LOCALE_RE.test(locale) ? locale : undefined,
            limit: Number.isFinite(limit) ? Math.min(STORY_GRID_MAX, Math.max(1, limit)) : STORY_GRID_MAX,
            sector: first(req.query.sector).slice(0, 60),
        });
        return res.json({ stories, locale: served });
    });
    return router;
}

module.exports = { createPublicRouter };
