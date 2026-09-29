/**
 * THE TWO WAYS PAST A PHASE THAT DID NOT WORK.
 *
 * Skip steps over it and hands the turn to the next phase (the table phase
 * excepted — everything later builds on it). Retry puts the phase back at
 * `ready` with its attempt counted and the last artifacts kept under
 * `previous`, optionally recomposing a brief the person had edited.
 */

'use strict';

const lifecycle = require('../../playbooks/lifecycle');
const { z, sendErr, bodyOf, expectedVersion, check } = require('./contract');

// -- What a caller may send -------------------------------------------
//
// `expectedVersion` is the optimistic lock, and it was read as
// `Number(req.body?.expectedVersion)` and then checked only
// `if (Number.isInteger(…))`. So a value that is not a number -- `'abc'`,
// `null`, an object -- SKIPPED THE CHECK ENTIRELY: the phase was skipped or
// retried on top of whatever somebody else had written in the meantime, and
// the answer was a 200 with the new row.
//
// A MISSING one did the same thing, and still did after the shape was
// checked: the schema made it optional and the route compared only
// `asked !== undefined && …`, so `{}` -- or no body at all -- moved the
// phase with no lock. Both routes are documented as `{ expectedVersion }`
// (index.js) and every caller sends it (usePlaybook, scripts/drive-playbook.js),
// so it is required here: the lock is not a thing a request can opt out of by
// leaving it out.
const lockedVersion = () => expectedVersion().unwrap();
const SkipBody = bodyOf({ expectedVersion: lockedVersion() });
const RetryBody = bodyOf({
    expectedVersion: lockedVersion(),
    resetBrief: z.boolean({ invalid_type_error: 'resetBrief is true or false.' }).optional(),
});
const { kindOf } = require('./phaseList');
const log = require('../../telemetry/log');

function register(router, ctx) {
    const { d, flow, requireManageApps } = ctx;
    const { resolveRecipe, approvalsAllowed, load, withBrief, prepareNext, persist } = flow;

    router.post('/:id/phases/:key/skip', requireManageApps, async (req, res) => {
        try {
            const pb = await load(req, res);
            if (!pb) return;
            const key = req.params.key;
            const cur = lifecycle.phaseByKey(pb.phases, key);
            // Same answer as retry. Without it an unknown key reached
            // applyTransition, whose `unknown_phase` fell through to the 500
            // below: a typo in the URL logged as a server failure.
            if (!cur) return sendErr(res, 400, 'bad_patch', 'Unknown phase.');
            if (kindOf(cur) === 'table') return sendErr(res, 409, 'illegal_transition', 'The table phase cannot be skipped — every later phase builds on it.', { from: 'table', to: 'skipped' });
            const parsed = check(res, SkipBody, req.body, 'bad_patch');
            if (!parsed.ok) return;
            if (parsed.value.expectedVersion !== pb.version) return sendErr(res, 409, 'version_conflict', 'This playbook changed elsewhere.', { currentVersion: pb.version, playbook: pb });
            const recipe = resolveRecipe(pb);
            const nowIso = new Date(d.now()).toISOString();
            let phases = lifecycle.applyTransition(pb.phases, key, 'skipped', {}, nowIso);
            const nextKey = lifecycle.nextPhaseKey(phases, key);
            if (nextKey) {
                const next = lifecycle.phaseByKey(phases, nextKey);
                if (next.status === 'pending') phases = lifecycle.applyTransition(phases, nextKey, 'ready', {}, nowIso);
                phases = await prepareNext(recipe, pb, phases, nextKey, req);
            }
            const status = lifecycle.playbookStatus(phases) === 'done' ? 'done' : undefined;
            const saved = await persist(res, pb, { phases, currentPhase: lifecycle.currentPhaseKey(phases), status }, pb.version);
            if (saved) res.json({ playbook: saved });
        } catch (e) {
            if (e.code === 'illegal_transition') return sendErr(res, 409, 'illegal_transition', e.message, { from: e.from, to: e.to });
            log.error('[Playbooks] skip failed:', e.message);
            sendErr(res, 500, 'internal', 'Could not skip the phase');
        }
    });

    router.post('/:id/phases/:key/retry', requireManageApps, async (req, res) => {
        try {
            const pb = await load(req, res);
            if (!pb) return;
            const key = req.params.key;
            const cur = lifecycle.phaseByKey(pb.phases, key);
            if (!cur) return sendErr(res, 400, 'bad_patch', 'Unknown phase.');
            const parsed = check(res, RetryBody, req.body, 'bad_patch');
            if (!parsed.ok) return;
            if (parsed.value.expectedVersion !== pb.version) return sendErr(res, 409, 'version_conflict', 'This playbook changed elsewhere.', { currentVersion: pb.version, playbook: pb });
            if (cur.status === 'locked' && !(await approvalsAllowed(req))) return sendErr(res, 409, 'capability_missing', 'The approval flow needs the approvals capability.');
            const recipe = resolveRecipe(pb);
            const resetBrief = !!parsed.value.resetBrief;
            let phases = lifecycle.applyTransition(pb.phases, key, 'ready', {
                error: null, attempt: (cur.attempt || 0) + 1,
                artifacts: { ...(cur.artifacts || {}), previous: cur.artifacts && Object.keys(cur.artifacts).length ? { ...cur.artifacts, previous: undefined } : undefined },
                ...(resetBrief ? { briefEdited: false } : {}),
            }, new Date(d.now()).toISOString());
            if (resetBrief || !cur.brief) {
                try { phases = withBrief(recipe, pb, phases, key); } catch (e) { if (e.code !== 'artifacts_missing') throw e; }
            }
            const saved = await persist(res, pb, { phases, currentPhase: key, status: 'active' }, pb.version);
            if (saved) res.json({ playbook: saved });
        } catch (e) {
            if (e.code === 'illegal_transition') return sendErr(res, 409, 'illegal_transition', e.message, { from: e.from, to: e.to });
            log.error('[Playbooks] retry failed:', e.message);
            sendErr(res, 500, 'internal', 'Could not retry the phase');
        }
    });
}

module.exports = { register };
