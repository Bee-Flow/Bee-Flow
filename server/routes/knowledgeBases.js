/**
 * Knowledge Bases API Routes
 *
 * KB CRUD, document management, ingestion via search-service, and search.
 */

const express = require('express');
const router = express.Router();
const { requireActiveOrgForMutations } = require('../auth');

// Block mutations when the caller's org is suspended/archived. Reads pass through.
router.use(requireActiveOrgForMutations());

// Route logic lives in focused sub-modules under routes/knowledgeBases/,
// mounted here in the exact order the routes were registered before the split.
// Order is semantics: the literal paths (/categories, /system, /favorites) are
// registered ahead of GET /:id, and DELETE /categories/:id ahead of
// DELETE /:id/favorite.
router.use('/', require('./knowledgeBases/list'));
router.use('/', require('./knowledgeBases/categories'));
router.use('/', require('./knowledgeBases/create'));
router.use('/', require('./knowledgeBases/system'));
router.use('/', require('./knowledgeBases/favorites'));
// Sources before detail: /:id/sources/... must never be reached through the
// single-KB handlers, and DELETE /:id/sources/:sid is registered ahead of
// DELETE /:id/documents/:docId for the same reason the literals above are.
router.use('/', require('./knowledgeBases/sources'));
// Usage before detail, same rule as the literals above: /usage-summary and
// /suggestions would otherwise be swallowed by GET /:id.
router.use('/', require('./knowledgeBases/usage'));
// Before `detail`, like the rest: `/:id/ask` is safe either way, but the
// mount order in this file is the one thing keeping literal paths reachable
// and it reads better unbroken.
router.use('/', require('./knowledgeBases/ask'));
router.use('/', require('./knowledgeBases/detail'));
router.use('/', require('./knowledgeBases/documents'));
router.use('/', require('./knowledgeBases/ingest'));
router.use('/', require('./knowledgeBases/sitemapIngest'));
router.use('/', require('./knowledgeBases/n8n'));
router.use('/', require('./knowledgeBases/search'));
router.use('/', require('./knowledgeBases/reindex'));

module.exports = router;
