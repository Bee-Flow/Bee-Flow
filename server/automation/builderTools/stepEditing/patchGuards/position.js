/**
 * builder_update_step — the position and branch-wiring keys of a patch
 * (afterStepId/branch/caseName, thenStepId/elseStepId), applied BEFORE the
 * per-type allow-list. Moved out of applyUpdateStep (stepEditing.js); the
 * body is verbatim, the function returns what the caller used to assign.
 *
 * Returns { error } (refused), { result } (a move-only patch: the update's
 * answer), or { patch, moved, found } (the rest of the patch; `found` is the
 * fresh slot after a move, null when nothing moved).
 */

const { findStepAnywhere, moveStepAfter } = require('../../draftGraph');
const { followAddedSteps } = require('../../routeFollowDraft');
const { MOVE_KEYS, WIRE_KEYS } = require('../patchFields');

// ── Position and branch wiring (2026-09-11) ──
// A step's PLACE is patchable too. Measured builds thrashed for 10-14
// rounds because the model's first, correct instinct — `{afterStepId}` on
// a misplaced loop, `{elseStepId}` on a half-wired condition — was refused
// here as "not patchable", and the only route left was remove + re-add,
// which mints a new id and lands at the tail again. `moveStepAfter` keeps
// the id and re-joins the chain the step leaves; see its header.
function applyPositionPatch(graph, stepId, step, patch) {
    const moved = [];
    if (MOVE_KEYS.some(k => k in patch) || WIRE_KEYS.some(k => k in patch)) {
        if ('afterStepId' in patch) {
            const r = moveStepAfter(graph, stepId, { afterStepId: patch.afterStepId, branch: patch.branch, caseName: patch.caseName });
            if (r.error) return { error: r.error };
            moved.push(r.now + (r.note ? ` — ${r.note}` : ''));
        } else if ('branch' in patch || 'caseName' in patch) {
            return { error: 'branch/caseName say WHERE a moved step goes — pass afterStepId with them: patch:{afterStepId:"<condition or switch id>", branch:"else"}.' };
        }
        for (const k of WIRE_KEYS) {
            if (!(k in patch)) continue;
            if (step.type !== 'condition') {
                return { error: `${k} is for a condition step; "${stepId}" is a ${step.type}. To move a step, patch THAT step: builder_update_step({stepId:"<step>", patch:{afterStepId:"${stepId}"${step.type === 'switch' ? ', caseName:"<case>"' : ''}}}).` };
            }
            const target = patch[k];
            if (typeof target !== 'string' || !target) return { error: `${k} must be the id of an existing step.` };
            const r = moveStepAfter(graph, target, { afterStepId: stepId, branch: k === 'thenStepId' ? 'then' : 'else' });
            if (r.error) return { error: r.error };
            moved.push(r.now + (r.note ? ` — ${r.note}` : ''));
        }
        const rest = { ...patch };
        for (const k of [...MOVE_KEYS, ...WIRE_KEYS]) delete rest[k];
        patch = rest;
        // The move re-ordered the steps array, so the slot found above is stale.
        const found = findStepAnywhere(graph, stepId);
        if (!Object.keys(patch).length) {
            const notes = followAddedSteps(graph, [stepId]);
            return { result: { updated: findStepAnywhere(graph, stepId).step, moved, ...(notes.length ? { _warnings: notes } : {}) } };
        }
        return { patch, moved, found };
    }
    return { patch, moved, found: null };
}

module.exports = { applyPositionPatch };
