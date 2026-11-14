/**
 * The passes of builder_update_step (./updateStep.js), one decision each, in
 * the order the patch goes through them: position and wiring, the add path's
 * foreign vocabulary, the allow-list, the tool and fill-only gates, the
 * structured fields, the text and list checks, the scalar pass, the cross-field
 * checks and derived fields, and the write. A pass answers a result object to
 * stop the update with it (a refusal, or the finished answer of a pure move),
 * or null to go on; it reads and advances the one UpdateState.
 *
 * The write pass stores the step BEFORE it checks the agent block, so a refusal
 * there leaves the patched step in the draft: applyUpdateSteps rolls the batch
 * back, and a single update answers with the refusal.
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const nodeRequire = createRequire(import.meta.url);

// The builder modules are untyped CommonJS; each import names the functions read from it.
type Rec = Record<string, any>;
type Fn = (...args: any[]) => any;
type Answer = Rec | null | undefined | false;

const { isSideEffect } = nodeRequire('../../sideEffectMap') as Record<'isSideEffect', Fn>;
const { findStepAnywhere } = nodeRequire('../draftGraph') as Record<'findStepAnywhere', Fn>;
const { sanitizeForEach, checkTextPlaceholders, checkLoopBindings, sanitizeArrayRef } =
    nodeRequire('../bindings') as Record<'sanitizeForEach' | 'checkTextPlaceholders' | 'checkLoopBindings' | 'sanitizeArrayRef', Fn>;
const { sanitizeParseJsonFieldRows, sanitizeSetOperations } =
    nodeRequire('../stepBuilders/dataSteps') as Record<'sanitizeParseJsonFieldRows' | 'sanitizeSetOperations', Fn>;
const { sanitizeDatatableCursor } = nodeRequire('../stepBuilders/datatableStep') as Record<'sanitizeDatatableCursor', Fn>;
const { translateDataExtractionVocabulary } = nodeRequire('../stepBuilders/dataExtractionStep') as Record<'translateDataExtractionVocabulary', Fn>;
const { unknownToolError } = nodeRequire('../stepBuilders/toolResolution') as Record<'unknownToolError', Fn>;
// Filled by the stepEditing.js barrel; read at call time, never destructured.
const cycleDeps = nodeRequire('./cycleDeps') as Record<'inspectGateError' | 'modelTierGateError' | 'agentPermissionsBlock' | 'documentDiscovery', Fn>;
const { patchFlatten } = nodeRequire('../stepBuilders/flattenStep') as Record<'patchFlatten', Fn>;
const { normalizeQuery: normalizeHttpQuery } = nodeRequire('../../../core/automationRunner/httpQuery') as Record<'normalizeQuery', Fn>;
const { followAddedSteps, followPatchedRoute } = nodeRequire('../routeFollowDraft') as Record<'followAddedSteps' | 'followPatchedRoute', Fn>;
const { FLATTEN_PLANNED_KEYS, TEXT_TEMPLATE_FIELDS, PATCHABLE_FIELDS, ROUTE_SHAPE_KEYS } = nodeRequire('./patchFields') as {
    FLATTEN_PLANNED_KEYS: string[]; TEXT_TEMPLATE_FIELDS: Record<string, string[]>; PATCHABLE_FIELDS: Record<string, string[]>; ROUTE_SHAPE_KEYS: string[];
};
const { normalizePatchField } = nodeRequire('./normalizePatchField') as Record<'normalizePatchField', Fn>;
const { applyPositionPatch } = nodeRequire('./patchGuards/position') as Record<'applyPositionPatch', Fn>;
const { translateDatatablePatch, linkDatatablePatch, patchDatatableBody } =
    nodeRequire('./patchGuards/datatable') as Record<'translateDatatablePatch' | 'linkDatatablePatch' | 'patchDatatableBody', Fn>;
const { fillOnlyRefusal } = nodeRequire('./patchGuards/fillOnly') as Record<'fillOnlyRefusal', Fn>;
const { patchDataExtraction } = nodeRequire('./patchGuards/dataExtraction') as Record<'patchDataExtraction', Fn>;
const { patchBindingMap } = nodeRequire('./patchGuards/bindings') as Record<'patchBindingMap', Fn>;
const { patchTableStep } = nodeRequire('./patchGuards/tables') as Record<'patchTableStep', Fn>;

/** Everything one builder_update_step call knows, advanced pass by pass. */
export type UpdateState = {
    graph: Rec;
    args: Rec;
    draftWrap: Rec | undefined;
    stepId: string;
    /** The step's slot (findStepAnywhere); a move replaces it. */
    found: Rec;
    /** The step as it was before the patch (after a move, its new slot's object). */
    step: Rec;
    /** The model's patch, never mutated: a pass that changes it makes a new object. */
    patch: Rec;
    patchNotes: string[];
    moved: string[];
    allowed: string[];
    filledTable: unknown;
    /** The patched step being built; written to the slot by the write pass. */
    next: Rec;
    /** The forEach the step has once the patch lands. */
    feAfter: unknown;
    /** Checked values of text and list fields; the scalar pass prefers them over the patch's own. */
    checked: Rec;
};

