/**
 * The stage-only release checks (design 6.1 items 2 and 7, 4.2, D18, D20).
 *
 * A pipeline release first passes the same completeness gate a gallery
 * publish passes (projects/packaging/publication.releaseGate). These are the
 * findings that only matter because the release is going to run in UAT and
 * PRD, next to Dev, in the same organisation. Every one of them is BLOCKING
 * (a cut with one answers 409 release_blocked) unless marked `warning`:
 *
 *   release.raw_id_reference      a real Dev member id survived capture (idSweep):
 *                                 the stage copy would quietly use the Dev part.
 *                                 A literal table token in page code is repairable
 *                                 and only a warning (release.table_token).
 *   release.cross_owner           a Dev edge that refuses at run time (graph)
 *   release.cross_stage_reference a Dev part already points at a UAT/PRD part
 *   variable.shadowed             an automation's own `definition.vars` key hides a
 *                                 declared variable (D10: never decided silently)
 *   variable.secret_name          a declared name looks like a secret
 *                                 (CONNECTOR_SECRET_KEY_RE): store it in a connection
 *   reference.written_at_runtime  an automation or page writes a reference table, whose
 *                                 rows a deploy overwrites (and stages lock)
 *   the capture's own pipeline findings (webpage.extra_files,
 *   agent.skill_not_in_solution, automation.skill_not_in_solution,
 *   webpage.agent_not_in_solution, app.data_model_unreadable) and the
 *   payload findings (reference.personal_data, reference.too_large,
 *   kb.personal_data, kb.synced_source, …), passed through as they are.
 *
 * Findings name refs, paths and names, never an id or a value.
 */

'use strict';

const { isRef } = require('../packaging/pointers');

const walkAllSteps = (definition, fn) => require('../../automation/portability').walkAllSteps(definition, fn);

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
const blocking = (code, extra = {}) => ({ code, severity: 'blocking', ...extra });

const MESSAGES = Object.freeze({
    'release.raw_id_reference': 'A part still names a Dev part by its id, so a stage would use the Dev part.',
    'release.table_token': 'Page code names a table by its id; a deploy rewrites it to the stage table.',
    'release.cross_owner': 'A part runs something owned by someone else; it refuses at run time.',
    'release.cross_stage_reference': 'A Dev part points at a part of UAT or Production.',
    'variable.shadowed': 'An automation defines its own variable with the name of a Solution variable.',
    'variable.secret_name': 'This variable name looks like a secret. Store secrets in a connection.',
    'reference.written_at_runtime': 'A reference table is written by an automation or a page; its rows are replaced on every deploy.',
});

function withMessage(f) {
    return MESSAGES[f.code] && !f.message ? { ...f, message: MESSAGES[f.code] } : f;
}

function entitiesOf(manifest, section) {
    const list = manifest?.solution?.entities?.[section];
    return Array.isArray(list) ? list.filter(isObject) : [];
}

function rawIdFindings(rawIds) {
    return (Array.isArray(rawIds) ? rawIds : []).map(hit => (hit && hit.substitutable
        ? { code: 'release.table_token', severity: 'warning', ref: hit.ref || null, path: hit.path }
        : blocking('release.raw_id_reference', { ref: hit?.ref || null, path: hit?.path || null })));
}

function crossOwnerFindings(manifest) {
    const problems = manifest?.solution?.report?.problems;
    return (Array.isArray(problems) ? problems : [])
        .filter(p => p && p.code === 'cross_owner')
        .map(p => blocking('release.cross_owner', { ref: p.ref || null, ...(p.stepId ? { stepId: p.stepId } : {}) }));
}

function variableFindings(manifest, variables) {
    const { CONNECTOR_SECRET_KEY_RE } = require('../../core/dataEngine/dataModel/vocabulary');
    const names = new Set();
    const out = [];
    for (const v of Array.isArray(variables) ? variables : []) {
        if (!v || typeof v.name !== 'string') continue;
        names.add(v.name);
        if (CONNECTOR_SECRET_KEY_RE.test(v.name)) out.push(blocking('variable.secret_name', { name: v.name }));
    }
    for (const a of entitiesOf(manifest, 'automations')) {
        const vars = isObject(a.definition) && isObject(a.definition.vars) ? a.definition.vars : {};
        for (const key of Object.keys(vars).sort()) {
            if (names.has(key)) out.push(blocking('variable.shadowed', { ref: a.ref || null, name: key }));
        }
    }
    return out;
}

/**
 * A reference table is written at run time: a datatable step that adds,
 * saves, updates or deletes rows, an http_request that caches answers into
 * it, or a page grant that may write it. A deploy replaces those rows, and a
 * stage refuses every row write on them (5.3).
 */
