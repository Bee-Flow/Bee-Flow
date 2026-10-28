// @typecheck strict
/**
 * Website forms: the public endpoint behind the CMS `form` block. The
 * admin side that decides which automations it may start is cmsFormsAdmin.js.
 *
 *   PUBLIC   GET  /api/cms/forms/:blockId   → { token, issuedAt, serverNow } for that form
 *            POST /api/cms/forms/:blockId   → 202, the answers start an automation
 *   ADMIN    see routes/cmsFormsAdmin.js
 *
 * ── Why this is safe to leave open ───────────────────────────────────────
 * It is an anonymous write, so the visitor is trusted with nothing but the
 * answers:
 *   - SCOPE. The block id selects a form block of the LIVE site's PUBLISHED
 *     snapshot; that block names the automation. The automation must also be
 *     on the allow-list an admin keeps (stores/cms/formAutomations.js, not
 *     editable through the block tools) AND that admin must have approved this
 *     block id for it; it must belong to the organisation it was enabled for,
 *     be active and published, and declare a webhook trigger. Re-checked on
 *     every request. Anything short of that is one generic 404.
 *   - SHAPE. Only the fields the block declares are read; every value is
 *     coerced and bounded (automation/formTriggerContract). Unknown keys of
 *     the envelope are refused; the PARSED body is capped at 32 KB.
 *   - ABUSE. Separate rate limits for the token fetch and for the submit
 *     (per IP, and per form on the submit), a honeypot, a minimum form age,
 *     a double-submit nonce and a cap on submissions in flight. The two bot
 *     signals answer a silent 200 so a probe learns nothing; each such drop is
 *     COUNTED per form (no personal data) and the admin sees the count, so
 *     leads going missing do not stay invisible.
 *   - CSRF. JSON only (a cross-site <form> cannot send it), the Origin must be
 *     one of CORS_ORIGIN (the same test as the global CORS gate), and an HMAC
 *     token of its own purpose (`cmsform`) bound to the form, the site and the
 *     issue time. There are no cookies, so this is defence in depth.
 *   - NONCE. The visitor-chosen nonce is DOUBLE-SUBMIT protection (a double
 *     click, a refresh), not replay protection: one token may be used again
 *     within its 30 minutes, held by the rate limits. It is stored only once
 *     a submission is valid and about to run, so a corrected resend after a
 *     400 or a 429 is never taken for a duplicate.
 *   - PRIVACY. Nothing leaves the install: the answers are the automation's
 *     trigger payload and nothing else is added: no IP, no user agent. When
 *     the block asks for consent, the wording the visitor saw (in their
 *     locale) rides along as the audit trail. A failed run logs the
 *     automation id only, never an error text that could repeat what the
 *     visitor typed.
 *
 * The per-IP limits count `req.ip`, which behind a proxy is the client address
 * only when TRUST_PROXY_HOPS matches the number of proxies in front: with none
 * a client can pick its own, with two every visitor shares one bucket.
 * MAX_PENDING_PER_AUTOMATION counts per replica and only while
 * executeAutomation keeps its promise open.
 *
 * A form run enters through the automation's webhook trigger with
 * `trigger.headers.source = 'cms_form'`. Its payload is UNTRUSTED visitor
 * input, unlike an HMAC-signed webhook call: the author of the site block
 * chooses the field names that reach the automation.
 */

'use strict';

const express = require('express');
const log = require('../telemetry/log');
const { HttpError, notFound } = require('../core/http/errors');
const { validate } = require('../core/http/validate');
const { z, bodyOf, worded } = require('../core/http/schemaParts');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { parseAllowedOrigins, isAllowedOrigin } = require('../utils/allowedOrigins');
const { issueCmsFormToken, verifyCmsFormToken } = require('../auth/publicShareToken');
const websiteForms = require('../core/cms/websiteForms');

