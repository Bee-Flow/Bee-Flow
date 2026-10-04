/**
 * Cut a pipeline release of a Solution (design 6.1, D18, D20).
 *
 * A release is an immutable, numbered capture of Dev's WORKING copies,
 * stored as a `channel='pipeline'` project_releases row that no gallery ever
 * sees. The steps, in order:
 *
 *   1. Server gate: the Solution's completeness verdict (graphForProject +
 *      collectCompleteness, through publication.releaseGate). Blocked → 409
 *      release_blocked, and nothing is captured.
 *   2. Ledger: every Dev part, and every distinct Dev connection an
 *      http_request step uses, gets its stable ref in ONE allocateRefs call
 *      (`kinds` names both families, so a part or connection that left Dev
 *      retires in the same call). Connection refs (`cn_n`) key the
 *      `connection:` slots, so three automations on one API bind once.
 *   3. Consistent cut: read the version tokens, capture (pipeline mode) and
 *      read the reference rows and carried KB listings, read the tokens again.
 *      Different → try again, at most 3 times, then 409 capture_raced. The
 *      tokens go in `source_cut`. Tables are fingerprinted per table, so an
 *      edit to an unrelated org table never races a cut.
 *   4. The stage-only checks (releaseChecks.js) over the capture and the
 *      payloads. Any blocking finding → 409 release_blocked {findings}.
 *   5. The manifest gains `solution.variables` (each declaration with its
 *      `steering` mark: declared, type url/email, or `vars.<name>` in a
 *      steering field) and `channel: 'pipeline'`.
 *   6. `cutPipelineRelease` with the content hash, the gate, the notes (a
 *      `releaseNotes.diffEntities` over the previous pipeline release, or the
 *      last gallery release for the first one) and the payloads, which never
 *      sit in the manifest. The same content hash and payloads as the latest
 *      release write nothing and answer that release (`reused`); the same
 *      request key answers the release it cut (`replayed`).
 *
 * Every store and engine comes in through `deps`.
 */

'use strict';

const { HttpError } = require('../../core/http/errors');
const { stableStringify, hashOf } = require('./model');

const MAX_CUT_ATTEMPTS = 3;
const MAX_NOTE_TEXT = 4000;
const STEERING_TYPES = Object.freeze(['url', 'email']);

const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
const rowsOf = (res) => (Array.isArray(res) ? res : (res && res.rows) || []);

/** The http_request connections an automation uses: the Dev ids a `cn_n` slot stands for. */
function connectionIdsOf(definitions) {
    const { walkAllSteps } = require('../../automation/portability');
    const ids = new Set();
    for (const definition of definitions || []) {
        if (!isObject(definition)) continue;
        walkAllSteps(definition, (step, layerKey, isTrigger) => {
            if (isTrigger || !isObject(step) || step.type !== 'http_request' || !isObject(step.auth)) return;
            if (typeof step.auth.connectionId === 'string' && step.auth.connectionId) ids.add(step.auth.connectionId);
        });
    }
    return [...ids].sort();
}

async function tolerantRows(q, sql, params) {
    try { return rowsOf(await q.query(sql, params)); } catch (err) {
        if (err && (err.code === '42P01' || err.code === '42703')) return [];
        throw err;
    }
}

/**
 * What a cut must see unchanged: the member ids per manifest section, the
 * Dev connections, and a version token per part (design 6.1 item 1).
 *
 * @returns {Promise<{ members: Record<string, string[]>, connections: string[], tokens: Record<string, any> }>}
 */
