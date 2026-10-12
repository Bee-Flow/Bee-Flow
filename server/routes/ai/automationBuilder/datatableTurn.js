/**
 * The datatable side of one builder chat turn: how the turn is set up so the
 * assistant can stage a new table in a preview (or create it in a direct
 * build) and may only bind an existing table the user chose, and the payload a
 * proposal carries to the client. Kept out of chatStream.js, which only calls
 * into it at fixed points.
 *
 * All flags live on the draft wrap, where the builder tools read them:
 *   _stageDatatables        a preview: builder_create_datatable stages
 *   _datatableCreate        the access check made at turn start (stage time)
 *   _pendingDatatables      the tables staged in the proposal so far
 *   _approvedDatatableIds   the Set the consent gate reads (null = no gate)
 *   _createdDatatableIds    tables made in this turn (remembered across turns)
 *   _planDatatables         the tables an approved plan lists (null = no plan)
 *   _req                    the request, for the training rule
 */

'use strict';

const { checkDatatableCreate } = require('../../../automation/builderTools/datatableCreateAccess');
const { pendingCatalogEntry, usedDatatables } = require('../../../automation/builderTools/pendingDatatables');
const { buildApprovedSet, resolveTableChoice } = require('../../../automation/builderTools/datatableApproval');

/**
 * @returns {Promise<{approvedIds:string[], createFor:string[], tables:object[]}|null>}
 *   what the user answered on a table question card, or null
 */
async function setupDatatableTurn({
    draftWrap, catalog, req, userId, snapshot, savedProposal, baseDraft, approvedPlan, history = [], message, isolated, permissionMode,
}) {
    const inWorkMode = !!req.body.workMode;
    draftWrap._req = req;
    draftWrap._stageDatatables = isolated && permissionMode === 'approve';
    // Refuse a table the user may not create at stage time, instead of letting
    // them review a proposal that Apply would refuse. An unreadable answer
    // ({ok:null}) stays permissive: Apply checks again.
    draftWrap._datatableCreate = draftWrap._stageDatatables
        ? await checkDatatableCreate({ userId, req, automationOrgId: draftWrap.orgId || null }).catch(() => ({ ok: null }))
        : null;
    draftWrap._pendingDatatables = draftWrap._stageDatatables && Array.isArray(savedProposal?.pendingDatatables)
        ? structuredClone(savedProposal.pendingDatatables) : [];
    if (draftWrap._pendingDatatables.length && Array.isArray(draftWrap._datatables)) {
        draftWrap._datatables = [...draftWrap._datatables, ...draftWrap._pendingDatatables.map(pendingCatalogEntry)];
    }
    const answered = inWorkMode && Array.isArray(snapshot?.reviewQuestions) && snapshot.reviewQuestions.some((q) => q && q.choice)
        ? resolveTableChoice({ questions: snapshot.reviewQuestions, message, catalog: draftWrap._datatables || [] })
        : null;
    const userTexts = [
        ...(Array.isArray(history) ? history : []).filter((m) => m && m.role === 'user' && typeof m.content === 'string').map((m) => m.content),
        ...(typeof message === 'string' ? [message] : []),
    ];
    draftWrap._approvedDatatableIds = inWorkMode
        ? buildApprovedSet({
            catalog: draftWrap._datatables,
            defs: [baseDraft, savedProposal?.definition],
            userTexts, carried: snapshot?.approvedDatatableIds, choice: answered,
            planUse: (approvedPlan?.useDatatables || []).map((t) => t && t.id),
        })
        : null;
    draftWrap._createdDatatableIds = [];
    draftWrap._planDatatables = approvedPlan ? (approvedPlan.datatables || []) : undefined;
    catalog.datatableRequireChoice = inWorkMode;
    return answered;
}

/** What a proposal preview carries: the definition, its base, and the tables it creates and uses. */
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
 */
function clientSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    const out = { ...snapshot };
    if (Array.isArray(out.reviewQuestions)) out.reviewQuestions = out.reviewQuestions.map(({ choice, ...q }) => q);
    if (out.proposal) out.proposal = clientProposal(out.proposal);
    return out;
}

function clientProposal(proposal) {
    if (!proposal || typeof proposal !== 'object' || !('applying' in proposal)) return proposal;
    const { applying, ...rest } = proposal;
    return rest;
}

module.exports = { setupDatatableTurn, proposalPreviewPayload, clientSnapshot, clientProposal };
