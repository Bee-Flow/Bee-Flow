// @typecheck strict
'use strict';
/**
 * The mounts of module "apps" (App Studio): its rows of the route table that the core
 * mounts, as data (modules/firstParty/contract.js MountRow). One row per app.use
 * line it replaces, with the same gates; the order of the rows is the core's
 * (modules/firstParty/order.json "mounts"); every router is required inside its row, at mount
 * time.
 */

/** @typedef {import('../modules/firstParty/contract').MountRow} MountRow */

/** @type {MountRow[]} */
const mounts = [
    { key: 'apps:/apps', slot: 'main', path: '/apps', handlers: (g) => [g.requireModule('apps'), require('../routes/apps')] },
    // Studio apps the connector should expose in the Nextcloud app menu. Same
    // machine-to-machine tenant-key HMAC as task-processing (no session).
    { key: 'apps:/api/nextcloud/studio-apps', slot: 'main', path: '/api/nextcloud/studio-apps', handlers: (g) => [g.requireModule('apps'), require('../routes/nextcloudStudioApps')] },
    // Mount the builder before CRUD so /builder resolves before /:id.
    // Both the published directory and Studio use this API. Each resource still checks its audience or owner.
    { key: 'apps:/api/studio-apps#permission', slot: 'main', path: '/api/studio-apps', handlers: (g) => [g.requireAnyPermission('use_apps', 'manage_apps')] },
    { key: 'apps:/api/studio-apps/builder', slot: 'main', path: '/api/studio-apps/builder', handlers: (g) => [g.requireModule('apps'), g.requireCapability('app_studio'), require('../routes/studioApps/access').requireManageApps, g.requireTraining('apps'), require('../routes/ai/appStudioBuilder')] },
    // Usage aggregate (APPS-08): GET /usage-counts, read-only and org-scoped.
    // Mounted BEFORE the CRUD router for the same reason the builder router is —
    // otherwise studioApps.js's GET /:id captures /usage-counts.
    { key: 'apps:/api/studio-apps#usage', slot: 'main', path: '/api/studio-apps', handlers: (g) => [g.requireModule('apps'), g.requireCapability('app_studio'), require('../routes/studioAppUsage')] },
    { key: 'apps:/api/studio-apps#crud', slot: 'main', path: '/api/studio-apps', handlers: (g) => [g.requireModule('apps'), g.requireCapability('app_studio'), g.requireTraining('apps'), require('../routes/studioApps')] },
    { key: 'apps:/api/studio-apps#run', slot: 'main', path: '/api/studio-apps', handlers: (g) => [g.requireModule('apps'), g.requireCapability('app_studio'), require('../routes/studioAppsRun')] },
    { key: 'apps:/api/studio-apps#data', slot: 'main', path: '/api/studio-apps', handlers: (g) => [g.requireModule('apps'), g.requireCapability('app_studio'), require('../routes/studioAppData')] },
    { key: 'apps:/api/studio-apps#connectors', slot: 'main', path: '/api/studio-apps', handlers: (g) => [g.requireModule('apps'), g.requireCapability('app_studio'), require('../routes/studioAppConnectors')] },
    { key: 'apps:/api/studio-apps#files', slot: 'main', path: '/api/studio-apps', handlers: (g) => [g.requireModule('apps'), g.requireCapability('app_studio'), require('../routes/studioAppFiles'), require('../routes/studioAppAssets.mts').studioAppAssetsRouter] },
    // LARGE datasets (multi-GB genome files): multipart upload + status, on
    // /:id/large-datasets. Not /:id/datasets: that is studioAppData's BI datasets
    // above, and the first match wins (the choice is in the router's header). The
    // large_datasets licence gate is the first handler of each of its routes, never
    // path-less on the router, so requests for the routers after it pass untouched.
    { key: 'apps:/api/studio-apps#datasets', slot: 'main', path: '/api/studio-apps', handlers: (g) => [g.requireModule('apps'), g.requireCapability('app_studio'), require('../routes/studioAppDatasets')] },
    // AI browsing (the ONE streaming ai_browse step endpoint) and Studio documents in an app (viewer, picker, compare).
    { key: 'apps:/api/studio-apps#browse', slot: 'main', path: '/api/studio-apps', handlers: (g) => [g.requireModule('apps'), g.requireCapability('app_studio'), require('../routes/studioAppBrowse'), require('../routes/studioAppDocuments')] },
    // The public surface of a Studio app — an anonymous visitor filling in the
    // intake screens of an app whose back-office stays behind requireAuth. The URL
    // token is the credential; what it exposes is a whitelist of SCREENS in the
    // app's own definition (appStudio/publicAccess.js). No capability gate: its visitors are anonymous third
    // parties, as for /share (module webpages). /api/app-hooks: a signed delivery to a webhook trigger (routes/studioAppWebhook.mts).
    { key: 'apps:/api/public-app', slot: 'main', path: '/api/public-app', handlers: (g) => [g.requireModule('apps'), require('../routes/studioAppPublic'), require('../routes/studioAppPublicAssets.mts').publicAppAssetsRouter] },
    { key: 'apps:/api/app-hooks', slot: 'main', path: '/api/app-hooks', handlers: (g) => [g.requireModule('apps'), require('../routes/studioAppWebhook.mts').studioAppWebhookRouter] },
];

module.exports = { mounts };