type UpdateStart = Pick<UpdateState, 'graph' | 'args' | 'draftWrap' | 'stepId' | 'found' | 'patch'>;

export function newUpdateState({ graph, args, draftWrap, stepId, found, patch }: UpdateStart): UpdateState {
    return {
        graph, args, draftWrap, stepId, found, step: found.step, patch,
        patchNotes: [], moved: [], allowed: [], filledTable: undefined, next: {}, feAfter: undefined, checked: {},
    };
}

const FILL_DOCUMENT_BINDING_KEYS = ['documentId', 'documentVersionId', 'values', 'sectionOverrides'];

/**
 * A fill_document patch that touches the document or its bindings is checked
 * against the document the model read, and carries the version it pins.
 */
export function fillDocumentPatch(step: Rec, patch: Rec, draftWrap: Rec | undefined): { issue?: Rec; patch: Rec } {
    if (step.type !== 'fill_document' || !FILL_DOCUMENT_BINDING_KEYS.some((k) => k in patch)) return { patch };
    const candidate = { ...step, ...patch };
    const issue = cycleDeps.documentDiscovery().inspectBindings(candidate, draftWrap, 'builder');
    if (issue) return { issue, patch };
    return { patch: { ...patch, documentVersionId: candidate.documentVersionId } };
}

/** Position and branch wiring: see patchGuards/position.js. A pure move ends here. */
function positionPass(u: UpdateState): Answer {
    const position = applyPositionPatch(u.graph, u.stepId, u.step, u.patch);
    if (position.error) return { error: position.error };
    if (position.result) return position.result;
    u.moved = position.moved;
    u.patch = position.patch;
    if (position.found) {
        // The move re-ordered the steps array, so the slot found before is stale.
        u.found = position.found;
        u.step = u.found.step;
    }
    return null;
}

/**
 * The add path's vocabulary on a data_extraction ({inputs:{source}},
 * {prompt}, {outputSchema}) and a datatable ({fields}, {row}, {tableId},
 * {op:"append"}) patch is translated BEFORE the allow-list, so the check sees
 * the step's own field names instead of sending the model to remove and re-add
 * the step (a new id).
 */
function vocabularyPass(u: UpdateState): Answer {
    if (u.step.type === 'data_extraction') {
        const tr = translateDataExtractionVocabulary(u.patch);
        u.patch = tr.args;
        u.patchNotes.push(...tr.notes);
    }
    const translated = translateDatatablePatch(u.step, u.patch, u.patchNotes);
    if (translated.refusal) return translated.refusal;
    u.patch = translated.patch;
    return null;
}

function allowListPass(u: UpdateState): Answer {
    const { step, patch, stepId } = u;
    const allowed = PATCHABLE_FIELDS[step.type];
    if (!allowed) return { error: `Step type "${step.type}" cannot be patched.` };
    u.allowed = allowed;
    const bad = Object.keys(patch).filter((k) => !allowed.includes(k));
    if (!bad.length) return null;
    // A loop's body is the one refusal that could be a dead end: no tool
    // appends into an existing body, `scope` only resolves flowlet keys, so a
    // message naming neither escape makes the model remove and re-add the loop,
    // which mints a new id and breaks every downstream ref. Name the way out.
    if (step.type === 'loop' && (bad.includes('body') || bad.includes('steps'))) {
        return { error: `A loop's body is not patched field-by-field. Re-send the whole body with builder_replace_step({stepId:"${stepId}", newType:"loop", spec:{overRef, itemVar, maxIterations, body:[…]}}) — that KEEPS the loop's id and all its wiring, so downstream refs survive. Body steps are FLAT step objects; to change ONE of them, patch it by its own id. Patchable on the loop itself: ${allowed.join(', ')}.` };
    }
    return { error: `Field(s) ${bad.join(', ')} not patchable on a ${step.type} step. Allowed: ${allowed.join(', ')}.` };
}

