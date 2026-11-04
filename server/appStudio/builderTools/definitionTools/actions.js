// @typecheck
/**
 * App Studio builder tools — ACTIONS and the events they hang off:
 * app_set_action (single or batched, with the duplicate-action net and the
 * tool-time validation that refuses now what finalize would refuse later),
 * app_remove_action and app_bind_action (single or batched).
 */

'use strict';

const {
    LIMITS,
    ACTION_KINDS,
    EVENT_NAMES,
    COMPONENT_SPECS,
    COMPONENT_TYPES,
    getSpec,
} = require('../../componentSpecs');
const ops = require('../../definitionOps');
const { pickClosestId } = require('../../../automation/validate/helpers');
const { repairAction, describeActionRefusal } = require('../actionNormalise');
const { canonicalJson } = require('../../../automation/builderTools/suggestedPatch');
const { adoptCanonical, limitRepairsUnder } = require('../shared');
const { limitReasons } = require('../limitRefusal.mts');
const { stepCountsByTopLevel } = require('../../actionStepCounts');
const { readBatchArg, runPatchBatch, finishPatchBatch } = require('./patchBatch');

/**
 * The canonicalizer cuts text and lists that pass a limit. For a stored app that stays a repair; a save
 * through this tool refuses it instead, so no input or instruction is lost unnoticed.
 * @returns {Record<string, unknown> | null} the refusal, or null when nothing would be cut
 */
function refuseLimitCuts(next, actionId, existing, withNotes) {
    const cuts = limitRepairsUnder(next, `actions.${actionId}`);
    if (!cuts.length) return null;
    const lines = cuts.slice(0, 5).map((r) => `${r.path.replace(`actions.${actionId}`, 'action')}: ${r.message}`);
    return withNotes({
        error: `This action exceeds a limit — nothing was ${existing ? 'changed' : 'created'}. ${lines.join(' | ')}`,
        _fixHint: `Reject reason: a limit is exceeded and nothing is cut automatically. ${lines.join(' | ')} Shorten the text, merge or remove the listed entries, or split the work over two actions (app_set_action {action:{kind:"sequence"…}}), then resend the whole action.`,
    });
}