const MAX_BODY_BYTES = 32 * 1024;
const MIN_FORM_AGE_MS = 2000;
/** Neutral on purpose: a name like "website" is what autofill and form-fillers fill. */
const HONEYPOT_FIELD = 'ref_code_2';
/** Submissions accepted but not yet finished, per automation. */
const MAX_PENDING_PER_AUTOMATION = 50;

const UNAVAILABLE = () => notFound('form_unavailable', 'This form is not available.');

/**
 * What a visitor's POST may carry. The answers sit under `answers` so a field
 * called `token` or `nonce` cannot collide with the envelope.
 */
const SubmitBody = bodyOf({
    token: worded('The form expired. Reload the page and try again.').max(400),
    issuedAt: z.number({ error: 'The form expired. Reload the page and try again.' }).int(),
    nonce: worded('nonce is text.').max(80).optional(),
    locale: worded('locale is text.').max(10).optional(),
    [HONEYPOT_FIELD]: worded('This field is text.').max(500).optional(),
    consent: z.boolean({ error: 'consent is yes or no.' }).optional(),
    answers: z.record(z.string(), z.unknown(), { error: 'answers is an object.' }),
}, 'A form submission');


/** Scope the HMAC token binds: this form, on this site, issued at this time. */
const tokenScope = (/** @type {string} */ siteId, /** @type {string} */ blockId, /** @type {number} */ issuedAt) => `cmsform:${siteId}:${blockId}:${issuedAt}`;

/**
 * Origin check for the browser case: an Origin header must be one of
 * CORS_ORIGIN (what the global gate in boot/httpMiddleware.js already
 * enforces, so a split-origin setup keeps working); one without (curl,
 * server-side callers) has no browser to be tricked and is held by the token
 * and the limits.
 * @param {import('express').Request} req
 */