/**
 * Re-pointing an integration_action at a new tool re-arms inspect, after the
 * availability guard (a patch must not bring in a tool the user cannot run);
 * an ai_step modelTier stays within the user's tier set.
 */
function toolGatesPass(u: UpdateState): Answer {
    const { step, patch, draftWrap } = u;
    if (step.type === 'integration_action' && 'tool' in patch) {
        const unknown = unknownToolError(patch.tool, draftWrap);
        if (unknown) return unknown;
        const mergedInputs = ('inputs' in patch) ? { ...(step.inputs || {}), ...(patch.inputs || {}) } : (step.inputs || {});
        const gate = cycleDeps.inspectGateError(patch.tool, mergedInputs, draftWrap);
        if (gate) return gate;
    }
    if (step.type === 'ai_step' && 'modelTier' in patch) {
        const tierErr = cycleDeps.modelTierGateError(patch.modelTier, draftWrap);
        if (tierErr) return tierErr;
    }
    return null;
}

/** The fill-only links (table, agent, knowledge base); after them the patched copy starts. */
function fillOnlyPass(u: UpdateState): Answer {
    const link = linkDatatablePatch(u.stepId, u.step, u.patch, u.draftWrap, u.patchNotes);
    if (link.refusal) return link.refusal;
    u.filledTable = link.filledTable;
    const fillOnly = fillOnlyRefusal(u.stepId, u.step, u.found, u.patch);
    if (fillOnly) return fillOnly;
    u.next = { ...u.step };
    return null;
}

/**
 * parse_json.fields is an ARRAY of {name, path, ...} rows, not a binding map,
 * so the binding pass would drop it: replaced wholesale through the add tool's
 * sanitiser.
 */
function parseJsonFieldsPass(u: UpdateState): Answer {
    if (u.step.type !== 'parse_json' || !('fields' in u.patch)) return null;
    const { fields, error } = sanitizeParseJsonFieldRows(u.patch.fields);
    if (error) return { error };
    u.next.fields = fields;
    return null;
}

const dataExtractionPass = (u: UpdateState): Answer => patchDataExtraction(u.graph, u.step, u.patch, u.next, u.draftWrap, u.patchNotes);
const tableStepPass = (u: UpdateState): Answer => patchTableStep(u.graph, u.step, u.patch, u.next, u.draftWrap, u.patchNotes);

/** set.operations is an ARRAY too: replaced wholesale; null or an empty list clears it. */
function setOperationsPass(u: UpdateState): Answer {
    if (u.step.type !== 'set' || !('operations' in u.patch)) return null;
    const { operations, error } = u.patch.operations === null ? { operations: [], error: null } : sanitizeSetOperations(u.patch.operations);
    if (error) return { error };
    if (operations.length) u.next.operations = operations; else delete u.next.operations;
    return null;
}

const datatableBodyPass = (u: UpdateState): Answer => patchDatatableBody(u.graph, u.step, u.patch, u.next, {
    filledTable: u.filledTable, draftWrap: u.draftWrap, inputsMode: u.args.inputsMode, patchNotes: u.patchNotes,
});

/**
 * inputs / fields merge by key (null deletes) unless inputsMode:'replace'
 * (patchGuards/bindings.js). loop.<var> paths are checked against the forEach
 * the step has once the patch lands; an invalid one is refused by the forEach
 * pass after this one.
 */
function bindingMapPass(u: UpdateState): Answer {
    const { graph, step, patch, draftWrap } = u;
    if ('forEach' in patch) u.feAfter = patch.forEach === null ? undefined : sanitizeForEach(patch.forEach, graph, draftWrap).forEach;
    else u.feAfter = step.forEach;
    return patchBindingMap(graph, step, patch, u.next, { feAfter: u.feAfter, draftWrap, inputsMode: u.args.inputsMode, patchNotes: u.patchNotes });
}

/** forEach is re-validated; null clears it. */
function forEachPass(u: UpdateState): Answer {
    if (!('forEach' in u.patch)) return null;
    const { forEach, error, notes } = u.patch.forEach === null ? {} : sanitizeForEach(u.patch.forEach, u.graph, u.draftWrap);
    if (error) return { error };
    if (forEach) u.next.forEach = forEach; else delete u.next.forEach;
    u.patchNotes.push(...(notes || []));
    return null;
}

