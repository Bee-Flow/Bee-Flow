import { isCustomTypeId } from './ownData/ownDataModel';
import { deepEqual } from '../../../../../utils/deepEqual';

/**
 * Which stages of the pipeline hold unsaved edits.
 *
 * One Save writes one document, but the controls behind it live on three
 * different panes — so "Unsaved changes" alone told an admin who had touched
 * two panes nothing about where their pending work was. And because in-app
 * navigation cannot be intercepted (no router hook; `beforeunload` only covers
 * a refresh or a close), clicking away in the sidebar discarded it silently.
 * Naming the stages is what makes that recoverable.
 *
 * Pure, and keyed on the PAYLOAD rather than on the form state, so it can
 * never disagree with the dirty flag or with what a save would actually send.
 */

/**
 * Payload key → the stage whose pane owns that control.
 *
 * `toolPiiPolicy` belongs to DETECTION, not to outbound: the categories a tool
 * may carry now live in the same matrix as "do we even look for this", which
 * is the whole point of merging the three grids.
 *
 * A key that is not listed here belongs to no pane — `piiFailureMode`,
 * `dlpScope`, `attachmentLargeInputPolicy` and friends are carried through a
 * save untouched and are not editable on this screen. Those must never mark a
 * stage dirty: if one of them differs, the difference did not come from a
 * control the admin can see, and pointing at a pane would be a lie.
 */
export const FIELD_STAGE = {
    enabled: 'overview',

    piiDetectionCategories: 'detection',
    piiDetectionConfidenceThreshold: 'detection',
    toolPiiPolicy: 'detection',

    piiDetectionAction: 'processing',
    showRawPayload: 'processing',
    privacy_scan_knowledge_bases: 'processing',
    applyToAutomations: 'processing',

    dlpEnabled: 'outbound',
    dlpMode: 'outbound',
    dlpAlwaysReview: 'outbound',
    webSearchGuardEnabled: 'outbound',
    disableSearchOnUpload: 'outbound',
    monitorIntegrations: 'outbound',
    euModeEnabled: 'outbound',

    // "Your own data". The legacy terms key belongs here too: it is the
    // server's mirror of the org's own words and patterns.
    customDataTypes: 'owndata',
    customDataTests: 'owndata',
    customSensitiveTerms: 'owndata',
    // "Never hidden" sits beside the org's own types: both are "what this
    // organisation decides about its own words", and the round-3 layout puts
    // the editor there.
    piiAllowTerms: 'owndata',
    piiAllowPublicOrgs: 'owndata',
};

/** Pipeline order, so the chips read left to right the way the strip does. */
export const STAGE_ORDER = ['overview', 'detection', 'owndata', 'processing', 'outbound'];

/**
 * The two category-list fields carry BOTH panes' switches: the built-in kinds
 * (the matrix on What we look for) and the org's own types (`cdt_…` ids, the
 * switches on Your own data). A change is attributed to the pane whose ids
 * changed, so flipping "Hide from AI" on a custom type does not send the
 * admin to a matrix that has no row for it.
 */
const SPLIT_FIELDS = {
    piiDetectionCategories: (v) => [v],
    toolPiiPolicy: (v) => [v?.external?.blockCategories, v?.internal?.blockCategories],
};

const part = (lists, custom) => (lists || []).map(list => (Array.isArray(list)
    ? list.filter(id => isCustomTypeId(id) === custom)
    : list));

function splitStages(field, current, snapshot) {
    const pick = SPLIT_FIELDS[field];
    const now = pick(current);
    const before = pick(snapshot);
    const out = [];
    if (!deepEqual(part(now, false), part(before, false))) out.push(FIELD_STAGE[field]);
    if (!deepEqual(part(now, true), part(before, true))) out.push('owndata');
    // A shape change that is neither (a list became a non-list) still counts
    // against the field's own pane rather than vanishing.
    if (out.length === 0) out.push(FIELD_STAGE[field]);
    return out;
}

/**
 * @param {object|null} current   the payload as it stands
 * @param {object|null} snapshot  the payload at load / last successful save
 * @returns {Array<{id: string, count: number}>} stages with edits, in pipeline
 *   order, each with how many of its fields changed
 */
export function dirtyStages(current, snapshot) {
    if (!current || !snapshot) return [];

    const counts = new Map();
    for (const [field, stage] of Object.entries(FIELD_STAGE)) {
        if (deepEqual(current[field], snapshot[field])) continue;
        const stages = SPLIT_FIELDS[field] ? splitStages(field, current[field], snapshot[field]) : [stage];
        for (const s of stages) counts.set(s, (counts.get(s) || 0) + 1);
    }

    // `overview` first: the master switch outranks everything.
    return STAGE_ORDER
        .filter(id => counts.has(id))
        .map(id => ({ id, count: counts.get(id) }));
}

export default dirtyStages;
