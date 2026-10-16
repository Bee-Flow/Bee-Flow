/**
 * App Studio v2 — DATA API (record CRUD + aggregation query).
 *
 * This is the sole, unbypassable path that turns a client request into SQL
 * against a per-app SQLite database. It is session-authenticated (App Studio
 * runs inside the SPA — there is NO preview token here), rate-limited per
 * viewer, and RLS-scoped: every read/write is compiled by ../appStudio/
 * queryCompiler.js with an access filter from ../appStudio/rlsGateway.js. A
 * client never sends SQL.
 *
 * Mounted at /api/studio-apps ALONGSIDE studioApps.js + studioAppsRun.js behind
 * requireCapability('app_studio').
 *
 * Endpoints:
 *   GET    /:id/data/tables                           — tables the viewer may READ (fields only)
 *   GET    /:id/data/tables/:tableId/records          — list (filter/sort/keyset), access-filtered
 *   POST   /:id/data/tables/:tableId/records          — create (create-gated; created_by = session)
 *   GET    /:id/data/tables/:tableId/records/:recordId — read one (hidden → 404)
 *   PATCH  /:id/data/tables/:tableId/records/:recordId — update (0 rows = 404)
 *   DELETE /:id/data/tables/:tableId/records/:recordId — delete (0 rows = 404)
 *   POST   /:id/data/query                            — saved dataset OR inline aggregate descriptor
 *   POST   /:id/data/batch                            — many reads, one request (per-read statuses)
 *   GET/PUT /:id/schema                               — owner-only data model (with rowFilter validation)
 *   GET/POST/DELETE /:id/members                      — owner-only role assignment
 *
 * ── SECURITY MODEL (mirrors studioAppsRun.js) ───────────────────────
 *   • App visibility: owner always; else is_published + canReadStudioApp.
 *     Every not-visible answer is a uniform 404 — existence never leaks.
 *   • The per-app SQLite DB is owned by the app OWNER; data access runs
 *     acts-as-owner for the DB HANDLE (studioAppDbStore is keyed by ownerId =
 *     app.userId) while the RLS access filter scopes ROWS to the VIEWER.
 *   • Schema + membership are owner-only (canWriteStudioApp); a readable
 *     non-owner gets 403, an invisible one 404.
 *   • Generic 500s only — err.message never leaves the process except for the
 *     safe validation messages carried by Compile/AccessError (status 422/403/400)
 *     and quota errors (status 409, { error, code:'quota_exceeded', limit, used }).
 *   • Record writes funnel through actionExecutor.writeRecord — the single
 *     choke point that asserts storage quotas (create: row + byte caps;
 *     update: byte cap only; deletes stay quota-free so a full app can shrink).
 */

const express = require('express');
const router = express.Router();
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, queryOf, choice, wholeNumber, typeError } = require('../core/http/schemaParts');
// The runtime's own request shapes, shared with the public app routes.
const R = require('./studio/appRuntimeSchemas');

