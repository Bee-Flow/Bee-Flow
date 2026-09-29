/**
 * App Studio builder tools — editing a component that already exists:
 * app_update_component (props/style/visible plus the v2 logic fields, single
 * or batched), app_move_node and app_remove_node.
 */

'use strict';

const ops = require('../../definitionOps');
const { pickClosestId } = require('../../../automation/validate/helpers');
const { checkComponentDataRefs, guardResult } = require('../bindingGuard');
const { NODE_AUTHORABLE_FIELDS, normalizeNodeField, adoptCanonical } = require('../shared');
const { resolveParent } = require('./componentPlacement');
const { readBatchArg, runPatchBatch, finishPatchBatch } = require('./patchBatch');

function applyUpdateComponent(draftWrap, args) {
    const id = args?.id;
    const found = ops.findNode(draftWrap.def, id);
    if (!found) {
        const suggestion = pickClosestId(id, [...ops.collectIds(draftWrap.def)]);
        return { error: `Unknown component id ${JSON.stringify(id)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`, _fixHint: 'Use a real cmp_… id from the draft state.' };
    }
    const hasProps = args?.props && typeof args.props === 'object' && !Array.isArray(args.props) && Object.keys(args.props).length > 0;
    const hasStyle = args?.style && typeof args.style === 'object' && !Array.isArray(args.style) && Object.keys(args.style).length > 0;
    const hasVisible = typeof args?.visible === 'boolean';
    const logicFields = NODE_AUTHORABLE_FIELDS.filter((f) => args?.[f] !== undefined);
    if (!hasProps && !hasStyle && !hasVisible && !logicFields.length) {
        return { error: `Nothing to change — pass props, style, visible and/or ${NODE_AUTHORABLE_FIELDS.join('/')}.` };
    }
    // A props patch that names a table or field the app does not have is
    // refused now, not at finalize (same guard as app_add_components).
    let propsPatch = hasProps ? args.props : null;
    const guardNotes = [];
    if (hasProps) {
        const probe = [{ type: found.node.type, props: { ...found.node.props, ...args.props } }];
        const check = checkComponentDataRefs(probe, draftWrap.dataModel);
        const guard = guardResult(check, `the props of ${id}`);
        if (guard) return { error: guard.error, _fixHint: guard._fixHint, ...(guard._suggestedPatch ? { _suggestedPatch: guard._suggestedPatch } : {}) };
        if (check.repairs.length) {
            // The guard rewrote a table handle in place (input_relation.tableId).
            propsPatch = { ...args.props, ...(probe[0].props.tableId !== undefined ? { tableId: probe[0].props.tableId } : {}) };
            guardNotes.push(...check.repairs);
        }
    }
    let next = draftWrap.def;
    if (hasProps) next = ops.updateNodeProps(next, id, propsPatch);
    if (hasStyle) next = ops.updateNodeStyle(next, id, args.style);
    if (hasVisible) next = ops.setNodeVisible(next, id, args.visible);
    if (logicFields.length) {
        // Normalize first so a bad value rejects before anything is applied.
        const normalized = {};
        for (const field of logicFields) {
            if (args[field] === null) { normalized[field] = null; continue; } // null clears
            const norm = normalizeNodeField(field, args[field]);
            if (norm.error) return { error: norm.error };
            normalized[field] = norm.value;
        }
        // Node-level fields have no dedicated pure op yet — patch a deep copy
        // (adoptCanonical rebuilds the canonical def right after anyway).
        const cloned = structuredClone(next);
        const target = ops.findNode(cloned, id).node;
        for (const [field, value] of Object.entries(normalized)) {
            if (value === null) delete target[field];
            else target[field] = value;
        }
        next = cloned;
    }
    if (next === draftWrap.def) {
        // No-op patch (the values already match) — the model's intent holds.
        return { updated: id, note: 'No change — the component already had those values.' };
    }
    const result = adoptCanonical(draftWrap, next, { updated: id });
    const node = ops.findNode(draftWrap.def, id)?.node;
    if (node) {
        result.component = { id: node.id, type: node.type, props: node.props, style: node.style, visible: node.visible };
        // Emit-when-present: a node without the v2 fields echoes exactly what
        // it always did, and a node WITH them shows the model they landed.
        for (const field of NODE_AUTHORABLE_FIELDS) {
            if (node[field] !== undefined) result.component[field] = node[field];
        }
    }
    if (guardNotes.length) result._hints = [...guardNotes, ...(result._hints || [])];
    return result;
}

/** app_update_component — single patch, or a `updates` batch. */
async function applyUpdateComponentTool(draftWrap, args) {
    const batch = readBatchArg(args, 'updates', 'id');
    if (batch.error) return batch;
    if (batch.single) return applyUpdateComponent(draftWrap, args);
    const { ok, failed, hints } = await runPatchBatch(draftWrap, batch.items, applyUpdateComponent);
    if (batch.note) hints.push(batch.note);
    return finishPatchBatch({
        ok, failed, hints,
        allFailed: `All ${batch.items.length} component update(s) failed — nothing changed.`,
        listKey: 'updates',
        summary: { updated: ok.map((o) => o.result.updated) },
    });
}

function applyMoveNode(draftWrap, args) {
    const id = args?.id;
    const def = draftWrap.def;
    const found = ops.findNode(def, id);
    if (!found) {
        return { error: `Unknown component id ${JSON.stringify(id)}.`, _fixHint: 'Use a real cmp_… id from the draft state.' };
    }
    const parent = resolveParent(def, args?.toParentId);
    if (parent.error) return parent;

    const subtree = new Set([id]);
    const walk = (n) => { for (const c of n.children || []) { subtree.add(c.id); walk(c); } };
    walk(found.node);
    if (subtree.has(args.toParentId)) {
        return { error: `Cannot move "${id}" into itself or its own descendant "${args.toParentId}".` };
    }

    const next = ops.moveNode(def, id, { toParentId: args.toParentId, index: args?.index });
    if (next === def) {
        return { moved: id, toParentId: args.toParentId, note: 'No change — the node was already at that position.' };
    }
    return adoptCanonical(draftWrap, next, { moved: id, toParentId: args.toParentId });
}

function applyRemoveNode(draftWrap, args) {
    const id = args?.id;
    if (typeof id !== 'string' || !id) return { error: 'id is required — the cmp_… id of the component to remove.', _fixHint: 'Use a real cmp_… id from the draft state.' };
    const next = ops.removeNode(draftWrap.def, id);
    if (next === draftWrap.def) {
        // Removing what is not there is the outcome the caller wants: the
        // component is gone. A refusal here fed a six-round loop of invented
        // ids (measured 2026-09-14); a soft answer names what does exist.
        const ids = [...ops.collectIds(draftWrap.def)].filter((x) => /^cmp_/.test(x));
        return { removed: null, alreadyAbsent: id, note: `${id} is not in the app (nothing to remove). Components that exist: ${ids.slice(0, 20).join(', ') || 'none'}${ids.length > 20 ? ', …' : ''}.` };
    }
    return adoptCanonical(draftWrap, next, { removed: id });
}

module.exports = {
    applyUpdateComponentTool,
    applyMoveNode,
    applyRemoveNode,
};