async function defaultReadCutState(devProject) {
    const id = devProject.id;
    const automationStore = require('../../stores/automationStore');
    const studioAppStore = require('../../stores/studioAppStore');
    const studioAppDataStore = require('../../stores/studioAppDataStore');
    const webpageStore = require('../../stores/webpageStore');
    const datatableStore = require('../../stores/datatableStore');
    const agentStore = require('../../stores/agentStore');
    const kbMembership = require('../knowledgeBaseMembership');
    const db = require('../../db');
    const q = { query: (sql, params) => db.run(sql, params) };

    const tokens = {};
    const members = {};
    const automations = await automationStore.getAutomationsForProject(id, { kinds: ['automation', 'block', 'layer'] });
    members.automations = automations.map(a => a.id);
    for (const a of automations) tokens[`automation:${a.id}`] = { version: a.version ?? null };

    members.apps = [];
    for (const m of await studioAppStore.listProjectApps(id)) {
        const app = await studioAppStore.getStudioApp(m.id);
        if (!app) continue;
        const meta = await studioAppDataStore.getDataModel(app.id, app.userId).catch(() => undefined);
        members.apps.push(app.id);
        tokens[`app:${app.id}`] = { definitionVersion: app.definitionVersion ?? null, dataModelVersion: meta === undefined ? null : (meta ? meta.modelVersion : 0) };
    }
    members.webpages = [];
    for (const m of await webpageStore.listProjectWebpages(id)) {
        const page = await webpageStore.getWebpageRaw(m.id);
        if (!page) continue;
        members.webpages.push(page.id);
        tokens[`webpage:${page.id}`] = { files: [page.htmlSha, page.cssSha, page.jsSha], updatedAt: page.updatedAt ? String(page.updatedAt) : null };
    }
    members.datatables = [];
    for (const t of await datatableStore.listDatatablesForProject(id)) {
        members.datatables.push(t.id);
        const meta = await datatableStore.getTableMeta(t.scope, t.id).catch(() => null);
        tokens[`datatable:${t.id}`] = { fingerprint: datatableStore.tableFingerprint(meta), updatedAt: t.updatedAt ? String(t.updatedAt) : null };
    }
    members.agents = [];
    for (const m of await agentStore.listProjectAgents(id)) {
        const agent = await agentStore.getAgent(m.id);
        if (!agent) continue;
        members.agents.push(agent.id);
        tokens[`agent:${agent.id}`] = { rev: agent.rev ?? null };
    }
    members.knowledgeBases = [];
    for (const kb of await kbMembership.listProjectKnowledgeBases(id)) {
        members.knowledgeBases.push(kb.id);
        const r = await tolerantRows(q,
            `SELECT COUNT(*)::int AS n, md5(COALESCE(string_agg(content_hash, ',' ORDER BY content_hash), '')) AS h
               FROM documents WHERE knowledge_base_id = $1::uuid AND status IN ('processed', 'redacted')`, [kb.id]);
        tokens[`knowledge_base:${kb.id}`] = r[0] ? { docs: Number(r[0].n), hash: r[0].h } : null;
    }
    const skills = await tolerantRows(q, 'SELECT id, version FROM skills WHERE project_id = $1 ORDER BY id', [id]);
    members.skills = skills.map(s => s.id);
    for (const s of skills) tokens[`skill:${s.id}`] = { version: Number(s.version) || null };
    const docs = await tolerantRows(q, 'SELECT id, version_id FROM studio_documents WHERE solution_project_id = $1 ORDER BY id', [id]);
    members.documents = docs.map(d => d.id);
    for (const d of docs) tokens[`document:${d.id}`] = { versionId: d.version_id || null };

    for (const list of Object.values(members)) list.sort();
    return { members, connections: connectionIdsOf(automations.map(a => a.definition)), tokens };
}

/**
 * The ledger: one allocateRefs over the parts (manifest section names as
 * kind, prefix REF_PREFIX) and the connections (kind 'connection', `cn`).
 * A section the manifest does not know yet has no prefix and is left out.
 */
async function allocateLedger(solutionId, state, blueprintStore) {
    const { REF_PREFIX } = require('../packaging/manifest');
    const sections = Object.keys(REF_PREFIX);
    const members = [];
    for (const section of sections) {
        for (const entityId of (state.members && state.members[section]) || []) members.push({ kind: section, entityId });
    }
    const connections = Array.isArray(state.connections) ? state.connections : [];
    for (const entityId of connections) members.push({ kind: 'connection', entityId });
    const all = await blueprintStore.allocateRefs(solutionId, members, {
        prefixOf: (kind) => REF_PREFIX[kind], kinds: [...sections, 'connection'],
    });
    const connectionSet = new Set(connections);
    const refs = new Map();
    const connSlots = new Map();
    for (const [entityId, ref] of all) (connectionSet.has(entityId) ? connSlots : refs).set(entityId, ref);
    return { refs, connSlots };
}

function optionsByRef(list) {
    const out = new Map();
    for (const o of Array.isArray(list) ? list : []) if (o && typeof o.ref === 'string') out.set(o.ref, isObject(o.options) ? o.options : {});
    return out;
}

/**
 * The content that never rides in the manifest (D20): reference rows of every
 * reference table, and the document listing of every KB in carry mode.
 *
 * @returns {Promise<{ payloads: object[], findings: object[], referenceRefs: string[] }>}
 */
