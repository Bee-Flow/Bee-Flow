/** @typedef {import('../../../routes/ai/automationBuilder/turnSetup').BuilderDraftWrap} BuilderDraftWrap */
/** @typedef {import('../../../automation/builderTools/draftGraph').DraftGraph} DraftGraph */
// @typecheck strict
/**
 * What a builder proposal and a session snapshot carry to the client.
 */

'use strict';

const { usedDatatables } = require('../../../automation/builderTools/pendingDatatables');

/**
 * What a proposal preview carries: the definition, its base, and the tables it creates and uses.
 * @param {BuilderDraftWrap} draftWrap
 * @param {DraftGraph} baseDraft
 */
function proposalPreviewPayload(draftWrap, baseDraft) {
    const pending = draftWrap._pendingDatatables || [];
    return {
        definition: draftWrap.def, baseDefinition: baseDraft, title: draftWrap.title, description: draftWrap.description,
        ...(pending.length ? { pendingDatatables: pending } : {}),
        usedDatatables: usedDatatables(baseDraft, draftWrap.def, draftWrap._datatables, pending),
    };
}

/**
 * The snapshot as the CLIENT may see it: the question `choice` (how the server
 * reads a table answer back) and the proposal's Apply claim stay server-side.
 * @template T
 * @param {T} snapshot
 * @returns {T}
 */
function clientSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    const out = /** @type {Record<string, any>} */ ({ ...snapshot });
    if (Array.isArray(out.reviewQuestions)) out.reviewQuestions = out.reviewQuestions.map((/** @type {Record<string, unknown>} */ { choice, ...q }) => q);
    if (out.proposal) out.proposal = clientProposal(out.proposal);
    return /** @type {T} */ (out);
}

/**
 * The proposal without its Apply claim.
 * @template T
 * @param {T} proposal
 * @returns {T}
 */
function clientProposal(proposal) {
    if (!proposal || typeof proposal !== 'object' || !('applying' in proposal)) return proposal;
    const { applying, ...rest } = /** @type {Record<string, unknown>} */ (proposal);
    return /** @type {T} */ (rest);
}

module.exports = { proposalPreviewPayload, clientSnapshot, clientProposal };
