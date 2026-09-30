// @typecheck
'use strict';

/**
 * POST /api/compliance/checks/:id/state — an admin's decision about one open
 * finding (compliance/findingState.js has the rules).
 *
 *   { scope_id?: string|null, state: 'acknowledged'|'accepted_risk'|'snoozed'|'open',
 *     reason?: string, until?: ISO date, days?: 1…365 }
 *   → 200 { finding_state }            (null after 'open')
 *
 *   acknowledged   reason optional
 *   accepted_risk  reason required; `until` (a review date) optional
 *   snoozed        `until` or `days` required, in the future, within a year
 *   open           forget the decision (re-open)
 *
 * Refusals: 404 unknown check; 409 framework_disabled (a stale tab after the
 * framework was switched off); 409 finding_not_open (nothing to decide about:
 * the slot has no row, or it passes). The decision is taken against the row
 * the server holds NOW — its fingerprint is computed here, never sent by the
 * client — so an admin cannot acknowledge a finding they have not seen.
 *
 * Every decision, re-opening included, is a link in the evidence chain. The
 * free-text reason stays in the mutable state table; the chain carries its
 * sha256, so the reason can be shown to have been what it was without an
 * immutable copy of whatever an admin typed (it may name a person).
 *
 * Mounted inside routes/compliance/checks.js. Dependencies are injectable.
 */

const crypto = require('crypto');
const express = require('express');
const { z, bodyOf, choice } = require('../../core/http/schemaParts');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const findingState = require('../../compliance/findingState');

const MAX_DAYS = 365;
const DAY_MS = 24 * 3600 * 1000;

const StateBody = bodyOf({
    scope_id: z.string({ invalid_type_error: 'scope_id must be a text id or null.' })
        .max(300, 'scope_id is at most 300 characters.').nullable().optional(),
    state: choice(['acknowledged', 'accepted_risk', 'snoozed', 'open'],
        'state must be one of acknowledged, accepted_risk, snoozed or open.'),
    reason: z.string({ invalid_type_error: 'reason must be text.' }).trim()
        .max(500, 'reason is at most 500 characters.').optional(),
    until: z.string({ invalid_type_error: 'until must be an ISO date.' })
        .max(40, 'until must be an ISO date.').optional(),
    days: z.number({ invalid_type_error: 'days must be a whole number of days.' })
        .int('days must be a whole number of days.')
        .min(1, 'days must be at least 1.').max(MAX_DAYS, `days is at most ${MAX_DAYS}.`).optional(),
}, 'A finding decision');

function _defaults() {
    const perms = require('../../auth/permissions');
    return {
        requireAuth: perms.requireAuth,
        requirePermission: perms.requirePermission,
        complianceStore: () => require('../../stores/complianceStore'),
        registry: () => require('../../compliance/registry'),
        frameworkPolicy: () => require('../../compliance/frameworkPolicy'),
        resolveOrgId: (req) => require('./shared').resolveOrgId(req),
        invalidateCounts: (orgId) => { try { require('../../compliance/countsCache').invalidate(orgId); } catch { /* not mounted */ } },
        now: () => Date.now(),
    };
}

/** `until` from the body, as an ISO string, or an HttpError. */
function _until(body, nowMs, required) {
    let ms = null;
    if (body.days != null) ms = nowMs + body.days * DAY_MS;
    else if (body.until) {
        const t = Date.parse(body.until);
        if (!Number.isFinite(t)) throw new HttpError(400, 'invalid_request', 'until must be an ISO date.');
        ms = t;
    }
    if (ms == null) {
        if (required) throw new HttpError(400, 'invalid_request', 'A snooze needs an end: send until or days.');
        return null;
    }
    if (ms <= nowMs) throw new HttpError(400, 'invalid_request', 'until must be in the future.');
    if (ms > nowMs + MAX_DAYS * DAY_MS + DAY_MS) throw new HttpError(400, 'invalid_request', `until is at most ${MAX_DAYS} days away.`);
    return new Date(ms).toISOString();
}

function makeFindingStateRouter(overrides = {}) {
    const d = { ..._defaults(), ...overrides };
    const store = () => (typeof d.complianceStore === 'function' ? d.complianceStore() : d.complianceStore);
    const registry = () => (typeof d.registry === 'function' ? d.registry() : d.registry);
    const policy = () => (typeof d.frameworkPolicy === 'function' ? d.frameworkPolicy() : d.frameworkPolicy);
    const router = express.Router();

    router.post('/checks/:id/state',
        d.requireAuth,
        d.requirePermission('admin_compliance'),
        validate({ body: StateBody }),
        async (req, res) => {
            const orgId = await d.resolveOrgId(req);
            const checkId = String(req.params.id);
            const def = registry().get(checkId);
            if (!def) throw new HttpError(404, 'unknown_check', 'There is no check with this id.');
            const active = await policy().activeRegulations(orgId, { req });
            if (!active.has(def.regulation)) {
                throw new HttpError(409, 'framework_disabled', 'This check belongs to a framework that is not active for your organisation.');
            }
            const body = req.body || {};
            const scopeId = body.scope_id == null || body.scope_id === '' ? null : String(body.scope_id);
            const scopeKey = findingState.scopeKeyOf({ scope_id: scopeId });
            const actorId = req.session?.user?.id || null;
            const nowMs = d.now();

            const evidence = async (payload) => store().addEvidence({
                organization_id: orgId,
                check_id: checkId,
                subject_type: 'finding-state',
                subject_id: scopeKey,
                payload: { ...payload, check_id: checkId, scope_key: scopeKey, actor: actorId, at: new Date(nowMs).toISOString() },
            });

            if (body.state === 'open') {
                const had = await store().clearFindingState(orgId, checkId, scopeKey);
                if (had) await evidence({ action: 'finding_reopened' });
                d.invalidateCounts(orgId);
                return res.json({ finding_state: null });
            }

            const slots = await store().listLatestScopes(orgId, checkId);
            const row = (slots || []).find(s => findingState.scopeKeyOf(s) === scopeKey && s.scope_type !== 'coverage')
                || (slots || []).find(s => findingState.scopeKeyOf(s) === scopeKey);
            if (!row || (row.status !== 'warn' && row.status !== 'fail')) {
                throw new HttpError(409, 'finding_not_open', 'There is no open finding to decide about here.');
            }
            const reason = body.reason ? body.reason : null;
            if (body.state === 'accepted_risk' && (!reason || reason.length < 3)) {
                throw new HttpError(400, 'invalid_request', 'Accepting a risk needs a reason of at least 3 characters.');
            }
            const until = _until(body, nowMs, body.state === 'snoozed');
            const fullRow = { ...row, check_id: checkId };
            const fingerprint = findingState.fingerprintOf(fullRow, def);
            const saved = await store().setFindingState(orgId, {
                checkId, scopeKey, fingerprint, state: body.state, reason, until, actorId,
            });
            await evidence({
                action: 'finding_state',
                state: body.state,
                until,
                fingerprint,
                status: row.status,
                has_reason: !!reason,
                reason_sha256: reason ? crypto.createHash('sha256').update(reason).digest('hex') : null,
            });
            d.invalidateCounts(orgId);
            res.json({ finding_state: findingState.publicState(saved, fullRow, def, nowMs) });
        });

    return router;
}

module.exports = { makeFindingStateRouter, StateBody };
