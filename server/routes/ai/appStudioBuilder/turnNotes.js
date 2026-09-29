/**
 * App Studio Builder — the machine notes folded into the single user message
 * each turn: the live draft state, the approved plan, the planMode directive,
 * and the editor context (what the user is looking at).
 *
 * They live in the USER message rather than the system prompt on purpose —
 * the system prefix has to stay byte-stable across turns for the provider
 * prompt caches (see the cache-discipline note on appStudioBuilder.js). Each
 * one is stamped with its prefix from ./turnLoop so sanitizeHistory can strip
 * it again next turn.
 */

const { renderDraftState } = require('../../../appStudio/builderPrompt');
const {
    APPROVED_PLAN_PREFIX, PLAN_POLICY_PREFIX, DRAFT_STATE_PREFIX, EDITOR_CONTEXT_PREFIX,
} = require('./turnLoop');

/** The approved plan, re-rendered as a machine message every turn until finalize. */
function renderApprovedPlanNote(plan) {
    return `${APPROVED_PLAN_PREFIX}\nThe user approved this plan — build exactly it (do not re-propose). Announce each phase with app_mark_phase as you start it.\n${JSON.stringify(plan)}`;
}

/** planMode directive (only when non-'auto'); null for 'auto' (system-prompt policy applies). */
function renderPlanPolicyNote(mode) {
    if (mode === 'always') return `${PLAN_POLICY_PREFIX}\nPropose a build plan with app_propose_plan before building anything this turn.`;
    if (mode === 'never') return `${PLAN_POLICY_PREFIX}\nDo NOT propose a plan — build the app directly with the tools.`;
    return null;
}

function renderDraftStateNote(def, draftWrap = {}) {
    return `${DRAFT_STATE_PREFIX}\n${renderDraftState(def, {
        dataModel: draftWrap.dataModel,
        datasets: draftWrap.datasetIds,
        rowCounts: draftWrap.rowCounts,
        linkedTables: draftWrap.linkedTables || null,
    })}`;
}

// ── Editor context — whitelisted, bounded projection of body.context ──

const CONTEXT_STRING_KEYS = ['screenId', 'nodeId', 'boundTableId', 'templateId'];
const MAX_SELECTED_NODE_IDS = 20;
const MAX_CONTEXT_ID_LEN = 64;

/** Whitelist + bound the client's editor context; null when nothing usable. */
function sanitizeEditorContext(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const key of CONTEXT_STRING_KEYS) {
        const v = raw[key];
        if (typeof v === 'string' && v && v.length <= MAX_CONTEXT_ID_LEN) out[key] = v;
    }
    if (Array.isArray(raw.selectedNodeIds)) {
        const ids = raw.selectedNodeIds
            .filter((v) => typeof v === 'string' && v && v.length <= MAX_CONTEXT_ID_LEN)
            .slice(0, MAX_SELECTED_NODE_IDS);
        if (ids.length) out.selectedNodeIds = ids;
    }
    return Object.keys(out).length ? out : null;
}

function renderEditorContextNote(context) {
    if (!context) return null;
    const lines = [EDITOR_CONTEXT_PREFIX];
    if (context.screenId) lines.push(`open screen: ${context.screenId}`);
    if (context.selectedNodeIds) lines.push(`selected component(s): ${context.selectedNodeIds.join(', ')}`);
    if (context.nodeId) lines.push(`focused component: ${context.nodeId}`);
    if (context.boundTableId) lines.push(`data table in view: ${context.boundTableId}`);
    if (context.templateId) lines.push(`started from template: ${context.templateId}`);
    lines.push('When the user says "this"/"here", they most likely mean the ids above.');
    return lines.join('\n');
}

module.exports = {
    renderApprovedPlanNote,
    renderPlanPolicyNote,
    renderDraftStateNote,
    sanitizeEditorContext,
    renderEditorContextNote,
};
