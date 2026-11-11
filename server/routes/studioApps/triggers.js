// @typecheck strict
/**
 * The server triggers of an app, for its editor (appStudio/triggers/).
 *
 *   GET /:id/triggers             every trigger of the draft and every armed one: armed or not,
 *                                 the next fire, the last fire and how its run ended
 *   PUT /:id/triggers/:triggerId  { enabled } switch an ARMED trigger off, or on again
 *
 * Owner only (canWriteStudioApp); every other caller gets the same 404 as for an unknown app (the
 * run log's pattern): a trigger runs as the owner, so only the owner reads or switches it. The
 * switch never arms anything that the publish did not: a trigger without an armed row answers
 * 409 `not_armed`, and switching one on asks the fire's own question first.
 * Thin: the state and the switch are appStudio/triggers/triggerState.mts.
 */

const express = require('express');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const studioAppStore = require('../../stores/studioAppStore');
const { requireAuth } = require('../../auth/permissions');
const { sessionUser } = require('../../core/http/sessionUser');
const { TriggerParams, TriggerSwitchBody } = require('./schemas');
const { listTriggerState, setTriggerEnabled } = require('../../appStudio/triggers/triggerState.mts');

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

module.exports = router;
