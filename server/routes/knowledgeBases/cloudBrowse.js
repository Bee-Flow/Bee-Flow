// @typecheck strict
/**
 * Knowledge Bases: the folder picker of a cloud-folder source.
 *
 *   GET /cloud/providers   which storages this account has connected
 *   GET /cloud/browse      one level of one storage: sub-folders and readable documents
 *
 * Mounted BEFORE every `/:id` route (routes/knowledgeBases.js), or "cloud" would
 * be read as a knowledge-base id. Both need `manage_knowledge`: the picker exists
 * to create a source. Browsing runs with the caller's own session, so a person
 * only ever sees what their own account (and, for Nextcloud, their own folder
 * scope) lets them see. Browsing reaches the storage, so it shares the spreadsheet
 * linker's per-user bucket (30 a minute).
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../../auth');
const { validate } = require('../../core/http/validate');
const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');

const PROVIDERS = /** @type {const} */ (['nextcloud_files', 'onedrive', 'google_drive']);
const PROVIDER_TEXT = `provider is one of: ${PROVIDERS.join(', ')}.`;

const BrowseQuery = z.object({
    provider: z.enum(PROVIDERS, { error: () => PROVIDER_TEXT }),
    parentId: worded('parentId must be text.').trim().min(1).max(500).optional(),
    path: worded('path must be text.').trim().min(1).max(2000).optional(),
    driveId: worded('driveId must be text.').trim().min(1).max(500).optional(),
    pageToken: worded('pageToken must be text.').trim().min(1).max(4000).optional(),
    q: worded('q must be text.').trim().max(200).optional(),
}, { error: typeError({ invalid: 'The query is a list of parameters.' }) }).strict();

const access = () => require('./cloudAccess');
/**
 * The spreadsheet linker's per-user bucket, resolved per request so the provider
 * clients load lazily.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const storageLimiter = (req, res, next) => require('../../core/dataEngine/sources/spreadsheetFile/linkRelink').storageLimiter(req, res, next);

router.get('/cloud/providers', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    res.json({ providers: await access().providerStatuses(req) });
});

router.get('/cloud/browse', requireAuth, requirePermission('manage_knowledge'), storageLimiter, validate({ query: BrowseQuery }), async (/** @type {import('express').Request<{}, unknown, unknown, import('zod').infer<typeof BrowseQuery>>} */ req, res) => {
    res.json(await access().browse(req, req.query));
});

module.exports = router;
