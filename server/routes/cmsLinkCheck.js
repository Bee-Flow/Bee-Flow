// @typecheck
/**
 * Link check of a site draft, mounted by routes/cms.js under
 * /sites/:siteId/link-check behind requireAdmin + attachSiteIdFromParam:
 *
 *   POST …/link-check   { external?: boolean } → { problems, summary, internal, external }
 *
 * Internal links are resolved against the site itself (no network). External
 * URLs are requested only with external:true, by an administrator, through the
 * SSRF-guarded probe (core/cms/linkProbe.js), with a tighter rate limit. The
 * answer goes to the caller only; the audit entry carries counts, not URLs.
 */

'use strict';

const express = require('express');
const cmsStore = require('../stores/cmsStore');
const { validate } = require('../core/http/validate');
const { z, bodyOf, typeError } = require('../core/http/schemaParts');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { runLinkCheck } = require('../core/cms/linkReport');
const { takeExternalRun } = require('../core/cms/linkCheckBudget');
const { HttpError } = require('../core/http/errors');

const body = validate({
    body: bodyOf({ external: z.boolean({ error: typeError({ invalid: 'external is true or false.' }) }).optional() }, 'Checking links'),
});
const internalLimiter = perUserRateLimit({ windowMs: 60_000, max: 60 });

function createLinkCheckRouter() {
    const router = express.Router({ mergeParams: true });

    router.post('/', body, internalLimiter, async (req, res) => {
        const external = req.body?.external === true;
        // Shared with the MCP tool: one external budget per user, whichever way it is used.
        if (external && !takeExternalRun(String(req.session?.user?.id))) {
            throw new HttpError(429, 'link_check_limit', 'External link checks are limited to a few per ten minutes. Try again later, or check internal links only.');
        }
        const report = await runLinkCheck(req.siteId, { external }, { cmsStore });
        const user = req.session?.user;
        await require('../stores/userStore').logAccessAudit(
            'cms.links.check', 'cms_site', req.siteId, user?.id || null, null,
            { external, urls: report.external.checked, errors: report.summary.errors, warnings: report.summary.warnings },
            user?.organizationId || null,
        );
        res.json(report);
    });

    return router;
}

module.exports = { createLinkCheckRouter };
