// @typecheck noImplicitAny
/**
 * Redirect manager routes of the CMS, mounted by routes/cms.js under
 * /sites/:siteId/redirects behind requireAdmin + attachSiteIdFromParam:
 *
 *   GET    …/redirects              { redirects, allowedHosts }
 *   POST   …/redirects              { from, to, status?, external? } → the entry
 *   DELETE …/redirects/:id
 *   PUT    …/redirects/hosts        { hosts: [] }  the external-target allow-list
 *
 * Edits land in the draft list; the public site follows them after Publish.
 * The rules (no loops, no chains, no open redirects) are stores/cms/redirectRules.js.
 */

'use strict';

const express = require('express');
const cmsStore = require('../stores/cmsStore');
const { HttpError } = require('../core/http/errors');
const { RedirectError } = require('../stores/cms/redirectRules');
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, typeError } = require('../core/http/schemaParts');
const { perUserRateLimit } = require('../utils/perUserRateLimit');

/**
 * @param {string} field
 * @param {number} max
 */
const text = (field, max) => worded(`${field} is text of at most ${max} characters.`).max(max, `${field} is at most ${max} characters.`);
const setBody = validate({
    body: bodyOf({
        from: text('from', 300),
        to: text('to', 500),
        status: z.union([z.literal(301), z.literal(302)], { error: 'status is 301 or 302.' }).optional(),
        external: z.boolean({ error: typeError({ invalid: 'external is true or false.' }) }).optional(),
    }, 'Saving a redirect'),
});
const hostsBody = validate({
    body: bodyOf({ hosts: z.array(text('A host', 253), { error: 'hosts is a list of host names.' }).max(50, 'At most 50 hosts.') }, 'Saving the allowed hosts'),
});
const writeLimiter = perUserRateLimit({ windowMs: 60_000, max: 120 });

/**
 * The host of an external target, never the whole URL.
 * @param {unknown} to
 */
const hostOf = (to) => { try { return new URL(String(to)).hostname; } catch { return null; } };

/**
 * A refused redirect is the caller's fault: a 400 with its sentence.
 * @param {Error} err
 */
function asHttp(err) {
    if (err instanceof RedirectError) return new HttpError(400, err.code, err.message);
    return err;
}

function createRedirectsRouter() {
    const router = express.Router({ mergeParams: true });

    router.get('/', async (req, res) => {
        res.json(await cmsStore.getRedirects(req.siteId, { fresh: true }));
    });

    /**
     * Who changed what: ids, addresses and hosts, never a full target URL.
     * @param {import('express').Request} req
     * @param {string} action
     * @param {Record<string, unknown> & { id?: string }} details
     */
    const audit = (req, action, details) => require('../stores/userStore').logAccessAudit(
        action, 'cms_redirect', details.id || req.siteId, req.session?.user?.id || null, null, { siteId: req.siteId, ...details }, req.session?.user?.organizationId || null,
    );

    router.post('/', writeLimiter, setBody, async (req, res) => {
        try {
            const { entry, redirects } = await cmsStore.setRedirect(req.siteId, req.body);
            await audit(req, 'cms.redirect.set', { id: entry.id, from: entry.from, external: entry.external, ...(entry.external ? { host: hostOf(entry.to) } : {}) });
            res.json({ success: true, entry, redirects });
        } catch (err) { throw asHttp(err); }
    });

    router.put('/hosts', writeLimiter, hostsBody, async (req, res) => {
        const before = (await cmsStore.getRedirects(req.siteId, { fresh: true })).allowedHosts;
        const doc = await cmsStore.setRedirectHosts(req.siteId, req.body.hosts);
        await audit(req, 'cms.redirect.hosts', { before, after: doc.allowedHosts });
        res.json({ success: true, ...doc });
    });

    router.delete('/:id', writeLimiter, async (req, res) => {
        const id = String(req.params.id || '');
        const removed = await cmsStore.removeRedirect(req.siteId, id);
        if (!removed) throw new HttpError(404, 'redirect_not_found', 'Redirect not found');
        await audit(req, 'cms.redirect.delete', { id });
        res.json({ success: true });
    });

    return router;
}

module.exports = { createRedirectsRouter, asHttp };
