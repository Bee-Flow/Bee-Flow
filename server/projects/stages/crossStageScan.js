/**
 * Does a stage's payload point into Dev or into the sibling stage (design 3.1)?
 *
 * Stage tables live in the organisation's scope, so an org picker lists PRD
 * tables in Dev and a UAT automation could be handed a PRD table id. Nothing in
 * the schema stops that; three checks do, and this module is the shared core
 * of two of them:
 *
 *   - the cross-stage scan over the BOUND target payloads before a deploy
 *     (plan and prepare): every pointer the registry knows
 *     (pointers.visitPointers) plus a raw-id sweep (idSweep) for the ids
 *     nobody registered (a code step, a page script). Any id owned by Dev or by
 *     the sibling stage is a blocking `stage.cross_reference`;
 *   - the binding validator (applyBindings.validateBinding), which refuses a
 *     table, KB or document that another stage or Dev owns.
 *
 * "Owned" means filed in that project: `project_id` of an automation, app, page,
 * table, agent or skill, `solution_project_id` of a template, and the
 * project's `knowledge_base_ids` for a knowledge base.
 *
 * Findings name the part (ref), the field or path and the owning stage, never
 * the id itself.
 */

'use strict';

const { visitPointers, HOLDER_KINDS } = require('../packaging/pointers');
const { sweepRawIds } = require('../packaging/idSweep');
const { KIND_OF_SECTION } = require('./stagePayload');

/** Where each part kind records the project it is filed in. */
const PART_TABLES = Object.freeze([
    ['automations', 'project_id'], ['studio_apps', 'project_id'], ['webpages', 'project_id'],
    ['datatables', 'project_id'], ['agents', 'project_id'], ['skills', 'project_id'],
    ['studio_documents', 'solution_project_id'],
]);

// A part table this installation does not have (yet), or an older one without
// the column: those parts cannot be filed anywhere, so there is nothing to find.
const ABSENT = new Set(['42P01', '42703']);

const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());
const rowsOf = (res) => (Array.isArray(res) ? res : (res && res.rows) || []);
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function defaultDb() {
    const db = require('../../db');
    return { query: (sql, params) => db.run(sql, params) };
}

function parseIds(raw) {
    let v = raw;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = []; } }
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];
}

/**
 * Every part id filed in each of `projectIds`: Map projectId → Set(id).
 * `deps.db` is `{ query }` (the pool by default).
 */
async function memberIdsByProject(projectIds, deps = {}) {
    const ids = [...new Set((projectIds || []).filter(x => typeof x === 'string' && x))];
    const out = new Map(ids.map(id => [id, new Set()]));
    if (!ids.length) return out;
    const q = dep(deps, 'db', defaultDb);
    const add = (projectId, id) => { if (out.has(projectId) && id) out.get(projectId).add(String(id)); };
    for (const [table, column] of PART_TABLES) {
        try {
            const res = await q.query(`SELECT id::text AS id, ${column} AS project_id FROM ${table} WHERE ${column} = ANY($1::text[])`, [ids]);
            for (const r of rowsOf(res)) add(r.project_id, r.id);
        } catch (err) {
            if (!ABSENT.has(err && err.code)) throw err;
        }
    }
    const res = await q.query('SELECT id, knowledge_base_ids FROM projects WHERE id = ANY($1::text[])', [ids]);
    for (const r of rowsOf(res)) for (const kb of parseIds(r.knowledge_base_ids)) add(r.id, kb);
    return out;
}

/**
 * The projects of a Solution other than `exceptProjectId`: Dev (the Solution
 * itself) and its stages, as `[{ projectId, stage: 'dev'|'uat'|'prd' }]`.
 */
async function otherStagesOf(solutionId, exceptProjectId, deps = {}) {
    const store = dep(deps, 'solutionStageStore', () => require('../../stores/solutionStageStore'));
    const stages = await store.listStages(solutionId);
    return [{ projectId: solutionId, stage: 'dev' }, ...(stages || []).map(s => ({ projectId: s.projectId, stage: s.stage }))]
        .filter(p => p.projectId && p.projectId !== exceptProjectId);
}

/**
 * Map id → { projectId, stage } for every part filed in Dev or in a stage of
 * `solutionId` other than `exceptProjectId`. `deps.ownersOf(projects)` replaces
 * the lookup whole (tests).
 */
async function foreignOwners({ solutionId, exceptProjectId = null }, deps = {}) {
    const projects = await otherStagesOf(solutionId, exceptProjectId, deps);
    if (deps && typeof deps.ownersOf === 'function') return deps.ownersOf(projects);
    const byProject = await memberIdsByProject(projects.map(p => p.projectId), deps);
    const out = new Map();
    for (const p of projects) for (const id of byProject.get(p.projectId) || []) out.set(id, p);
    return out;
}

const holderOf = (kind) => {
    const k = KIND_OF_SECTION[kind] || kind;
    return k === 'block' ? 'automation' : k;
};

/**
 * The pointer and raw-id hits of `payloads` against `owners` (Map id → owner).
 * Pure.
 *
 * @param {Array<{ ref?: string|null, kind: string, payload: object }>} payloads
 * @param {Map<string, {projectId: string, stage: string}>} owners
 * @param {string} [code]
 */
function scanAgainst(payloads, owners, code = 'stage.cross_reference') {
    const findings = [];
    if (!owners || !owners.size) return findings;
    const seen = new Set();
    const push = (ref, id, where) => {
        const key = `${ref}\u0000${id}`;
        if (seen.has(key)) return;
        seen.add(key);
        findings.push({ code, severity: 'blocking', ref: ref || null, ownerStage: owners.get(id).stage, ...where });
    };
    for (const p of payloads || []) {
        if (!p || !isObject(p.payload)) continue;
        const ref = p.ref || p.payload.ref || null;
        const holder = holderOf(p.kind);
        if (HOLDER_KINDS.includes(holder)) {
            visitPointers(holder, p.payload, (ptr) => {
                const value = ptr.get();
                const values = ptr.many ? (Array.isArray(value) ? value : []) : [value];
                for (const v of values) {
                    if (typeof v !== 'string' || !owners.has(v)) continue;
                    push(ref, v, {
                        field: ptr.field, targetKind: ptr.targetKind,
                        ...(ptr.stepId ? { stepId: ptr.stepId } : {}), ...(ptr.actionId ? { actionId: ptr.actionId } : {}),
                    });
                }
            });
        }
        for (const hit of sweepRawIds([{ ...p.payload, ref }], [...owners.keys()])) push(ref, hit.id, { path: hit.path });
    }
    return findings;
}

/**
 * The cross-stage scan of one stage's bound payloads.
 *
 * @param {{ solutionId: string, stageProjectId: string,
 *   payloads: Array<{ ref?: string|null, kind: string, payload: object }> }} input
 * @param {object} [deps]  `{ solutionStageStore, db, ownersOf }`
 * @returns {Promise<object[]>} blocking `stage.cross_reference` findings
 */
async function scanStagePayloads({ solutionId, stageProjectId, payloads = [] }, deps = {}) {
    const owners = await foreignOwners({ solutionId, exceptProjectId: stageProjectId }, deps);
    return scanAgainst(payloads, owners);
}

module.exports = {
    PART_TABLES,
    memberIdsByProject, otherStagesOf, foreignOwners, scanAgainst, scanStagePayloads,
};
