// @typecheck strict
/**
 * A form's TEST LINK, from Studio → Forms → Share (D3): a separate address
 * (its own page row, stores/automationStore/formTestPageStore.mts) that serves
 * the WORKING copy to its own audience while the automation is a draft, off,
 * or live with unpublished changes. Every submission through it is a test run
 * started by the submitter: real effects, approvals to the tester, no answers
 * row, no submission counted (automation/formSubmission.mts).
 *
 *   GET    /forms/:automationId/test-link            { testLink | null }
 *   POST   /forms/:automationId/test-link            a fresh link (the old one stops working) → 201 { testLink }
 *   DELETE /forms/:automationId/test-link            stop it now → { revoked }
 *   PUT    /forms/:automationId/test-link/audience   who may open it (same body as /audience) → { testLink }
 *
 * All four need `edit` on the automation, checked BEFORE the body is read, and
 * answer 404 for an automation whose working copy has no form trigger. The link
 * expires after AUTOMATION_FORM_TEST_LINK_DAYS (default 14, 0 = never); the
 * reaper removes expired rows. Registered by forms.js's registerFormRoutes,
 * before `/:id`.
 */

'use strict';

const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { sessionUser } = require('../../core/http/sessionUser');
const { publicAudience } = require('../../automation/formAudience');
const { AudienceBody, readAudienceBody: readAudience } = require('./formAudienceBody');

/** @typedef {NonNullable<Awaited<ReturnType<typeof import('../../stores/automationStore').getAutomation>>>} StoredAutomation */
/**
 * What the routes read and who they ask; a test hands in its own.
 * @typedef {{
 *   store?: typeof import('../../stores/automationStore'),
 *   access?: { guard: (req: import('express').Request, res: import('express').Response, a: StoredAutomation, need: string) => Promise<unknown> },
 *   orgOf?: (req: import('express').Request) => Promise<string | null>,
 *   readAudienceBody?: typeof readAudience,
 * }} TestLinkDeps
 */
/** @param {TestLinkDeps} [deps] */
function depsOf(deps = {}) {
    const ctx = () => require('./crudContext');
    return {
        store: deps.store || require('../../stores/automationStore'),
        access: deps.access || ctx().automationAccess,
        orgOf: deps.orgOf || ((/** @type {import('express').Request} */ req) => ctx().orgOf(req)),
        readAudienceBody: deps.readAudienceBody || readAudience,
    };
}

/**
 * What an editor sees of a test link: an allow-list, never the row.
 * @param {NonNullable<Awaited<ReturnType<typeof import('../../stores/automationStore').getTestFormPage>>>} page
 */
function describeTestLink(page) {
    return {
        token: page.id,
        url: `/f/${page.id}`,
        createdAt: page.createdAt ?? null,
        expiresAt: page.expiresAt ?? null,
        issuedByUserId: page.issuedByUserId ?? null,
        audience: publicAudience(page, { owner: true }),
    };
}

/**
 * The Form page's editor-only facts (studio F11): unpublished changes, the
 * live version (and the working one, for Publish's version check), and the
 * test link.
 * @param {string} automationId
 * @param {TestLinkDeps} [deps]
 */
async function editorFormFacts(automationId, deps = {}) {
    const store = deps.store || require('../../stores/automationStore');
    const a = await store.getAutomation(automationId);
    const page = await store.getTestFormPage(automationId, null);
    return {
        pendingChanges: Number(a?.pendingChanges) || 0,
        liveVersion: a?.liveVersion ?? null,
        version: a?.version ?? null,
        testLink: page ? describeTestLink(page) : null,
    };
}

/**
 * @param {import('express').Router} router
 * @param {TestLinkDeps} [deps]
 */
function registerFormTestLinkRoutes(router, deps = {}) {
    const { store: automationStore, access, orgOf, readAudienceBody } = depsOf(deps);

    /**
     * The automation of `:automationId`, once the caller may edit it and its
     * working copy has a form trigger; answers otherwise. Before the body is read.
     * @type {import('express').RequestHandler<{ automationId: string }>}
     */
    async function editGate(req, res, next) {
        const a = await automationStore.getAutomation(req.params.automationId);
        if (!a) throw new HttpError(404, 'automation_not_found', 'Not found');
        if (!await access.guard(req, res, a, 'edit')) return;
        if (a.definition?.trigger?.kind !== 'form') throw new HttpError(404, 'form_not_found', 'Not found');
        res.locals.automation = a;
        next();
    }

    router.get('/forms/:automationId/test-link', editGate, async (_req, res) => {
        const page = await automationStore.getTestFormPage(res.locals.automation.id, null);
        res.json({ testLink: page ? describeTestLink(page) : null });
    });

    router.post('/forms/:automationId/test-link', editGate, async (req, res) => {
        const { testLinkExpiresAt } = require('../../stores/automationStore/formTestPageStore.mts');
        const issuer = sessionUser(req).id;
        const page = await automationStore.createTestFormPage(res.locals.automation.id, {
            issuedByUserId: issuer, triggerStepId: null, expiresAt: testLinkExpiresAt(),
            audience: 'restricted', sharedGroups: [], sharedUserIds: [issuer],
        });
        if (!page) throw new HttpError(500, 'test_link_failed', 'Could not make the test link.');
        res.status(201).json({ testLink: describeTestLink(page) });
    });

    router.delete('/forms/:automationId/test-link', editGate, async (_req, res) => {
        const n = await automationStore.revokeTestFormPages(res.locals.automation.id, null);
        res.json({ revoked: n > 0 });
    });

    router.put('/forms/:automationId/test-link/audience', editGate, validate({ body: AudienceBody }), async (req, res) => {
        const a = res.locals.automation;
        const page = await automationStore.getTestFormPage(a.id, null);
        if (!page) throw new HttpError(404, 'test_link_not_found', 'This form has no working test link. Create one first.');
        let wanted;
        try {
            wanted = await readAudienceBody(req.body, a.organizationId || (await orgOf(req)));
        } catch (err) {
            const e = /** @type {Error & { status?: number, code?: string }} */ (err);
            throw new HttpError(e.status || 400, e.code || 'audience_invalid', e.message);
        }
        const updated = await automationStore.setFormPageAudience(page.id, a.id, wanted);
        if (!updated) throw new HttpError(404, 'test_link_not_found', 'Not found');
        res.json({ testLink: describeTestLink(updated) });
    });
}

module.exports = { registerFormTestLinkRoutes, editorFormFacts, describeTestLink };