async function defaultCapturePayloads({ devProject, refs, options }) {
    const datatableStore = require('../../stores/datatableStore');
    const { captureReferenceRows } = require('./referenceRows');
    const { listCarriedDocuments } = require('./knowledgeContent');
    const tables = [];
    const referenceRefs = [];
    for (const t of await datatableStore.listDatatablesForProject(devProject.id)) {
        const ref = refs.get(t.id);
        if (!ref) continue;
        const opt = options.get(ref);
        if (opt && typeof opt.reference === 'boolean' ? opt.reference : t.isReference) referenceRefs.push(ref);
        tables.push({ ref, meta: t, descriptor: await datatableStore.getTableMeta(t.scope, t.id), scope: t.scope });
    }
    const rows = await captureReferenceRows({ tables: tables.filter(t => t.descriptor), options });
    const payloads = [...rows.payloads];
    const findings = [...rows.findings];
    const idByRef = new Map([...refs].map(([id, ref]) => [ref, id]));
    for (const [ref, opt] of options) {
        if (opt.contentMode !== 'carry' || !/^kb_/.test(ref) || !idByRef.has(ref)) continue;
        const listing = await listCarriedDocuments(idByRef.get(ref), {}, { acks: opt.acks, ref });
        findings.push(...listing.findings);
        payloads.push({ ref, kind: listing.kind, sourceEntityId: listing.sourceEntityId, payload: listing.payload, contentHash: listing.contentHash });
    }
    return { payloads, findings, referenceRefs };
}

/** The declarations a release carries (4.2), each with its steering mark (D18). */
function releaseVariables(declarations, steeringNames) {
    const steering = new Set(Array.isArray(steeringNames) ? steeringNames : []);
    return (Array.isArray(declarations) ? declarations : []).filter(v => v && typeof v.name === 'string').map(v => ({
        name: v.name,
        type: v.type || 'text',
        choices: v.choices ?? null,
        description: v.description || '',
        required: v.required !== false,
        steering: v.steering === true || STEERING_TYPES.includes(v.type) || steering.has(v.name),
        position: Number(v.position) || 0,
    }));
}

/** The manifest the notes diff against: the previous pipeline release, else the last gallery release. */
async function previousManifest(projectId, blueprintStore) {
    const [latest] = await blueprintStore.listPipelineReleases(projectId, { limit: 1 });
    if (latest) return { basis: 'pipeline', manifest: (await blueprintStore.getRelease(projectId, latest.id))?.manifest || null };
    const [gallery] = await blueprintStore.listReleases(projectId, { limit: 1 });
    if (gallery) return { basis: 'gallery', manifest: (await blueprintStore.getRelease(projectId, gallery.id))?.manifest || null };
    return { basis: null, manifest: null };
}

function notesFor(userNotes, diff, basis) {
    const out = { changes: diff };
    if (basis) out.basis = basis;
    if (typeof userNotes === 'string' && userNotes.trim()) out.text = userNotes.trim().slice(0, MAX_NOTE_TEXT);
    else if (isObject(userNotes) && typeof userNotes.text === 'string' && userNotes.text.trim()) out.text = userNotes.text.trim().slice(0, MAX_NOTE_TEXT);
    return out;
}

/** The release this request key already cut, or null. */
async function replayOf(projectId, requestKey, blueprintStore) {
    if (!requestKey) return null;
    const list = await blueprintStore.listPipelineReleases(projectId, { limit: 50 });
    return (list || []).find(r => r && r.notes && r.notes.requestKey === requestKey) || null;
}

/**
 * Capture until two token reads agree (design 6.1 item 1).
 * @returns {Promise<{ state, capture, payloads, refs, connSlots }>}
 */
async function consistentCut({ devProject, options, blueprintStore, deps }) {
    const readCutState = dep(deps, 'readCutState', () => defaultReadCutState);
    const capture = dep(deps, 'captureSolution', () => require('../packaging/capture').captureSolution);
    const capturePayloads = dep(deps, 'capturePayloads', () => defaultCapturePayloads);
    for (let attempt = 1; attempt <= MAX_CUT_ATTEMPTS; attempt++) {
        const before = await readCutState(devProject);
        const { refs, connSlots } = await allocateLedger(devProject.id, before, blueprintStore);
        const captured = await capture({ project: devProject, refs, connSlots, pipeline: true, exportedAt: null });
        if (!captured || captured.ok === false) {
            throw new HttpError(422, 'capture_failed', 'This Solution could not be read.', { errors: captured?.errors || [] });
        }
        const payloads = await capturePayloads({ devProject, refs, options });
        const after = await readCutState(devProject);
        if (stableStringify(before) === stableStringify(after)) return { state: after, capture: captured, payloads, refs, connSlots };
    }
    throw new HttpError(409, 'capture_raced', 'Dev kept changing while the release was cut. Try again in a moment.');
}

