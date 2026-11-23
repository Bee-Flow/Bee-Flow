// @typecheck strict
/**
 * The address of a cowork that starts on a webhook (core/cowork/eventRun.mts, kind 'webhook'):
 *
 *   POST /hooks  with `Authorization: Bearer <token>` → 202 { accepted: true }, and the item runs with the JSON that
 *                was sent as its (outside) data.
 *
 * Open: another system calls it without a session. The token is the credential: 32 random characters, of which only
 * the sha-256 is stored (usecases/coworkStart.mts). It goes in a header, never in the address, so it does not end up
 * in access logs. A missing, unknown or malformed token and a paused item are the same 404. Limited per token and per
 * caller, and the body is at most 64 kB of JSON. The run itself is the Cowork runner's: the organisation's policy, the
 * item's budget and its hourly limit apply.
 *
 * routes/cowork.js mounts this BEFORE its requireAuth.
 */

const crypto = require('node:crypto');
const express = require('express');
const { validate } = require('../core/http/validate');
const { z } = require('../core/http/schemaParts');
const { limiterUnlessZero } = require('../utils/perUserRateLimit');
const log = require('../telemetry/log');

const PER_ADDRESS = 30;
const PER_CALLER = 120;
/** The bearer token of a call, or ''. Plain string work: the header is request text. @param {import('express').Request} req */
function tokenOf(req) {
    const header = String(req.get('authorization') || '');
    return header.slice(0, 7).toLowerCase() === 'bearer ' ? header.slice(7).trim() : '';
}
const addressLimit = limiterUnlessZero({ max: PER_ADDRESS, keyFn: (/** @type {import('express').Request} */ req) => `cwhook:${crypto.createHash('sha256').update(tokenOf(req)).digest('hex')}` });
const callerLimit = limiterUnlessZero({ max: PER_CALLER, keyFn: (/** @type {import('express').Request} */ req) => `cwhookip:${req.ip || 'unknown'}` });
const json = express.json({ limit: '64kb' });

const HookBody = z.record(z.string(), z.unknown(), { error: 'The body is a JSON object.' });
const NOT_FOUND = { error: 'Not found' };

/**
 * @param {import('express').Router} router
 * @typedef {import('../stores/coworkStarts.mts').CoworkItem} CoworkItem
 * @typedef {import('../core/cowork/eventRun.mts').CoworkEvent} CoworkEvent
 * @param {{ findByHookHash?: (hash: string) => Promise<CoworkItem | null>, start?: (item: CoworkItem, event: CoworkEvent) => Promise<boolean> }} [overrides]
 */
function mountHookRoutes(router, overrides = {}) {
    const find = overrides.findByHookHash ?? ((/** @type {string} */ hash) => require('../stores/coworkStarts.mts').coworkStarts().findByHookHash(hash));
    const start = overrides.start ?? ((/** @type {CoworkItem} */ item, /** @type {CoworkEvent} */ event) => require('../core/cowork/eventRun.mts').runOnEvent(item, event));
    router.post('/hooks', callerLimit, addressLimit, json, validate({ body: HookBody }), async (req, res) => {
        const token = tokenOf(req);
        if (token.length < 20 || token.length > 64) return res.status(404).json(NOT_FOUND);
        const item = await find(crypto.createHash('sha256').update(token).digest('hex'));
        if (!item || item.isActive === false) return res.status(404).json(NOT_FOUND);
        const event = { kind: /** @type {const} */ ('webhook'), ref: crypto.randomUUID(), label: 'a call to its address', data: { body: req.body } };
        // Answered at once; the run is the runner's (a slow run never holds the caller).
        setImmediate(() => { start(item, event).catch((/** @type {Error} */ e) => log.warn(`[Cowork] a webhook start of ${item.id} failed: ${e.message}`)); });
        res.status(202).json({ accepted: true });
    });
}

module.exports = { mountHookRoutes };
