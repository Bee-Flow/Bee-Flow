// @typecheck
/**
 * Studio App Routes — CRUD, publish, versions and runtime-read for App Studio.
 *
 * Apps are structured JSON component trees (never code); the schema is owned
 * by ../appStudio/componentSpecs.js. Every write runs through canonicalize →
 * validate before it reaches the store, and publish additionally re-checks
 * the CURRENT stored draft (including automation ownership) so a broken app can
 * never be frozen into published_definition.
 *
 * Endpoints (mounted at /api/studio-apps behind requireCapability('app_studio')):
 *   GET    /catalog                        — component/theme/action catalog (static)
 *   GET    /templates                      — template gallery (meta only)
 *   GET    /templates/:templateId          — one template incl. definition
 *   GET    /templates/:templateId/export   — one template as a portable file
 *   POST   /templates/import               — a template file → this org's gallery
 *   GET    /                               — apps visible to the caller (meta only)
 *   GET    /mine                           — apps the caller owns (meta only)
 *   POST   /                               — create app (blank or from template)
 *   GET    /:id                            — owner: full row; reader: meta + published_definition
 *   PUT    /:id                            — owner-only metadata update
 *   PUT    /:id/definition                 — owner-only CAS save (canonicalize + validate)
 *   PATCH  /:id/publish                    — owner-only publish/unpublish (freezes the draft)
 *   POST   /:id/template-upgrade           — owner-only upgrade of a PRISTINE app to the
 *                                            registry template's newer version (409 otherwise)
 *   PATCH  /:id/nextcloud-menu             — owner-only Nextcloud app-menu toggle
 *   DELETE /:id                            — owner-only delete
 *   GET    /:id/versions                   — owner-only publish-snapshot history
 *   POST   /:id/versions/:versionId/restore — owner-only restore snapshot → working draft
 *   GET    /:id/runtime                    — run-view payload (draft for owner, else published)
 *                                            + viewer { id, name, email, isOwner, roleKey }
 *
 * Visibility follows the webpages convention: anything the caller may not see
 * is a 404 (never leak existence); owner-only mutations on a *readable* app
 * are a 403.
 */

// The handlers live in routes/studioApps/ per resource group; this file is the
// router that mounts them. THE MOUNTING ORDER BELOW IS THE MATCHING ORDER:
// the static paths (/catalog, /templates/*) first, then the CRUD part, whose
// literal paths (/mine, /usage) sit before its GET /:id, then the
// /:id/* parts. studioApps.routes.test.js pins the route table and that order.
// Shared pieces: ./schemas (what the routes accept), ./access (the manage_apps
// gate, audience, read refusal) and ./appHelpers.

const express = require('express');
const router = express.Router();

// GET /catalog, the template gallery and its export/import — before any /:id.
router.use('/', require('./studioApps/templates'));
// GET /, /mine, /usage; POST /; GET|PUT /:id, /:id/ref, /:id/definition; DELETE /:id.
router.use('/', require('./studioApps/crud'));
// POST /import — an app archive (no POST /:id exists for it to collide with).
router.use('/', require('./studioApps/appImport'));
// PATCH /:id/publish, /:id/nextcloud-menu; GET /:id/versions, POST …/restore.
router.use('/', require('./studioApps/publish'));
// GET|POST /:id/public-pages, DELETE /:id/public-pages/:token.
router.use('/', require('./studioApps/publicPages'));
// POST /:id/check, /:id/template-upgrade; GET /:id/runtime.
router.use('/', require('./studioApps/runtime'));

module.exports = router;