/** Text fields the run interpolates get the add tools' path checks (bindings.js). */
function textFieldsPass(u: UpdateState): Answer {
    const { step, patch, graph, draftWrap } = u;
    for (const key of TEXT_TEMPLATE_FIELDS[step.type] || []) {
        if (!(key in patch) || typeof patch[key] !== 'string') continue;
        const t = checkTextPlaceholders(patch[key], graph, { draftWrap, label: key });
        if (t.error) return { error: t.error };
        const loop = checkLoopBindings(t.text, graph, u.feAfter, draftWrap, { label: key });
        if (loop.error) return { error: loop.error };
        u.checked[key] = loop.value;
        u.patchNotes.push(...t.notes, ...loop.notes);
    }
    return null;
}

/**
 * An http_request's url (already checked) and query: a query left in the URL
 * moves into `query`, and the query's own {{…}} paths are checked.
 */
function httpQueryPass(u: UpdateState): Answer {
    const { step, graph, draftWrap, checked } = u;
    if (step.type !== 'http_request' || !('query' in u.patch || ('url' in u.patch && typeof u.patch.url === 'string'))) return null;
    // Required at call time, so loading this module does not load outboundSteps.
    const { checkQueryPlaceholders, liftUrlQuery } = nodeRequire('../stepBuilders/outboundSteps') as Record<'checkQueryPlaceholders' | 'liftUrlQuery', Fn>;
    const urlNow = 'url' in checked ? checked.url : (typeof u.patch.url === 'string' ? u.patch.url : step.url);
    const queryNow = 'query' in u.patch ? normalizeHttpQuery(u.patch.query) : step.query;
    const lifted = liftUrlQuery(urlNow, queryNow);
    const qc = checkQueryPlaceholders(lifted.query, graph, draftWrap, u.feAfter);
    if (qc.error) return { error: qc.error };
    if ('url' in u.patch || lifted.url !== urlNow) checked.url = lifted.url;
    checked.query = qc.query;
    if (lifted.url !== urlNow && !('url' in u.patch)) u.patch = { ...u.patch, url: lifted.url };
    if (!('query' in u.patch) && qc.query) u.patch = { ...u.patch, query: qc.query };
    u.patchNotes.push(...lifted.notes, ...qc.notes);
    return null;
}

/** The list a step works through (a loop's overRef, anyone else's arrayRef). */
function listRefPass(u: UpdateState): Answer {
    const { step, patch } = u;
    const listKey = step.type === 'loop' ? 'overRef' : 'arrayRef';
    if (!(listKey in patch) || typeof patch[listKey] !== 'string' || !patch[listKey].trim()) return null;
    const ar = sanitizeArrayRef(patch[listKey], u.graph, { draftWrap: u.draftWrap, strictRoot: step.type === 'set' });
    if (ar.error) return { error: ar.error.replace(/^arrayRef/, listKey) };
    u.checked[listKey] = ar.arrayRef;
    u.patchNotes.push(...ar.notes.map((n: string) => n.replace(/^arrayRef/, listKey)));
    return null;
}

function datatableCursorPass(u: UpdateState): Answer {
    if (u.step.type !== 'datatable' || !('cursor' in u.patch)) return null;
    const c = sanitizeDatatableCursor(u.patch.cursor, u.graph, u.draftWrap);
    if (c.error) return { error: c.error };
    u.checked.cursor = c.cursor;
    u.patchNotes.push(...c.notes);
    return null;
}

/** Fields a pass above already wrote, per step type; the scalar pass leaves them. */
const STRUCTURED_FIELDS: Record<string, string[]> = {
    set: ['operations'],
    datatable: ['values', 'where'],
    data_extraction: ['source'],
    flatten: FLATTEN_PLANNED_KEYS,
    read_table: ['source', 'ops'],
    table: ['source', 'ops'],
};
const MAP_FIELDS = ['inputs', 'fields', 'forEach'];

function writtenAbove(type: string, key: string): boolean {
    if (MAP_FIELDS.includes(key)) return true;
    return Object.hasOwn(STRUCTURED_FIELDS, type) && STRUCTURED_FIELDS[type].includes(key);
}