function applySetAction(draftWrap, args) {
    const rawAction = args?.action;
    if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) {
        return { error: `action must be an object: { kind: ${ACTION_KINDS.map((k) => `"${k}"`).join('|')}, …fields }.` };
    }
    // Repair what is unambiguous BEFORE the kind check (a record action with
    // effects becomes a sequence) and before the validator: the run_automation
    // vocabulary in a record step, bare scalars, a tableId that names a table
    // by handle. The notes ride `_hints` on success and on a refusal alike.
    const tables = Array.isArray(draftWrap.dataModel?.tables) ? draftWrap.dataModel.tables : [];
    const repaired = repairAction(rawAction, { tables });
    if (repaired.refusal) return repaired.refusal;
    const action = /** @type {Record<string, any>} */ (repaired.action);
    const repairNotes = repaired.notes;
    const withNotes = (result) => {
        if (repairNotes.length && result && typeof result === 'object') result._hints = [...repairNotes, ...(Array.isArray(result._hints) ? result._hints : [])];
        return result;
    };
    if (!ACTION_KINDS.includes(action.kind)) {
        const suggestion = pickClosestId(action.kind, ACTION_KINDS);
        return {
            error: `Unknown action kind ${JSON.stringify(action.kind)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''} Legal kinds: ${ACTION_KINDS.join(', ')}.`,
        };
    }
    const requestedId = typeof args?.actionId === 'string' && args.actionId ? args.actionId : null;
    const existing = requestedId ? ops.findAction(draftWrap.def, requestedId) : null;
    if (Object.keys(draftWrap.def.actions || {}).length >= LIMITS.MAX_ACTIONS && !existing) {
        const count = Object.keys(draftWrap.def.actions || {}).length;
        return {
            error: `The app has ${count} actions — the maximum is ${LIMITS.MAX_ACTIONS}. Remove unused actions first (app_find_nodes {actionId} shows what still uses one).`,
            _fixHint: `Reject reason: the app is at its action limit (${count} of ${LIMITS.MAX_ACTIONS}). Remove an unused action with app_remove_action, or update an existing one with app_set_action {actionId, action}.`,
        };
    }
    // An identical action already exists → point at it instead of minting a
    // copy. A model that lost track of what it configured re-sends the same
    // navigate/toast; two identical actions validate fine and confuse every
    // later binding.
    if (!existing) {
        // Key-order-blind: the stored action is canonical, the model's is in
        // whatever order it wrote — a resend with the same content in another
        // order would mint a second copy.
        const sig = canonicalJson(action);
        const twin = Object.entries(draftWrap.def.actions || {}).find(([, a]) => { try { return canonicalJson(a) === sig; } catch (_) { return false; } });
        if (twin) {
            return withNotes({
                error: `This app already has action "${twin[0]}" with exactly this definition — reference it (app_bind_action { actionId: "${twin[0]}" }) instead of creating a second copy.`,
                actionId: twin[0],
                _fixHint: `Reject reason: duplicate action — "${twin[0]}" already has exactly this definition. Wire it with app_bind_action {nodeId, event, actionId:"${twin[0]}"}; to change it pass actionId with the patch; do not resend.`,
            });
        }
    }
    // Fresh creations always mint a canonical act_… id; an explicit id only
    // targets an EXISTING action (in-place update). Anything else would let a
    // sloppy id trigger a canonicalize re-key and confuse later references.
    const { def: next, actionId } = ops.setAction(draftWrap.def, existing ? requestedId : null, action);
    // Refuse at TOOL time what finalize would refuse one round later: a
    // navigate without an existing screen, a record step on a table or field
    // the app does not have, an automation the owner does not own, an unknown
    // field for the kind. The validator's own rules, filtered to this action —
    // one implementation, no second rulebook.
    {
        const { validateAppDefinition } = require('../../validate');
        const check = validateAppDefinition(next, {
            dataModel: draftWrap.dataModel,
            datasets: draftWrap.datasetIds,
            ...(draftWrap._ownedAutomations ? { ownedAutomations: draftWrap._ownedAutomations } : {}),
            ...(draftWrap._documents ? { ownedDocuments: draftWrap._documents } : {}),
            ...(draftWrap._ownerDatatables ? { datatables: draftWrap._ownerDatatables } : {}),
        });
        const mine = (check.errors || []).filter((e) => e && typeof e.path === 'string' && (e.path === `actions.${actionId}` || e.path.startsWith(`actions.${actionId}.`)));
        if (mine.length) {
            // The reason the model can act on (one implementation of the
            // wording: actionNormalise.describeActionRefusal), and the
            // mechanical fix as a patch where the validator named one.
            const described = describeActionRefusal(mine, { actionId, action, tables });
            const limits = limitReasons(mine, actionId);
            if (limits.length) described._fixHint = `Reject reason: ${limits.join(' | ')}.${/^Reject reason:/.test(described._fixHint) ? ` Also: ${described._fixHint.replace(/^Reject reason: /, '')}` : ''}`;
            // Too many steps: say where they sit, per top-level step, so the agent splits the right part.
            const tooMany = mine.some((e) => e.code === 'action.too_many_steps');
            const stepCounts = tooMany ? stepCountsByTopLevel(next.actions?.[actionId]?.steps) : null;
            return withNotes({
                ...(stepCounts ? { stepCounts, maxSteps: LIMITS.MAX_ACTION_STEPS } : {}),
                error: `This action would fail validation — nothing was ${existing ? 'changed' : 'created'}. ${mine.slice(0, 5).map((e) => `${e.path.replace(`actions.${actionId}`, 'action')}: ${e.message}${e.hint ? ` ${e.hint}` : ''}`).join(' | ')}`,
                errors: mine,
                ...described,
            });
        }
    }
    const cut = refuseLimitCuts(next, actionId, existing, withNotes);
    if (cut) return cut;
    if (requestedId && !existing) {
        const result = adoptCanonical(draftWrap, next, { actionId, created: true });
        result._hints = [
            ...(result._hints || []),
            `actionId "${requestedId}" did not exist — created a NEW action as "${actionId}". Use the returned id in bindings.`,
        ];
        return withNotes(result);
    }
    const result = adoptCanonical(draftWrap, next, { actionId, [existing ? 'updated' : 'created']: true });
    result.action = draftWrap.def.actions[actionId];
    return withNotes(result);
}

