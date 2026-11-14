// @typecheck strict
/**
 * The server triggers of an app, for its editor (appStudio/triggers/).
 *
 *   GET /:id/triggers             every trigger of the draft and every armed one: armed or not,
 *                                 the next fire, the last fire and how its run ended
 *   PUT /:id/triggers/:triggerId  { enabled } switch an ARMED trigger off, or on again
 *   GET /:id/triggers/:triggerId/webhook          a webhook trigger's address, how to sign for it and
 *                                                 its last deliveries (never the secret)
 *   POST /:id/triggers/:triggerId/webhook/secret  the signing secret, the ONE time it is shown
 *   POST /:id/triggers/:triggerId/webhook/rotate  a new secret, shown once; the old one signs on for a while
 *
 * Owner only (canWriteStudioApp); every other caller gets the same 404 as for an unknown app (the
 * run log's pattern): a trigger runs as the owner, so only the owner reads or switches it. The
 * switch never arms anything that the publish did not: a trigger without an armed row answers
 * 409 `not_armed`, and switching one on asks the fire's own question first.
 * Thin: the state and the switch are appStudio/triggers/triggerState.mts, the webhook's address
 * and secret appStudio/triggers/webhook/webhookEndpoints.mts.
 */

const express = require('express');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const studioAppStore = require('../../stores/studioAppStore');
const { requireAuth } = require('../../auth/permissions');
const { sessionUser } = require('../../core/http/sessionUser');
const { TriggerParams, TriggerSwitchBody, NoBody } = require('./schemas');
const { listTriggerState, setTriggerEnabled } = require('../../appStudio/triggers/triggerState.mts');
const { webhookView, revealWebhookSecret, rotateWebhookSecret } = require('../../appStudio/triggers/webhook/webhookEndpoints.mts');
const { resolvePublicBaseUrl } = require('../../utils/publicUrl');

const router = express.Router();

/**
 * Middleware: the app when the caller owns it, on `res.locals.ownedApp`; anything else is the 404
 * of an unknown app. Before the body is read, so a stranger learns nothing from a refused body.
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function gateOwnedApp(req, res, next) {
    const app = await studioAppStore.getStudioApp(req.params.id);
    if (!app || !studioAppStore.canWriteStudioApp(app, sessionUser(req).id)) throw new HttpError(404, 'not_found', 'App not found');
    res.locals.ownedApp = app;
    next();
}

router.get('/:id/triggers', requireAuth, gateOwnedApp, async (_req, res) => {
    res.json(await listTriggerState(res.locals.ownedApp));
});

router.put('/:id/triggers/:triggerId', requireAuth, gateOwnedApp, validate({ params: TriggerParams, body: TriggerSwitchBody }), /** @param {import('express').Request<{ id: string, triggerId: string }>} req */ async (req, res) => {
    const out = await setTriggerEnabled(res.locals.ownedApp, req.params.triggerId, req.body.enabled === true);
    if (!out.ok) throw new HttpError(out.status, out.code, out.error);
    res.json({ trigger: out.trigger });
});

router.get('/:id/triggers/:triggerId/webhook', requireAuth, gateOwnedApp, validate({ params: TriggerParams }), /** @param {import('express').Request<{ id: string, triggerId: string }>} req */ async (req, res) => {
    const view = await webhookView(res.locals.ownedApp, req.params.triggerId);
    // The whole address: the owner pastes it into another system.
    res.json({ ...view, endpoint: view.endpoint ? { ...view.endpoint, url: `${resolvePublicBaseUrl(req)}${view.endpoint.path}` } : null });
});

/**
 * The answer that carries a secret: never cached, and a refusal says why.
 * @param {import('express').Response} res
 * @param {import('../../appStudio/triggers/webhook/webhookEndpoints.mts').SecretResult} out
 */
function sendSecret(res, out) {
    if (!out.ok) throw new HttpError(out.status, out.code, out.error);
    res.set('Cache-Control', 'no-store');
    res.json({ secret: out.secret, previousValidUntil: out.previousValidUntil });
}

router.post('/:id/triggers/:triggerId/webhook/secret', requireAuth, gateOwnedApp, validate({ params: TriggerParams, body: NoBody }), /** @param {import('express').Request<{ id: string, triggerId: string }>} req */ async (req, res) => {
    sendSecret(res, await revealWebhookSecret(res.locals.ownedApp, req.params.triggerId));
});

router.post('/:id/triggers/:triggerId/webhook/rotate', requireAuth, gateOwnedApp, validate({ params: TriggerParams, body: NoBody }), /** @param {import('express').Request<{ id: string, triggerId: string }>} req */ async (req, res) => {
    sendSecret(res, await rotateWebhookSecret(res.locals.ownedApp, req.params.triggerId));
});

module.exports = router;