// ── What the data routes accept ──────────────────────────────────────
// Closed, except two bodies whose keys are the app's own: a record write
// (its keys are the table's columns; the insert/update compiler refuses a
// column the table does not have, by name) and POST /data/query (the body is
// a read descriptor, checked field by field by the query compiler). What is
// closed here: `?refresh=yes` served the cache; a misspelled batch key, a
// dataset with `cacheTtlSeconds: "60"` (kept the default), a member with a
// misspelled `role` (became `member`) — all answered 200.
const idText = (name) => worded(`${name} is an id.`).max(200, `${name} is an id.`);
const RefreshQuery = queryOf({ refresh: choice(['0', '1', 'true', 'false'], 'refresh is 1 to bypass the cache.').optional() }, 'A data query');
const BatchBody = bodyOf({
    // The handler answers a missing or non-list `reads` itself, with its cap.
    reads: z.unknown().optional(),
}, 'A batch of reads');
const datasetShape = {
    name: worded('name is text.').max(200, 'name is at most 200 characters.').optional(),
    tableId: idText('tableId').nullish(),
    source: z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'source is an object.' }) }).optional(),
    descriptor: z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'descriptor is an object.' }) }).optional(),
    cacheTtlSeconds: wholeNumber('cacheTtlSeconds is a whole number of seconds.').optional(),
};
const DatasetBody = bodyOf(datasetShape, 'A dataset');
const SchemaBody = bodyOf({
    model: z.record(z.string(), z.unknown(), { error: typeError({ required: 'model (object) is required', invalid: 'model (object) is required' }) }),
    expectedVersion: wholeNumber('expectedVersion is the version you loaded.').nullish(),
}, 'A data model');
const MemberBody = bodyOf({
    userId: worded('userId is required').max(200, 'userId is an id.'),
    roleKey: worded('roleKey is the key of a role.').max(100, 'roleKey is the key of a role.').optional(),
}, 'Adding a member');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');
// What every handler shares (limits, budgets, gates, the data context), then
// the handler bodies. This file keeps the request schemas and the route table.
const {
    readLimiter, writeLimiter, readDescriptorLimiter, jsonBody, requireJson, bodySizeGuard,
} = require('./studio/appDataContext');
const Records = require('./studio/appDataRecords');
const Query = require('./studio/appDataQuery');
const Admin = require('./studio/appDataAdmin');

// ── Tables and records ──────────────────────────────────────────────

router.get('/:id/data/tables', requireAuth, readLimiter, Records.listTables);
router.get('/:id/data/tables/:tableId/records', requireAuth, readLimiter, validate({ query: R.RecordsQuery }), Records.listRecords);
router.post('/:id/data/tables/:tableId/records', requireAuth, writeLimiter, requireJson, jsonBody, bodySizeGuard, Records.createRecord);
router.get('/:id/data/tables/:tableId/records/:recordId', requireAuth, readLimiter, Records.getRecord);
router.patch('/:id/data/tables/:tableId/records/:recordId', requireAuth, writeLimiter, requireJson, jsonBody, bodySizeGuard, Records.updateRecord);
router.delete('/:id/data/tables/:tableId/records/:recordId', requireAuth, writeLimiter, Records.deleteRecord);

// ── Export, query and batch ─────────────────────────────────────────

router.get('/:id/data/export', requireAuth, readLimiter, Query.exportData);
router.post('/:id/data/query', requireAuth, readLimiter, requireJson, jsonBody, bodySizeGuard, validate({ query: RefreshQuery }), Query.queryData);
router.post('/:id/data/batch', requireAuth, readLimiter, requireJson, jsonBody, bodySizeGuard, validate({ body: BatchBody }), readDescriptorLimiter, Query.batchRead);

// ── Datasets, schema and members ────────────────────────────────────

router.get('/:id/datasets', requireAuth, readLimiter, Admin.listDatasets);
router.post('/:id/datasets', requireAuth, writeLimiter, requireJson, jsonBody, bodySizeGuard, validate({ body: DatasetBody }), Admin.createDataset);
router.put('/:id/datasets/:datasetId', requireAuth, writeLimiter, requireJson, jsonBody, bodySizeGuard, validate({ body: DatasetBody }), Admin.updateDataset);
router.delete('/:id/datasets/:datasetId', requireAuth, writeLimiter, Admin.deleteDataset);
router.get('/:id/schema', requireAuth, Admin.getSchema);
router.put('/:id/schema', requireAuth, jsonBody, bodySizeGuard, validate({ body: SchemaBody }), Admin.putSchema);
router.get('/:id/members', requireAuth, Admin.listMembers);
router.post('/:id/members', requireAuth, jsonBody, bodySizeGuard, validate({ body: MemberBody }), Admin.addMember);
router.delete('/:id/members/:userId', requireAuth, Admin.removeMember);

// Map body-parser failures to JSON (default handler answers HTML).
router.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413) {
        return res.status(413).json({ error: 'Request body too large (max 64KB)' });
    }
    if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON body' });
    }
    if (err?.type === 'charset.unsupported' || err?.type === 'encoding.unsupported') {
        return res.status(415).json({ error: 'Unsupported content encoding' });
    }
    next(err);
});

module.exports = router;