/** Scalar and structured fields: the checked value when there is one, the patch's otherwise. */
function scalarPass(u: UpdateState): Answer {
    const { step, patch, checked, next } = u;
    for (const k of u.allowed) {
        if (writtenAbove(step.type, k) || !(k in patch)) continue;
        const norm = normalizePatchField(step.type, k, k in checked ? checked[k] : patch[k]);
        if (norm === undefined) { if (k !== 'label') delete next[k]; } else next[k] = norm;
    }
    return null;
}

function flattenPass(u: UpdateState): Answer {
    if (u.step.type !== 'flatten') return null;
    const arrayRef = 'arrayRef' in u.checked ? { arrayRef: u.checked.arrayRef } : {};
    const err = patchFlatten(u.graph, u.next, { ...u.patch, ...arrayRef }, u.draftWrap);
    return err ? { error: err } : null;
}

/**
 * set cross-field integrity once the patch lands. The validator catches these
 * on save too; refusing here answers on the very turn the model made the mistake.
 */
function setIntegrityPass(u: UpdateState): Answer {
    const { next } = u;
    if (u.step.type !== 'set') return null;
    const listMode = typeof next.arrayRef === 'string';
    if (listMode && next.forEach) return { error: 'arrayRef (list mode) and forEach cannot be combined — list mode already applies the fields to every row. Clear forEach (forEach: null) or the arrayRef.' };
    if (!listMode && Array.isArray(next.operations) && next.operations.length) {
        return { error: 'operations need arrayRef — set arrayRef to an upstream list, or clear the operations (operations: null).' };
    }
    if (!listMode) delete next.maxItems;
    return null;
}

/** Fields the add path's builders compute. */
function derivedFieldsPass(u: UpdateState): Answer {
    const { step, patch, next } = u;
    if (step.type === 'code' && 'code' in patch) {
        next.codeHash = createHash('sha256').update(next.code || '').digest('hex');
    }
    if (step.type === 'integration_action' && 'tool' in patch) {
        next.sideEffect = isSideEffect(next.tool);
        if (!('label' in patch) && (step.label === step.tool)) next.label = next.tool; // keep auto-label tracking the tool
    }
    return null;
}

/**
 * Writes the step into its slot, then gives an ai_step the agent block the add
 * path writes: agentPermissions rebuilt from its three names, and both it and
 * disabledAgentSkillIds only on a step with an agent (patching agentId to null
 * takes them along).
 */
function writePass(u: UpdateState): Answer {
    const { next } = u;
    u.found.container[u.found.index] = next;
    if (next.type !== 'ai_step') return null;
    const hasSkills = Array.isArray(next.skillIds) && next.skillIds.length > 0;
    const block = cycleDeps.agentPermissionsBlock(next.agentPermissions, next.agentId, { hasSkills });
    if (block.error) return block;
    if (block.permissions === undefined) delete next.agentPermissions;
    else next.agentPermissions = block.permissions;
    if (!next.agentId || !Array.isArray(next.disabledAgentSkillIds) || next.disabledAgentSkillIds.length === 0) {
        delete next.disabledAgentSkillIds;
    }
    return null;
}

/** The passes in the order the patch goes through them. */
export const UPDATE_PASSES: ReadonlyArray<(u: UpdateState) => Answer> = [
    positionPass, vocabularyPass, allowListPass, toolGatesPass, fillOnlyPass,
    parseJsonFieldsPass, dataExtractionPass, tableStepPass, setOperationsPass, datatableBodyPass,
    bindingMapPass, forEachPass,
    textFieldsPass, httpQueryPass, listRefPass, datatableCursorPass,
    scalarPass, flattenPass, setIntegrityPass, derivedFieldsPass, writePass,
];

/**
 * The answer once every pass went through. The route follows (W8): a moved
 * step reads the output it now hangs off, a Condition whose outputs or list
 * changed takes its readers along.
 */
export function finishUpdate(u: UpdateState): Rec {
    const { found, graph, stepId, moved, patchNotes } = u;
    if (found.kind === 'graph') {
        if (moved.length) patchNotes.push(...followAddedSteps(graph, [stepId]));
        if (ROUTE_SHAPE_KEYS.some((k) => k in u.patch)) patchNotes.push(...followPatchedRoute(graph, u.step, stepId));
    }
    const updated = found.kind === 'graph' ? findStepAnywhere(graph, stepId).step : u.next;
    return { updated, ...(moved.length ? { moved } : {}), ...(patchNotes.length ? { _warnings: patchNotes } : {}) };
}