function referenceWriteFindings(manifest, referenceRefs) {
    const refs = referenceRefs instanceof Set ? referenceRefs : new Set(referenceRefs || []);
    if (!refs.size) return [];
    const { DATATABLE_WRITE_OPS } = require('../../automation/validate/constants');
    const out = [];
    const target = (v) => (isRef(v) && refs.has(v.$ref) ? v.$ref : null);
    for (const a of entitiesOf(manifest, 'automations')) {
        walkAllSteps(a.definition, (step, layerKey, isTrigger) => {
            if (isTrigger || !isObject(step)) return;
            const table = step.type === 'datatable' && DATATABLE_WRITE_OPS.has(step.op) ? target(step.datatableId)
                : (step.type === 'http_request' && isObject(step.cacheInto) ? target(step.cacheInto.datatableId) : null);
            if (table) out.push(blocking('reference.written_at_runtime', { ref: a.ref || null, stepId: step.id || null, tableRef: table }));
        });
    }
    for (const w of entitiesOf(manifest, 'webpages')) {
        for (const g of Array.isArray(w.bridgeGrants?.tables) ? w.bridgeGrants.tables : []) {
            const table = isObject(g) && g.mode === 'readwrite' ? target(g.datatableId) : null;
            if (table) out.push(blocking('reference.written_at_runtime', { ref: w.ref || null, tableRef: table }));
        }
    }
    return out;
}

/**
 * The checks that need no I/O. Pure.
 *
 * @param {{ manifest: object, rawIds?: object[], captureFindings?: object[], variables?: object[],
 *   referenceRefs?: Set<string>|string[], payloadFindings?: object[] }} input
 * @returns {object[]}
 */
function stageOnlyFindings({
    manifest, rawIds = [], captureFindings = [], variables = [], referenceRefs = [], payloadFindings = [],
} = /** @type {any} */ ({})) {
    return [
        ...(Array.isArray(captureFindings) ? captureFindings : []).map(f => ({ severity: 'blocking', ...f })),
        ...rawIdFindings(rawIds),
        ...crossOwnerFindings(manifest),
        ...variableFindings(manifest, variables),
        ...referenceWriteFindings(manifest, referenceRefs),
        ...(Array.isArray(payloadFindings) ? payloadFindings : []).map(f => ({ severity: 'blocking', ...f })),
    ].map(withMessage);
}

/**
 * A Dev part that already points at a part of a stage of this Solution: in
 * the entities themselves (pointers and the raw-id sweep) or as the Dev value
 * of a slot (`suggested`, the out-of-bundle table, KB or template a Dev step
 * picked from an org picker that lists stage parts too).
 */
async function crossStageFindings({ solutionId, manifest }, deps = {}) {
    if (!solutionId) return [];
    const { foreignOwners, scanAgainst } = require('./crossStageScan');
    const { KIND_OF_SECTION } = require('./stagePayload');
    const owners = await foreignOwners({ solutionId, exceptProjectId: solutionId }, deps);
    if (!owners.size) return [];
    const payloads = [];
    for (const [section, kind] of Object.entries(KIND_OF_SECTION)) {
        for (const e of entitiesOf(manifest, section)) payloads.push({ ref: e.ref || null, kind, payload: e });
    }
    const out = scanAgainst(payloads, owners, 'release.cross_stage_reference');
    for (const slot of Array.isArray(manifest?.solution?.slots) ? manifest.solution.slots : []) {
        const s = isObject(slot?.suggested) ? slot.suggested : {};
        const ids = [s.datatableId, s.documentId, ...(Array.isArray(s.kbIds) ? s.kbIds : [])].filter(x => typeof x === 'string');
        const hit = ids.find(id => owners.has(id));
        if (hit) out.push(blocking('release.cross_stage_reference', { ref: slot.ref || null, slot: slot.slot, ownerStage: owners.get(hit).stage }));
    }
    return out.map(withMessage);
}

/**
 * Every stage-only finding of a pipeline cut.
 *
 * @param {object} input  stageOnlyFindings' input plus `solutionId`
 * @param {object} [deps] crossStageScan's (`solutionStageStore`, `db`, `ownersOf`)
 * @returns {Promise<{ blocked: boolean, findings: object[] }>}
 */
async function releaseChecks(input = {}, deps = {}) {
    const findings = [
        ...stageOnlyFindings(input),
        ...(await crossStageFindings({ solutionId: input.solutionId, manifest: input.manifest }, deps)),
    ];
    return { blocked: findings.some(f => f.severity === 'blocking'), findings };
}

module.exports = { releaseChecks, stageOnlyFindings, crossStageFindings, referenceWriteFindings };