function originAllowed(req) {
    const origin = req.get('origin');
    if (!origin) return req.get('sec-fetch-site') !== 'cross-site';
    return isAllowedOrigin(origin, parseAllowedOrigins(process.env.CORS_ORIGIN));
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
function jsonOnly(req, _res, next) {
    // A cross-site <form> cannot send application/json without a CORS preflight.
    return req.is('application/json') ? next() : next(new HttpError(415, 'unsupported_media_type', 'Send the form as JSON.'));
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
function browserOrigin(req, _res, next) {
    return originAllowed(req) ? next() : next(new HttpError(403, 'cross_origin', 'This form can only be sent from the site that shows it.'));
}

/**
 * The size of the body AS PARSED. The global parser reads up to 20 MB before
 * any route runs, and a chunked request has no Content-Length, so the header
 * alone proves nothing.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function sizeGuard(req, res, next) {
    const raw = /** @type {{ rawBody?: unknown }} */ (req).rawBody;
    const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : Buffer.byteLength(JSON.stringify(req.body ?? {}));
    const declared = Number(req.get('content-length') || 0);
    if (bytes > MAX_BODY_BYTES || (Number.isFinite(declared) && declared > MAX_BODY_BYTES)) {
        return res.status(413).json({ error: 'That submission is too large.' });
    }
    return next();
}

/**
 * @typedef {object} FormDeps
 * @property {() => Promise<string | null>} getLiveSiteId
 * @property {(siteId: string) => Promise<Record<string, any> | null>} getPublishedSnapshot
 * @property {(id: string) => Promise<Record<string, any> | null>} getAutomation
 * @property {(automation: Record<string, any>) => Promise<string | null>} organisationOf the automation's own organisation, else its owner's
 * @property {(id: string) => Promise<{ organizationId: string | null, blockIds: string[] } | null>} getFormAutomation
 * @property {(nonce: string) => Promise<boolean>} checkAndStoreNonce true when the nonce is new
 * @property {(blockId: string, kind: 'honeypot' | 'tooFast') => Promise<void>} countDrop
 * @property {(automation: Record<string, any>, opts: Record<string, any>) => Promise<unknown>} runAutomation
 * @property {() => number} [now]
 * @property {number} [rpmTokenPerIp]
 * @property {number} [rpmPerIp]
 * @property {number} [rpmPerForm]
 */

/**
 * The public router. Takes its collaborators, so it is tested without mocking modules.
 * @param {FormDeps} deps
 */
function createPublicRouter(deps) {
    const now = deps.now || Date.now;
    const router = express.Router();
    const pending = new Map(); // automationId → submissions in flight

    // Named, so that with Redis configured the limits hold across replicas.
    // The token fetch (every page view) and the submit have budgets of their
    // own: page views must never use up what a real submission needs.
    const tokenIpLimiter = perUserRateLimit({
        windowMs: 60_000, name: 'cms-form-token',
        max: deps.rpmTokenPerIp || parseInt(process.env.CMS_FORM_TOKEN_RPM_PER_IP || '', 10) || 120,
        keyFn: (req) => `ip:${req.ip || 'unknown'}`,
    });
    const submitIpLimiter = perUserRateLimit({
        windowMs: 60_000, name: 'cms-form-submit-ip',
        max: deps.rpmPerIp || parseInt(process.env.CMS_FORM_RPM_PER_IP || '', 10) || 10,
        keyFn: (req) => `ip:${req.ip || 'unknown'}`,
    });
    const submitFormLimiter = perUserRateLimit({
        windowMs: 60_000, name: 'cms-form-submit-form',
        max: deps.rpmPerForm || parseInt(process.env.CMS_FORM_RPM_PER_FORM || '', 10) || 60,
        keyFn: (/** @type {import('express').Request} */ req) => `blk:${req.params.blockId}`,
    });

    /**
     * Everything the request is allowed to touch, resolved from the published
     * block outward. Null (→ 404) the moment any link of the chain is missing.
     * @param {string} blockId
     */
    async function resolveTarget(blockId) {
        const siteId = await deps.getLiveSiteId();
        if (!siteId) return null;
        const snapshot = await deps.getPublishedSnapshot(siteId);
        const found = websiteForms.findFormBlock(snapshot, blockId);
        if (!found) return null;
        const automationId = typeof found.block.content?.automationId === 'string' ? found.block.content.automationId.trim() : '';
        if (!automationId) return null;
        const entry = await deps.getFormAutomation(automationId);
        // Enabled for website forms AND this block approved for it.
        if (!entry || !entry.blockIds.includes(found.block.id)) return null;
        const automation = await deps.getAutomation(automationId);
        if (!automation || !automation.isActive || automation.isDraft) return null;
        if ((await deps.organisationOf(automation)) !== (entry.organizationId || null)) return null;
        const triggerStepId = websiteForms.webhookTriggerId(automation);
        if (!triggerStepId) return null;
        return { siteId, snapshot, found, automation, triggerStepId };
    }

    router.get('/:blockId', tokenIpLimiter, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const target = await resolveTarget(req.params.blockId);
        if (!target) throw UNAVAILABLE();
        const issuedAt = now();
        // `serverNow` lets the page wait out the minimum form age on the
        // server's clock, not its own.
        res.json({ token: issueCmsFormToken(tokenScope(target.siteId, target.found.block.id, issuedAt)), issuedAt, serverNow: issuedAt });
    });

    router.post('/:blockId', submitIpLimiter, submitFormLimiter, jsonOnly, browserOrigin, sizeGuard, validate({ body: SubmitBody }), async (/** @type {import('express').Request<{ blockId: string }, any, import('zod').infer<typeof SubmitBody>, import('qs').ParsedQs>} */ req, res) => {
        res.set('Cache-Control', 'no-store');
        const target = await resolveTarget(/** @type {string} */ (req.params.blockId));
        if (!target) throw UNAVAILABLE();
        const { siteId, snapshot, found, automation, triggerStepId } = target;
        const body = req.body;

        if (!verifyCmsFormToken(body.token, tokenScope(siteId, found.block.id, body.issuedAt))) {
            throw new HttpError(403, 'form_expired', 'This form expired. Reload the page and try again.');
        }

        // The two bot signals answer 200 and run nothing, so a probe cannot
        // tell a rejected submission from an accepted one. They are counted.
        const honeypotFilled = typeof body[HONEYPOT_FIELD] === 'string' && body[HONEYPOT_FIELD].trim() !== '';
        const tooFast = now() - body.issuedAt < MIN_FORM_AGE_MS;
        if (honeypotFilled || tooFast) {
            await deps.countDrop(found.block.id, honeypotFilled ? 'honeypot' : 'tooFast');
            return res.status(200).json({ accepted: true });
        }

        if (body.nonce && !/^[A-Za-z0-9_-]{8,80}$/.test(body.nonce)) throw new HttpError(400, 'invalid_request', 'nonce is not valid.');

        const { values, errors } = websiteForms.validateSubmission(found.block.content, { ...body.answers, consent: body.consent });
        if (errors.length) throw new HttpError(400, 'invalid_submission', 'Some answers need attention.', { fields: errors });

        if ((pending.get(automation.id) || 0) >= MAX_PENDING_PER_AUTOMATION) {
            res.set('Retry-After', '60');
            throw new HttpError(429, 'form_busy', 'Too many submissions are waiting. Try again in a minute.');
        }

        // Last, just before the run is scheduled: only a valid submission that
        // will run uses its nonce up.
        if (body.nonce && !(await deps.checkAndStoreNonce(`cmsform:${found.block.id}:${body.nonce}`))) {
            return res.status(200).json({ accepted: true, duplicate: true });
        }

        const consent = websiteForms.consentFor(snapshot, found, body.locale);
        const triggerHeaders = {
            source: 'cms_form',
            form_block_id: found.block.id,
            page_id: found.pageId,
            submitted_at: new Date(now()).toISOString(),
            consent_given: consent.required ? 'true' : 'not_requested',
            ...(consent.required ? { consent_text: consent.text, consent_locale: consent.locale } : {}),
        };
        pending.set(automation.id, (pending.get(automation.id) || 0) + 1);
        // Behind the ack, like the webhook trigger: the visitor is told
        // "received", not how the automation went.
        setImmediate(() => {
            deps.runAutomation(automation, { triggerKind: 'webhook', triggerPayload: values, triggerHeaders, rootStepId: triggerStepId })
                // The automation id only: an error text can repeat visitor input.
                .catch(() => log.warn(`[cms/forms] run failed for automation ${automation.id}`))
                .finally(() => {
                    const left = (pending.get(automation.id) || 1) - 1;
                    if (left > 0) pending.set(automation.id, left); else pending.delete(automation.id);
                });
        });
        return res.status(202).json({ accepted: true });
    });

    return router;
}

/** The public router wired to the real stores and runner. */
function createDefaultPublicRouter() {
    const cmsStore = require('../stores/cmsStore');
    const automationStore = require('../stores/automationStore');
    const formAutomations = require('../stores/cms/formAutomations');
    const { getLiveSiteId } = require('./cmsShared');
    const { organisationOf } = require('../automation/access').makeAutomationAccess();
    return createPublicRouter({
        getLiveSiteId,
        getPublishedSnapshot: (siteId) => cmsStore.getPublishedSnapshot(siteId),
        getAutomation: (id) => automationStore.getAutomation(id),
        organisationOf,
        getFormAutomation: formAutomations.getFormAutomation,
        checkAndStoreNonce: (nonce) => automationStore.checkAndStoreNonce(nonce),
        countDrop: require('../stores/cms/formDrops').countFormDrop,
        // Lazy: the runner pulls in most of the server, and a CMS visitor read never needs it.
        runAutomation: (automation, opts) => require('../core/automationRunner').executeAutomation(automation, opts),
    });
}

module.exports = {
    createDefaultPublicRouter, createPublicRouter, MAX_BODY_BYTES, MIN_FORM_AGE_MS, HONEYPOT_FIELD, MAX_PENDING_PER_AUTOMATION,
};