/**
 * Cut a pipeline release of a Dev Solution.
 *
 * @param {{ devProject: { id: string, ownerId?: string, stage?: string|null, organizationId?: string|null, name?: string },
 *   actorId: string, requestKey?: string|null, notes?: string|object|null }} input
 * @param {object} [deps]  blueprintStore, solutionStageStore, releaseGate(project), readCutState(project),
 *   captureSolution(opts), capturePayloads({devProject, refs, options}), releaseChecks(input), diffEntities
 * @returns {Promise<{ release: object, reused: boolean, replayed: boolean, findings: object[] }>}
 * @throws {HttpError} 404 not_found (a stage), 403 solution_owner_only, 409 release_blocked, 409 capture_raced
 */
async function cutRelease({ devProject, actorId, requestKey = null, notes = null } = /** @type {any} */ ({}), deps = {}) {
    if (!devProject || typeof devProject.id !== 'string' || devProject.stage) throw new HttpError(404, 'not_found', 'Solution not found.');
    if (typeof actorId !== 'string' || !actorId) throw new HttpError(403, 'solution_owner_only', 'Only the Solution owner can cut a release.');
    if (devProject.ownerId && devProject.ownerId !== actorId) {
        throw new HttpError(403, 'solution_owner_only', 'Only the Solution owner can cut a release.');
    }
    const blueprintStore = dep(deps, 'blueprintStore', () => require('../../stores/blueprintStore'));
    const stageStore = dep(deps, 'solutionStageStore', () => require('../../stores/solutionStageStore'));

    const replay = await replayOf(devProject.id, requestKey, blueprintStore);
    if (replay) return { release: replay, reused: false, replayed: true, findings: [] };

    const releaseGate = dep(deps, 'releaseGate', () => require('../packaging/publication').releaseGate);
    const gate = await releaseGate(devProject);
    if (!gate || gate.blocked !== false) {
        throw new HttpError(409, 'release_blocked', 'This Solution is not ready for a release.', {
            findings: (gate && gate.findings) || [], unavailable: (gate && gate.unavailable) || [],
        });
    }

    const options = optionsByRef(await stageStore.getPartOptions(devProject.id));
    const declarations = await stageStore.listVariables(devProject.id);
    const { state, capture, payloads } = await consistentCut({ devProject, options, blueprintStore, deps });
    const manifest = capture.manifest;

    const checks = await dep(deps, 'releaseChecks', () => require('./releaseChecks').releaseChecks)({
        solutionId: devProject.id,
        manifest,
        rawIds: capture.rawIds,
        captureFindings: capture.findings,
        variables: declarations,
        referenceRefs: [...(payloads.referenceRefs || []), ...[...options].filter(([, o]) => o.reference === true).map(([ref]) => ref)],
        payloadFindings: payloads.findings,
    }, deps);
    const blockingFindings = checks.findings.filter(f => f.severity === 'blocking');
    if (blockingFindings.length) {
        throw new HttpError(409, 'release_blocked', 'This release cannot go to a stage yet.', { findings: blockingFindings });
    }

    manifest.channel = 'pipeline';
    manifest.solution.slots = Array.isArray(manifest.solution.slots) ? manifest.solution.slots : [];
    manifest.solution.variables = releaseVariables(declarations, capture.steeringNames);
    const contentHash = hashOf({
        entities: manifest.solution.entities, slots: manifest.solution.slots, variables: manifest.solution.variables,
    });

    const previous = await previousManifest(devProject.id, blueprintStore);
    const diffEntities = dep(deps, 'diffEntities', () => require('../packaging/releaseNotes').diffEntities);
    const releaseNotes = notesFor(notes, diffEntities({ previousManifest: previous.manifest, manifest }), previous.basis);

    const warnings = [...(gate.findings || []), ...checks.findings.filter(f => f.severity !== 'blocking')];
    const out = await blueprintStore.cutPipelineRelease({
        projectId: devProject.id,
        manifest,
        contentHash,
        gate: { blocked: false, complete: gate.complete === true, findings: warnings, unavailable: gate.unavailable || [] },
        sourceCut: { tokens: state.tokens, byRef: capture.cutTokens || null },
        notes: releaseNotes,
        createdBy: actorId,
        requestKey,
        payloads: (payloads.payloads || []).map(p => ({
            ref: p.ref, kind: p.kind, sourceEntityId: p.sourceEntityId, payload: p.payload, contentHash: p.contentHash,
        })),
    });
    return { release: out.release, reused: out.reused === true, replayed: out.replayed === true, findings: warnings };
}

module.exports = {
    cutRelease, releaseVariables, connectionIdsOf, allocateLedger, defaultReadCutState, defaultCapturePayloads,
    MAX_CUT_ATTEMPTS,
};
