/**
 * Webpage Routes — CRUD for webpages + source management + versions.
 *
 * Endpoints:
 *   POST   /                    — create webpage ({ name?, prompt?, sources? })
 *   GET    /                    — list user's webpages
 *   GET    /:id                 — get webpage detail (metadata + html/css/js bytes)
 *   PUT    /:id                 — update webpage (metadata and/or file slots)
 *   POST   /:id/clone           — duplicate webpage (skips publishing scope + external shares)
 *   DELETE /:id                 — delete webpage (purges DB rows + RustFS objects);
 *                                 409 `in_use` unless `?confirm=1` — see the
 *                                 guard above the handler
 *   POST   /:id/sources/file    — upload file source (pdf, docx, xlsx, txt, …)
 *   POST   /:id/sources/url     — add URL source
 *   POST   /:id/sources/text    — paste text source
 *   POST   /:id/sources/drive   — import from Google Drive / OneDrive
 *   GET    /:id/sources         — list sources
 *   POST   /:id/sources/:sid/retry  — retry a failed/cancelled source
 *   POST   /:id/sources/:sid/cancel — cancel a stuck source
 *   DELETE /:id/sources/:sid    — remove source
 *   GET    /:id/versions        — list version snapshots (metadata only)
 *   GET    /:id/versions/:vid   — get a single version (full file trio)
 *   POST   /:id/versions        — create a manual snapshot
 *   POST   /:id/versions/:vid/restore — restore a previous snapshot
 *   DELETE /:id/versions/:vid   — delete a version
 *   GET    /:id/draft-document     — the draft as one HTML document, bridges baked in
 *
 * ── This folder ─────────────────────────────────────────────────────
 *
 * This file is the hub and nothing more: it creates the router, hangs the middleware and
 * the three own sub-routers on it, and then lets each source group register its own
 * routes. IN THE SAME ORDER as when everything stood in one file — Express matches in
 * order of registration, so that order is behaviour, not taste. Sub-routers are
 * deliberately NOT used for that: they would add their own middleware layer.
 *
 *   schemas.js           the zod vocabulary from which every request schema is built
 *   crud.js              the page itself: POST / · GET / · GET /:id · PUT /:id
 *   createBrief.js       what the build bar sends, weighed and turned into a brief
 *   publishing.js        thumbnail + org/group publication
 *   publishedSnapshot.js which bytes a non-owner reads, and how they are pinned
 *   publicShares.js      external share links + the refreshing of their snapshots
 *   files.js             extra files and binary assets
 *   previewToken.js      the token for the sandboxed preview iframe
 *   draftDocument.js     the draft as one ready-to-run document (the phone's preview)
 *   pageDatabase.js      the page database behind the session
 *   chat.js              the chat history of the build AI
 *   lifecycle.js         cloning and deleting
 *   deleteGuard.js       the 409 gate that DELETE /:id sets first
 *   sources.js           file/URL/text/Drive + retry, cancel, delete
 *   versions.js          the version history
 *   versionListing.js    how a version listing should be read
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');

const { requireActiveOrgForMutations } = require('../../auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// What the source groups of this hub receive. The multipart gate is the
// only shared one: two groups (assets, source files) upload, and that has to be
// the same instance with the same limit.
const deps = { upload };

// Access control: the beta-feature gate at server/index.js (`requireBetaFeature('webpages')`)
// is the single source of truth. The previous `requirePermission('use_webpages')` here was
// redundant and blocked org members who had the beta enabled but not the legacy permission.

// Block writes when the caller's org is suspended/archived.
router.use(requireActiveOrgForMutations());

// Bridge-grant management for the IDE "Apps & data" panel — owner-only REST
// surface over the same integrations/webpageGrants module the studio AI uses.
router.use(require('../webpagesGrants'));
// "Wie ziet de pagina, en het adres" (W3 step 4) — the fourth row (Openbaar) and the
// Adres-kaart. Owner-only, and deliberately its own file: this is the only place
// that the column gate `publicColumns` writes.
router.use(require('../webpagesAudience'));
// "Wie gebruikt deze pagina" (W5 part B) — the Gebruikt-door tab and the delete
// confirmation. Its own file for the same reason as the two above: this is the only
// place that may say, per sub-question, that it is NOT checked, and that distinction
// survives no place between the CRUD routes.
router.use(require('../webpagesUsage'));

require('./crud').register(router, deps);
require('./publishing').register(router, deps);
require('./publicShares').register(router, deps);
require('./files').register(router, deps);
require('./previewToken').register(router, deps);
require('./draftDocument').register(router, deps);
require('./pageDatabase').register(router, deps);
require('./chat').register(router, deps);
require('./lifecycle').register(router, deps);
require('./sources').register(router, deps);
require('./versions').register(router, deps);

module.exports = router;

/** @typedef {{ upload: { single(field: string): import('express').RequestHandler } }} WebpageRouteDeps */