/** app_set_action — single action, or an `actions` batch. */
async function applySetActionTool(draftWrap, args) {
    const batch = readBatchArg(args, 'actions', 'action');
    if (batch.error) return batch;
    if (batch.single) return applySetAction(draftWrap, args);
    const { ok, failed, hints } = await runPatchBatch(draftWrap, batch.items, applySetAction);
    return finishPatchBatch({
        ok, failed, hints,
        allFailed: `All ${batch.items.length} action(s) failed — nothing was created or updated.`,
        listKey: 'actions',
        summary: {
            // `actionId` is the array of real ids IN ENTRY ORDER — the batch
            // analogue of the single form's scalar, so a follow-up
            // app_bind_action batch can read them straight off.
            actionId: ok.map((o) => o.result.actionId),
            actions: ok.map((o) => ({ index: o.index, actionId: o.result.actionId, created: o.result.created === true })),
        },
    });
}

function applyRemoveAction(draftWrap, args) {
    const actionId = args?.actionId;
    if (!ops.findAction(draftWrap.def, actionId)) {
        const suggestion = pickClosestId(actionId, Object.keys(draftWrap.def.actions || {}));
        return { error: `Unknown actionId ${JSON.stringify(actionId)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}` };
    }
    const next = ops.removeAction(draftWrap.def, actionId);
    return adoptCanonical(draftWrap, next, { removed: actionId });
}

function applyBindAction(draftWrap, args) {
    const { nodeId, event } = args || {};
    const actionId = args?.actionId ?? null;
    if (!EVENT_NAMES.includes(event)) {
        return { error: `event must be one of ${EVENT_NAMES.join(', ')} (got ${JSON.stringify(event)}).` };
    }
    const found = ops.findNode(draftWrap.def, nodeId);
    if (!found) {
        return { error: `Unknown nodeId ${JSON.stringify(nodeId)}.`, _fixHint: 'Use a real cmp_… id from the draft state (a button for onClick, a form for onSubmit).' };
    }
    const spec = getSpec(found.node.type);
    if (!spec || !Array.isArray(spec.events) || !spec.events.includes(event)) {
        const carriers = COMPONENT_TYPES.filter((t) => (COMPONENT_SPECS[t].events || []).includes(event));
        return { error: `${found.node.type} does not support ${event}. Components that do: ${carriers.join(', ')}.` };
    }
    if (actionId !== null) {
        if (typeof actionId !== 'string' || !ops.findAction(draftWrap.def, actionId)) {
            const suggestion = pickClosestId(actionId, Object.keys(draftWrap.def.actions || {}));
            return {
                error: `Unknown actionId ${JSON.stringify(actionId)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
                _fixHint: 'Create the action with app_set_action first, then bind its returned id.',
            };
        }
    }
    let next;
    if (event === 'onClick' || event === 'onSubmit') {
        next = ops.setNodeEvent(draftWrap.def, nodeId, event, actionId);
    } else {
        // onRowClick / onRowSelect / onCardMove — the pure op only covers the
        // two classic events; patch a deep copy the same way the logic fields
        // do (adoptCanonical rebuilds the canonical def right after anyway).
        if ((found.node[event] ?? null) === actionId) {
            next = draftWrap.def;
        } else {
            next = structuredClone(draftWrap.def);
            const target = ops.findNode(next, nodeId).node;
            if (actionId === null) delete target[event];
            else target[event] = actionId;
        }
    }
    return adoptCanonical(draftWrap, next, { nodeId, event, actionId });
}

/** app_bind_action — single wiring, or a `bindings` batch. */
async function applyBindActionTool(draftWrap, args) {
    const batch = readBatchArg(args, 'bindings', 'nodeId');
    if (batch.error) return batch;
    if (batch.single) return applyBindAction(draftWrap, args);
    const { ok, failed, hints } = await runPatchBatch(draftWrap, batch.items, applyBindAction);
    return finishPatchBatch({
        ok, failed, hints,
        allFailed: `All ${batch.items.length} binding(s) failed — nothing was wired.`,
        listKey: 'bindings',
        summary: {
            bound: ok.map((o) => ({ nodeId: o.result.nodeId, event: o.result.event, actionId: o.result.actionId })),
            actionId: ok.map((o) => o.result.actionId),
        },
    });
}

module.exports = {
    applySetActionTool,
    applyRemoveAction,
    applyBindActionTool,
};
