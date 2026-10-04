/**
 * `/api/datatables` — the HTTP surface for datatables.
 *
 * Mounted at its own path rather than under /api/automation on purpose:
 * routes/automation.routetable.test.js freezes that router's (method, path)
 * table, and a datatable is not an automation.
 *
 * ── TWO SCOPES ──────────────────────────────────────────────────────
 * A table belongs either to an ORGANISATION or to ONE ACCOUNT. The second is
 * not a fallback for a broken state: an account with no organisation is a
 * supported placement (accountProvisioning.consumerPlacement), the built-in
 * `admin` operator is one, and every sibling surface — skills, knowledge bases,
 * App Studio apps, webpages — already lets such an account own things. Only
 * datatables refused, which is BFSF-412.
 *
 * A PERSONAL table is deny-by-default: auth/datatableAccess RULE 0 grades it
 * `owner` for its account and `null` for everyone else, org admins and
 * super-admins included, and the sharing routes below refuse it outright. That
 * is the whole feature — "personal, except an administrator can read it" is not
 * personal.
 *
 * ── NO ROUTE ACCEPTS SQL ────────────────────────────────────────────
 * Every body is a closed descriptor — a table key, a field key from that
 * table's own declared list, an operator from the compiler's FILTER_OPS, and
 * values that are always bound parameters. core/dataEngine/queryCompiler is the
 * only producer of SQL in the system and it refuses to compile without an
 * access filter. A `sql`/`query`/`rawSql`/`rawQuery` key at the TOP of a body
 * is rejected by name (refusals.rejectSqlKeys), so that refusal is explicit
 * rather than incidental. It is not a scan of the whole body, and nothing
 * rests on it being one: no part of a body is ever compiled as SQL, because
 * the compiler takes keys only from the table's declared list and binds every
 * value as a parameter.
 *
 * ── 404 vs 403 ──────────────────────────────────────────────────────
 * Following auth/projectAccess.requireProjectRole: no grade at all → 404, so
 * the existence of a colleague's table is not probeable; a grade that is too
 * low → 403, because at that point the caller already knows it exists.
 *
 * ── THE LICENCE LINE ────────────────────────────────────────────────
 * Creating and using a PERSONAL table rides the Community `automations` key —
 * tiers.js justifies shipping automations to Community on the grounds that they
 * are owner-private and expose no cross-user surface, and a private table
 * preserves that sentence exactly.
 *
 * SHARING is the paid boundary: publishing, granting, or flipping write_mode
 * requires `automation_sharing`, the already-declared Enterprise key whose
 * featureMap entry has read "reserve gate for future org-wide sharing. Not yet
 * mounted." This mounts it.
 *
 * Reads and row writes on a table the caller ALREADY holds a grade on are
 * deliberately ungated — the drain exemption Approvals uses. A licence lapse
 * must never turn a nightly automation into a silent hole in the org's data; what
 * it refuses is NEW sharing.
 *
 * ── AND `manage_datatables` IS AN ORG-SCOPE GATE ────────────────────
 * config/orgRoles.json grants `manage_datatables` under org_admin/agent_admin
 * only, so requiring it for a PERSONAL table would 403 every consumer before
 * the scope was even looked at. It is enforced for org scope and skipped for
 * personal, where the grade resolver has already established that the caller
 * IS the account — see requireManageForOrgScope.
 *
 * ── THIS FOLDER ─────────────────────────────────────────────────────
 * This file is the entry point and nothing more: it makes the router, hangs
 * the router-level chain on it, mounts the three sub-routers, and then lets
 * each resource group register its own routes — IN THE SAME ORDER as when it
 * was all one file. Express matches in registration order, so that order is
 * behaviour, not taste. Sub-routers are deliberately NOT used for the groups:
 * those would add a middleware layer of their own.
 *
 * This file reads nothing from a request itself and so has no schema of its
 * own: each group validates what it reads (schemas.js), and the one route
 * registered here, POST /ai/draft, is validated in routes/datatablesAi.js.
 *
 *   engine.js         Postgres, the scope key, and every cap this surface holds
 *   grade.js          the door: the grade ladder, the org-scope gate, the filter
 *   refusals.js       every way this router says no
 *   schemas.js        the zod vocabulary every request schema below is built from
 *   projection.js     what a client is allowed to see of a table
 *   tables.js         the collection: GET / · POST / · POST /managed
 *   metadata.js       GET /:id · PATCH /:id — label, purpose, retention
 *   schema.js         the column list and its optimistic lock
 *   drift.js          model-versus-Postgres, and the repair button
 *   rowDescriptor.js  the closed `?filters/?sort/?q` descriptor
 *   rows.js           the rows: read, write, import, export, delete
 *   sharing.js        audience, grants, and who else uses this table
 *   source.js         a table that mirrors an external source
 *   answers.js        a form's answers table and its dashboard
 *   deleteTable.js    DELETE /:id
 */

'use strict';

const express = require('express');
const router = express.Router();

const { requireActiveOrgForMutations } = require('../../auth');
const { requireBetaFeature } = require('../../core/entitlements/betaFeatures');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { rejectSqlKeys } = require('./refusals');
const { publicTable } = require('./projection');

// ── Router-level chain (mirrors routes/automation.js:59-71) ─────────────────

// The body limit is 256 kb for every route but the bulk import, which is a
// spreadsheet and a few thousand rows at 256 kb is a few thousand rows short.
// It cannot be a route-local parser: body-parser sets `req._body` once it has
// read the stream, so a second json() further down the stack is a no-op and
// the 256 kb refusal has already happened. One dispatcher, one place to read.
const BULK_PATH_RE = /^\/[^/]+\/rows\/bulk\/?$/;
const jsonStandard = express.json({ limit: '256kb' });
const jsonBulk = express.json({ limit: '2mb' });

router.use(requireBetaFeature('automations'));
router.use(requireActiveOrgForMutations());
router.use((req, res, next) => (
    BULK_PATH_RE.test(req.path) ? jsonBulk(req, res, next) : jsonStandard(req, res, next)
));
router.use(perUserRateLimit({ windowMs: 60_000, max: 120 }));

router.use(rejectSqlKeys);
// The source-mirror collection routes (what can be linked, what a link would
// look like, link) live on their own path segment per kind and are mounted
// BEFORE any `/:id` route below, or "nextcloud" would be read as a table id.
router.use('/nextcloud', require('../datatablesNextcloud')({ publicTable }));
router.use('/spreadsheets', require('../datatablesSpreadsheets')({ publicTable }));
// "Build it with AI": draft or revise a table's columns from a brief. Lazy,
// so the DB-free suites never load the LLM client; literal path, above `/:id`.
const datatablesAi = () => require('../datatablesAi');
router.post('/ai/draft', (req, res, next) => datatablesAi().limiter(req, res, next), (req, res) => datatablesAi().draft(req, res));

// The resource groups, in the order they were registered when this was one
// file. `/:id` is registered before `/:id/schema` and the rest; keep it.
require('./tables').register(router);
require('./metadata').register(router);
require('./schema').register(router);
require('./drift').register(router);
require('./rows').register(router);
require('./sharing').register(router);
require('./source').register(router);
require('./answers').register(router);
require('./deleteTable').register(router);

module.exports = router;
