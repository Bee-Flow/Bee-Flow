// @typecheck strict
'use strict';
/**
 * The mounts of module "cms" (the product website): its rows of the route table that
 * the core mounts, as data (modules/firstParty/contract.js MountRow). Order: the
 * core's (modules/firstParty/order.json "mounts"); routers are required at mount time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    // Anonymous marketing endpoint (github-stats block on the public site).
    { key: 'cms:/api/public', slot: 'main', path: '/api/public', handlers: () => [require('../routes/publicGithubStats')] },
    // CMS AI builder — mounted BEFORE /api/cms so the more-specific prefix wins.
    { key: 'cms:/api/cms/builder', slot: 'main', path: '/api/cms/builder', handlers: () => [require('../routes/ai/cmsBuilder')] },
    { key: 'cms:/api/cms', slot: 'main', path: '/api/cms', handlers: () => [require('../routes/cms')] },
    // Release notes. /ingest is token-gated (CI drafts on every build), /public is
    // anonymous but serves PUBLISHED entries only — machine-written copy always
    // passes a human via /admin/:id/publish before a customer sees it.
    { key: 'cms:/api/release-notes', slot: 'main', path: '/api/release-notes', handlers: () => [require('../routes/releaseNotes')] },
    // ── Server-rendered marketing pages, robots.txt and sitemap.xml ──────────────
    // Mounted LAST and deliberately (the 'fallback' slot: after the JSON 404 of
    // unmatched API paths, before the SPA fallback): it claims no path of its own,
    // it only answers what every route above declined. A request that is not a
    // published CMS page falls straight through via next().
    //
    // This is what crawlers and social scrapers receive. Until it existed the
    // marketing site served `<div id="root"></div>` plus the app's own default
    // title, so every link shared to LinkedIn or Slack — which do not run
    // JavaScript — rendered as "Bee Flow - AI / Chat with AI agents powered by Bee
    // Flow" no matter which page it pointed at.
    { key: 'cms:publicRender', slot: 'fallback', path: null, handlers: () => [require('../routes/publicRender')] },
];

module.exports = { mounts };
