/**
 * What a deployment would do (design 6.3). Writes nothing.
 *
 *   release × the stage's stamps × its bindings × its variables → plan
 *
 * For every part of the release the plan binds the release entity the way
 * prepare will (`$ref` → the stage's ids from the stamps, then the bindings,
 * then the literal table tokens in page code) and compares canonical hashes
 * (stagePayload.js, never upgrade.currentPayload):
 *
 *   create     no stamp yet (or the stamped part is gone: `missing`)
 *   revive     the stamp was retired by an earlier release
 *   unchanged  bound hash == stamp.install_hash AND the stored part still hashes to it
 *   replace    anything else
 *   retire     a stamped part the release no longer has
 *   drift      the stored part no longer hashes to its stamp: the deploy
 *              overwrites a change made outside a deploy, and says so
 *
 * Beside the parts: the per-table schema diff with the fingerprint the commit
 * re-checks and the constraints a retirement relaxes, reference rows and
 * carried knowledge from the release payloads, missing / orphaned bindings,
 * missing / invalid variables and steering values waiting for this deploy,
 * readiness, the cross-stage scan, the go-live checks of every automation that
 * will be active after the deploy (owner = run-as), the additive check of an
 * app's own data model, the gates, the PRD-only differences from UAT and the
 * acknowledgements the requester must give. `kind: 'settings'` plans a
 * settings patch only (D19); `kind: 'remove'` lists what a removal takes down.
 */

'use strict';

const { HttpError } = require('../../core/http/errors');
const { fromRefs, HOLDER_KINDS } = require('../packaging/pointers');
const { REF_PREFIX } = require('../packaging/manifest');
const { substituteTableTokens } = require('../packaging/idSweep');
const { RELEASE_KINDS, eligibleForStage, needsApproval, stableStringify, planHash } = require('./model');
const { KIND_OF_SECTION, canonicalOf, hashPayload, readStageShape } = require('./stagePayload');
const { applyBindingsTo, bindingMap } = require('./applyBindings');

const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());
const rowsOf = (res) => (Array.isArray(res) ? res : (res && res.rows) || []);
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
const clone = (v) => JSON.parse(JSON.stringify(v));
const blocking = (code, extra = {}) => ({ code, severity: 'blocking', ...extra });
const SETTINGS_KEYS = Object.freeze(['requiresApproval', 'approvalPolicy', 'rollbackNeedsApproval']);
const PERSONAL_DATA_PII = Object.freeze(['found', 'unscanned']);

function stores(deps) {
    return {
        stageStore: dep(deps, 'solutionStageStore', () => require('../../stores/solutionStageStore')),
        blueprintStore: dep(deps, 'blueprintStore', () => require('../../stores/blueprintStore')),
    };
}

/** Has this release a succeeded deployment on that stage of the Solution? */
async function defaultReleaseSucceededIn({ solutionId, stage, releaseId }) {
    const db = require('../../db');
    const rows = rowsOf(await db.run(
        `SELECT 1 AS ok FROM solution_deployments
          WHERE solution_id = $1 AND stage = $2 AND release_id = $3
            AND status IN ('succeeded', 'succeeded_with_warnings') LIMIT 1`,
        [solutionId, stage, releaseId],
    ));
    return rows.length > 0;
}

async function defaultKbDocs(kbId) {
    const db = require('../../db');
    return rowsOf(await db.run(
        'SELECT id::text AS id, content_hash, status FROM documents WHERE knowledge_base_id = $1::uuid', [kbId],
    ));
}

// ── Binding a release entity the way prepare will ──────────────────────────────

/** `aut_3`, `dt_12`: the shape of a bundle-local ref. A JSON-Schema `$ref` (`#/$defs/x`) is not one. */
const BUNDLE_REF = new RegExp(`^(?:${Object.values(REF_PREFIX).join('|')})_\\d+$`);
const isBundleRefObject = (v) => isObject(v) && typeof v.$ref === 'string' && BUNDLE_REF.test(v.$ref);

/**
 * A bundle ref the pointer registry does not know (a skill step's `refs[].id`,
 * a hand-made file) resolves through the same map. ONLY objects whose `$ref`
 * is a bundle ref are touched: a skill's output schema or a table's options
 * may carry a real JSON-Schema `$ref`, which capture never rewrote and a
 * stage copy must not lose.
 */
function rewriteBundleRefs(value, idByRef, unresolved) {
    if (Array.isArray(value)) return value.map(v => rewriteBundleRefs(v, idByRef, unresolved));
    if (!isObject(value)) return value;
    if (isBundleRefObject(value)) {
        const real = idByRef.get(value.$ref);
        if (real === undefined || real === null) { unresolved.push(value.$ref); return null; }
        return real;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteBundleRefs(v, idByRef, unresolved);
    return out;
}

/**
 * One release entity as it will be stored on this stage: a clone with every
 * `$ref` resolved to the stage's id (a ref with no stage part yet becomes
 * null), the bindings applied and, for a page, every literal Dev table id in
 * its code replaced by the stage table's (substitutions listed).
 *
 * @param {string} kind
 * @param {object} entity  a manifest entity
 * @param {{ idByRef: Map, bindings: Map, slots: object[], tableTokens?: Map }} ctx
 * @returns {{ entity: object, substitutions: object[], unresolved: string[] }}
 */
function bindReleaseEntity(kind, entity, { idByRef, bindings, slots, tableTokens = new Map() }) {
    const bound = clone(entity);
    const holder = kind === 'block' ? 'automation' : kind;
    const unresolved = [];
    if (HOLDER_KINDS.includes(holder)) for (const u of fromRefs(holder, bound, idByRef).unresolved) unresolved.push(u.ref);
    // A bundle `$ref` the registry has no row for (a hand-made file) is not left in a stored payload.
    for (const key of Object.keys(bound)) if (key !== 'ref') bound[key] = rewriteBundleRefs(bound[key], idByRef, unresolved);
    applyBindingsTo(kind, bound, bindings, { slots });
    const substitutions = [];
    if (kind === 'webpage' && isObject(bound.files) && tableTokens.size) {
        for (const slot of ['html', 'css', 'js']) {
            const out = substituteTableTokens(bound.files[slot], tableTokens);
            bound.files[slot] = out.text;
            for (const s of out.substitutions) substitutions.push({ file: slot, count: s.count });
        }
    }
    return { entity: bound, substitutions, unresolved };
}

/** Dev table id → stage table id, through the ledger's refs and the stage's stamps. */
async function tableTokenMap(solutionId, idByRef, blueprintStore) {
    const out = new Map();
    if (typeof blueprintStore.refsFor !== 'function') return out;
    for (const row of await blueprintStore.refsFor(solutionId)) {
        if (row.kind !== 'datatables') continue;
        const stageId = idByRef.get(row.ref);
        if (stageId) out.set(row.entityId, stageId);
    }
    return out;
}

// ── Tables (design 3.2) ──────────────────────────────────────────────────────

/**
 * The schema change one stage table takes: release columns replace the
 * stage's (ids kept), a column the release leaves out RETIRES (never DROP),
 * a retired column the release brings back UNRETIRES. Retiring relaxes the
 * column's NOT NULL / unique / FK, listed per column.
 */
function dataDiff(entity, current) {
    const { retireMetaFor, retainConflicts } = require('../../core/dataEngine/dataModel/migrationPlan');
    const columns = (Array.isArray(entity.columns) ? entity.columns : []).filter(c => isObject(c) && c.id);
    const base = { ref: entity.ref, name: entity.name || entity.key || entity.ref };
    if (!current) {
        return { diff: { ...base, create: true, add: columns.map(c => c.key), rename: [], retire: [], unretire: [], blocked: [], preflight: 'not_needed' }, retiredFields: [] };
    }
    const fields = Array.isArray(current.fields) ? current.fields.filter(isObject) : [];
    const byId = new Map(fields.map(f => [f.id, f]));
    const retiredBefore = (Array.isArray(current.retiredFields) ? current.retiredFields : []).filter(isObject);
    const retiredIds = new Set(retiredBefore.map(r => r.id));
    const releaseIds = new Set(columns.map(c => c.id));
    const add = [];
    const rename = [];
    const unretire = [];
    const blocked = [];
    for (const c of columns) {
        const live = byId.get(c.id);
        if (live) {
            if (live.key !== c.key) rename.push({ from: live.key, to: c.key });
            if (live.type && c.type && live.type !== c.type) blocked.push({ code: 'schema.type_change', key: c.key });
        } else if (retiredIds.has(c.id)) unretire.push(c.key);
        else add.push(c.key);
    }
    const retire = fields.filter(f => !releaseIds.has(f.id)).map((f) => {
        const meta = retireMetaFor(f);
        return { key: f.key, relaxes: { notNull: !!meta.notNull, unique: !!meta.unique, fk: !!meta.fk } };
    });
    const retiredAfter = [...new Set([...retiredIds, ...fields.filter(f => !releaseIds.has(f.id)).map(f => f.id)])].filter(id => !releaseIds.has(id));
    if (isObject(current.descriptor) && current.descriptor.id) {
        const target = { ...current.descriptor, fields: columns, retired_fields: retiredBefore.filter(r => !releaseIds.has(r.id)) };
        for (const f of retainConflicts({ tables: [current.descriptor] }, { tables: [target] }, { onlyTableIds: [current.descriptor.id] })) {
            if (!blocked.some(b => b.code === f.code && b.key === f.key)) blocked.push({ code: f.code, key: f.key });
        }
    }
    const changed = add.length || rename.length || retire.length || unretire.length;
    return {
        diff: { ...base, add, rename, retire, unretire, blocked, preflight: changed ? 'pending' : 'not_needed', ...(current.fingerprint ? { fingerprint: current.fingerprint } : {}) },
        retiredFields: retiredAfter,
    };
}

// ── Parts ────────────────────────────────────────────────────────────────────

/** Is the stored part on (an automation active, an app/page/agent published)? */
function liveOf(kind, shape) {
    if (!shape) return false;
    if (kind === 'automation') return shape.isActive === true;
    if (kind === 'agent') return shape.is_published === true || shape.isPublished === true;
    return shape.isPublished === true;
}

function noteFor(release, ref) {
    const changes = Array.isArray(release?.notes?.changes) ? release.notes.changes : [];
    const hit = changes.find(c => c && c.entityId === ref);
    return hit ? (hit.text || null) : null;
}

async function goLiveRefusal({ entity, bound, stamp, stage }, deps) {
    const check = dep(deps, 'checkBeforeLiveCore', () => require('../../automation/goLive').checkBeforeLiveCore);
    const aiActState = dep(deps, 'aiActState', () => require('../../automation/aiActCheck').defaultAiActState());
    const automation = {
        id: stamp ? stamp.entityId : null, kind: 'automation', title: entity.title || '',
        userId: stage.runAsUserId, organizationId: stage.organizationId || null, projectId: stage.projectId,
        definition: bound.definition,
    };
    try {
        const verdict = await check({
            automation, definition: bound.definition, ownerId: stage.runAsUserId,
            organizationId: stage.organizationId || null, deps: { aiActState },
        });
        if (verdict && verdict.ok === false) {
            const details = (verdict.body && verdict.body.details) || verdict.details || null;
            return blocking(verdict.code || 'go_live_refused', {
                ref: entity.ref, status: verdict.status || null, message: verdict.message || null,
                ...(Array.isArray(details) && details.length ? { details } : {}),
            });
        }
        return null;
    } catch (err) {
        return blocking('go_live_unchecked', { ref: entity.ref, message: err.message });
    }
}

/** Which applied binding values (slug, mirror source) differ from the stored part. */
function settingsDrift(kind, ref, shape, bindings) {
    if (!shape) return [];
    const out = [];
    if (kind === 'webpage') {
        const v = bindings.get(`slug:${ref}`);
        if (isObject(v) && typeof v.slug === 'string' && v.slug.trim() && v.slug.trim().toLowerCase() !== (shape.slug || null)) out.push('slug');
    }
    if (kind === 'datatable') {
        const v = bindings.get(`mirror:${ref}`);
        if (isObject(v) && stableStringify(v) !== stableStringify(shape.source || null)) out.push('mirror');
    }
    return out;
}

async function planPart(section, entity, ctx, deps) {
    const kind = KIND_OF_SECTION[section];
    const { stamps, stage } = ctx;
    const stamp = stamps.get(entity.ref) || null;
    const subKind = kind === 'automation' && ['block', 'layer'].includes(entity.kind) ? entity.kind : kind;
    const shape = stamp && !stamp.retiredAt ? await readStageShape(kind, stamp.entityId, {}, deps) : null;
    const bound = bindReleaseEntity(kind, entity, ctx);
    // The stamp holds the hash of the PINNED definition (prepare pins before it hashes); without the same
    // pin an automation with a fill_document step would read as replace and drift on every plan.
    if (kind === 'automation' && ctx.templatePins.size) {
        dep(deps, 'install', () => require('../packaging/install')).pinTemplateVersions(bound.entity.definition, ctx.templatePins);
    }

    if (kind === 'datatable') {
        const current = shape ? { ...shape, fingerprint: shape.descriptor ? ctx.fingerprint(shape.descriptor) : null } : null;
        const { diff, retiredFields } = dataDiff(entity, current);
        bound.entity.retiredFields = retiredFields;
        ctx.data.push(diff);
        for (const b of diff.blocked) ctx.blocking.push(blocking(b.code, { ref: entity.ref, key: b.key }));
        if (diff.retire.length) ctx.acks.push({ code: 'schema.retire_column', ref: entity.ref });
        const personal = require('../../core/privacy/personalColumns').byName(entity.columns || []);
        const lawful = entity.lawfulBasis || (shape && shape.lawfulBasis);
        if (stage.stage === 'prd' && personal.length && !lawful) ctx.acks.push({ code: 'privacy.no_lawful_basis', ref: entity.ref });
    }
    if (kind === 'app' && isObject(entity.dataModel) && shape && isObject(shape.dataModel)) {
        const { additiveModel } = dep(deps, 'studioAppDataStore', () => require('../../stores/studioAppDataStore'));
        const merged = additiveModel(shape.dataModel, bound.entity.dataModel);
        if (merged.invalid || merged.refused.length) {
            ctx.blocking.push(blocking('app.data_model_not_additive', { ref: entity.ref, statements: merged.refused.length }));
        } else bound.entity.dataModel = merged.model;
    }

    let action;
    let missing = false;
    if (!stamp) action = 'create';
    else if (stamp.retiredAt) action = 'revive';
    else if (!shape) { action = 'create'; missing = true; }
    const boundHash = hashPayload(canonicalOf(kind, bound.entity));
    const currentHash = shape ? hashPayload(canonicalOf(kind, shape)) : null;
    const drift = !!(stamp && shape && currentHash !== stamp.installHash);
    if (!action) action = boundHash === stamp.installHash && !drift ? 'unchanged' : 'replace';

    // A webpage address and a mirror source are applied settings, outside the canonical hash (a release
    // does not carry them): a stage binding that differs from what is stored makes the part a replace.
    const settingsChanged = settingsDrift(kind, entity.ref, shape, ctx.bindings);
    if (action === 'unchanged' && settingsChanged.length) action = 'replace';

    const newOrRevived = action === 'create' || action === 'revive';
    const goesLive = newOrRevived ? stage.newPartsActive === true : liveOf(kind, shape);
    // The go-live check reads the bound definition. A pointer at a part of THIS release that has no stage
    // part yet is still empty in it (prepare creates that part first), so the check would refuse an automation
    // for a table, knowledge base or agent that the deploy itself brings. Prepare verifies it afterwards.
    const pending = bound.unresolved.some(r => ctx.releaseRefs.has(r));
    if (kind === 'automation' && subKind === 'automation' && goesLive && !pending) {
        const refusal = await goLiveRefusal({ entity, bound: bound.entity, stamp, stage }, deps);
        if (refusal) ctx.blocking.push(refusal);
    }
    if (drift) ctx.acks.push({ code: 'drift', ref: entity.ref });
    ctx.bound.push({ ref: entity.ref, kind, entity: bound.entity, hash: boundHash });
    return {
        ref: entity.ref, kind, ...(subKind !== kind ? { automationKind: subKind } : {}), name: entity.name || entity.title || entity.key || entity.ref,
        action, drift, goesLive, summary: noteFor(ctx.release, entity.ref),
        ...(missing ? { missing: true } : {}),
        ...(settingsChanged.length ? { settingsChanged } : {}),
        ...(goesLive && pending && kind === 'automation' && subKind === 'automation' ? { goLiveDeferred: true } : {}),
        ...(bound.substitutions.length ? { substitutions: bound.substitutions } : {}),
        ...(bound.unresolved.length ? { unresolved: [...new Set(bound.unresolved)] } : {}),
    };
}

/**
 * Stage template id → the revision an automation pins, for every template this deploy leaves as it is
 * (stamped, not retired, hash equal to the stamp). A template the deploy writes gets a revision
 * only at prepare, so its automations stay unpinned here and read as the replace they are.
 */
async function templatePins(ctx, manifest, deps) {
    const pins = new Map();
    const entities = Array.isArray(manifest.solution?.entities?.documents) ? manifest.solution.entities.documents : [];
    for (const entity of entities) {
        if (!isObject(entity) || typeof entity.ref !== 'string') continue;
        const stamp = ctx.stamps.get(entity.ref);
        if (!stamp || stamp.retiredAt) continue;
        const shape = await readStageShape('document', stamp.entityId, {}, deps);
        if (!shape || typeof shape.version_id !== 'string' || !shape.version_id) continue;
        const bound = bindReleaseEntity('document', entity, ctx);
        const unchanged = hashPayload(canonicalOf('document', bound.entity)) === stamp.installHash
            && hashPayload(canonicalOf('document', shape)) === stamp.installHash;
        if (unchanged) pins.set(stamp.entityId, shape.version_id);
    }
    return pins;
}

// ── Payloads, bindings, variables ────────────────────────────────────────────

async function payloadPlans(ctx, deps) {
    const { planReferenceRows } = require('./referenceRows');
    const { planKnowledge } = require('./knowledgeContent');
    const referenceRows = [];
    const knowledge = [];
    const previous = ctx.previousListings;
    for (const p of ctx.payloads) {
        const stamp = ctx.stamps.get(p.ref);
        const target = stamp && !stamp.retiredAt ? stamp.entityId : null;
        if (p.kind === 'reference_rows') {
            const current = target ? await readStageShape('reference_rows', target, {}, deps) : null;
            const out = planReferenceRows(current ? current.rows : [], p.payload);
            referenceRows.push({ ref: p.ref, insert: out.insert.length, update: out.update.length, delete: out.delete.length });
        } else if (p.kind === 'knowledge_listing') {
            const docs = target ? await dep(deps, 'readKbDocs', () => defaultKbDocs)(target) : [];
            const out = planKnowledge(docs, p.payload, previous.get(p.ref) || null);
            const flagged = (p.payload.docs || []).filter(d => PERSONAL_DATA_PII.includes(d.piiStatus)).length;
            knowledge.push({
                ref: p.ref, copy: out.copy.length, remove: out.remove.length, unchanged: out.unchanged.length,
                personalDataFlagged: flagged, sourceStage: ctx.stage.stage === 'uat' ? 'dev' : 'uat',
            });
            if (flagged) ctx.acks.push({ code: 'kb.personal_data', ref: p.ref });
        }
    }
    return { referenceRows, knowledge };
}

function bindingsPlan(slots, bindingRows) {
    const bound = new Set((bindingRows || []).filter(b => b && b.value !== null && b.value !== undefined).map(b => b.slot));
    const bySlot = new Map();
    for (const s of Array.isArray(slots) ? slots : []) {
        if (!s || typeof s.slot !== 'string') continue;
        const entry = bySlot.get(s.slot) || { slot: s.slot, label: s.label || s.slot, neededBy: [] };
        if (s.ref && !entry.neededBy.includes(s.ref)) entry.neededBy.push(s.ref);
        bySlot.set(s.slot, entry);
    }
    return {
        missing: [...bySlot.values()].filter(e => !bound.has(e.slot)),
        orphaned: [...bound].filter(slot => !bySlot.has(slot)).sort(),
    };
}

function variablesPlan(declarations, values) {
    const { coerceValue } = require('../../stores/solutionStage/variables');
    const byName = new Map((values || []).filter(v => v && v.name).map(v => [v.name, v]));
    const out = { missing: [], invalid: [], steeringPending: [] };
    for (const d of Array.isArray(declarations) ? declarations : []) {
        if (!d || typeof d.name !== 'string') continue;
        const row = byName.get(d.name);
        const empty = !row || row.value === null || row.value === undefined || row.value === '';
        if (empty) { if (d.required !== false) out.missing.push(d.name); continue; }
        if (coerceValue(d.type || 'text', row.value, d.choices) === undefined) out.invalid.push(d.name);
        if (d.steering === true && stableStringify(row.value) !== stableStringify(row.appliedValue ?? null)) out.steeringPending.push(d.name);
    }
    return out;
}

/** PRD only: where PRD's own settings differ from UAT's (bindings, variables, new-parts switch). */
async function differsFromUat(stage, prdBindings, prdValues, stageStore) {
    if (stage.stage !== 'prd') return [];
    const uat = await stageStore.getStageFor(stage.solutionId, 'uat');
    if (!uat) return [];
    const [uatBindings, uatValues] = await Promise.all([stageStore.listBindings(uat.projectId), stageStore.listVariableValues(uat.projectId)]);
    const out = [];
    const diff = (kind, a, b) => {
        for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
            const u = a.has(key) ? a.get(key) : null;
            const p = b.has(key) ? b.get(key) : null;
            if (stableStringify(u) !== stableStringify(p)) out.push({ kind, label: key, uat: u, prd: p });
        }
    };
    diff('binding', bindingMap(uatBindings), bindingMap(prdBindings));
    const vals = (rows) => new Map((rows || []).map(r => [r.name, r.value]));
    diff('variable', vals(uatValues), vals(prdValues));
    if (uat.newPartsActive !== stage.newPartsActive) out.push({ kind: 'setting', label: 'newPartsActive', uat: uat.newPartsActive, prd: stage.newPartsActive });
    return out;
}

// ── settings / remove ─────────────────────────────────────────────────────────

async function settingsPlan(stage, settingsPatch, deps) {
    if (!isObject(settingsPatch) || !Object.keys(settingsPatch).length || Object.keys(settingsPatch).some(k => !SETTINGS_KEYS.includes(k))) {
        throw new HttpError(400, 'settings_patch_invalid', `A settings deployment changes ${SETTINGS_KEYS.join(', ')} only.`);
    }
    const blockingList = [];
    const gateOn = settingsPatch.requiresApproval !== undefined ? settingsPatch.requiresApproval === true : stage.requiresApproval;
    const policy = settingsPatch.approvalPolicy !== undefined ? settingsPatch.approvalPolicy : stage.approvalPolicy;
    if (gateOn) {
        try {
            await require('./approvalGate').validatePolicy(policy, { orgId: stage.organizationId || null, ownerId: stage.runAsUserId }, deps);
        } catch (err) {
            if (!err || err.status !== 400) throw err;
            blockingList.push(blocking(err.code, { message: err.message }));
        }
    }
    const out = {
        kind: 'settings', stageProjectId: stage.projectId, stage: stage.stage, release: null, from: null,
        settingsPatch: clone(settingsPatch),
        current: { requiresApproval: stage.requiresApproval, approvalPolicy: stage.approvalPolicy, rollbackNeedsApproval: stage.rollbackNeedsApproval },
        blocking: blockingList,
        gates: { approval: needsApproval({ stage, kind: 'settings' }) ? 'required' : 'not_required' },
        acknowledgementsRequired: [],
        settingsVersion: stage.settingsVersion,
    };
    return { ...out, planHash: planHash(out) };
}

/**
 * @param {object} stage
 * @param {Map<string, object>} stamps
 * @param {boolean} deleteData  the removal also deletes the stage's tables and knowledge bases with their data
 */
function removePlan(stage, stamps, deleteData = false) {
    const parts = [...stamps.values()].filter(s => !s.retiredAt)
        .map(s => ({ ref: s.ref, kind: s.kind, action: 'remove', drift: false, goesLive: false }))
        .sort((a, b) => (a.ref < b.ref ? -1 : 1));
    const out = {
        kind: 'remove', stageProjectId: stage.projectId, stage: stage.stage, release: null,
        from: stage.currentReleaseId ? { releaseId: stage.currentReleaseId, seq: stage.currentReleaseSeq } : null,
        parts, blocking: [],
        gates: { approval: needsApproval({ stage, kind: 'remove' }) ? 'required' : 'not_required' },
        deleteData,
        acknowledgementsRequired: [{ code: 'stage.remove' }, ...(deleteData ? [{ code: 'stage.delete_data' }] : [])],
        settingsVersion: stage.settingsVersion,
    };
    return { ...out, planHash: planHash(out) };
}

// ── plan ─────────────────────────────────────────────────────────────────────

/**
 * @param {{ stageProjectId: string, releaseId?: string|null, kind?: string, settingsPatch?: object|null,
 *   includeBound?: boolean, deleteData?: boolean|null }} input  `deleteData` (kind 'remove' only) also deletes
 *   the stage's tables and knowledge bases with their data and adds the `stage.delete_data` acknowledgement;
 *   `includeBound` adds `bound: [{ref, kind, entity, hash}]` (prepare's
 *   input; not part of the hash and never stored)
 * @param {object} [deps]  solutionStageStore, blueprintStore, the stagePayload readers' stores, readiness,
 *   scanStagePayloads, checkBeforeLiveCore, aiActState, releaseSucceededIn, readKbDocs, studioAppDataStore,
 *   datatableStore (tableFingerprint)
 */
async function plan({ stageProjectId, releaseId = null, kind = 'deploy', settingsPatch = null, includeBound = false, deleteData = undefined } = /** @type {any} */ ({}), deps = {}) {
    const { stageStore, blueprintStore } = stores(deps);
    const stage = await stageStore.getStage(stageProjectId);
    if (!stage) throw new HttpError(404, 'stage_not_found', 'This stage does not exist.');
    if (kind === 'settings') return settingsPlan(stage, settingsPatch, deps);
    if (deleteData !== undefined && deleteData !== null && typeof deleteData !== 'boolean') {
        throw new HttpError(400, 'delete_data_invalid', 'deleteData must be true or false.');
    }
    if (kind === 'remove') return removePlan(stage, await blueprintStore.listStamps(stageProjectId), deleteData === true);
    if (!RELEASE_KINDS.includes(kind)) throw new HttpError(400, 'kind_invalid', `Unknown deployment kind "${kind}".`);

    const targetId = kind === 'redeploy' ? (releaseId || stage.currentReleaseId) : releaseId;
    const release = targetId ? await blueprintStore.getRelease(stage.solutionId, targetId) : null;
    if (!release || release.channel !== 'pipeline' || !isObject(release.manifest)) {
        throw new HttpError(404, 'release_not_found', 'That release does not exist.');
    }
    const manifest = release.manifest;
    const [stamps, bindingRows, payloads, values] = await Promise.all([
        blueprintStore.listStamps(stageProjectId),
        stageStore.listBindings(stageProjectId),
        blueprintStore.getReleasePayloads(release.id),
        stageStore.listVariableValues(stageProjectId),
    ]);
    const previousListings = new Map();
    if (stage.currentReleaseId && stage.currentReleaseId !== release.id) {
        for (const p of await blueprintStore.getReleasePayloads(stage.currentReleaseId, { kind: 'knowledge_listing' })) previousListings.set(p.ref, p.payload);
    } else for (const p of payloads) if (p.kind === 'knowledge_listing') previousListings.set(p.ref, p.payload);

    const idByRef = new Map([...stamps.values()].map(s => [s.ref, s.entityId]));
    const slots = Array.isArray(manifest.solution?.slots) ? manifest.solution.slots : [];
    const ctx = {
        stage, release, stamps, slots, idByRef, payloads, previousListings,
        bindings: bindingMap(bindingRows),
        tableTokens: await tableTokenMap(stage.solutionId, idByRef, blueprintStore),
        fingerprint: dep(deps, 'datatableStore', () => require('../../stores/datatableStore')).tableFingerprint,
        data: [], blocking: [], acks: [], bound: [],
    };

    ctx.templatePins = await templatePins(ctx, manifest, deps);
    const parts = [];
    const inRelease = new Set();
    ctx.releaseRefs = new Set();
    for (const section of Object.keys(KIND_OF_SECTION)) {
        for (const entity of Array.isArray(manifest.solution?.entities?.[section]) ? manifest.solution.entities[section] : []) {
            if (isObject(entity) && typeof entity.ref === 'string') ctx.releaseRefs.add(entity.ref);
        }
    }
    for (const section of Object.keys(KIND_OF_SECTION)) {
        for (const entity of Array.isArray(manifest.solution?.entities?.[section]) ? manifest.solution.entities[section] : []) {
            if (!isObject(entity) || typeof entity.ref !== 'string') continue;
            inRelease.add(entity.ref);
            parts.push(await planPart(section, entity, ctx, deps));
        }
    }
    for (const s of stamps.values()) {
        if (!inRelease.has(s.ref) && !s.retiredAt) parts.push({ ref: s.ref, kind: s.kind, name: null, action: 'retire', drift: false, goesLive: false, summary: null });
    }
    const { referenceRows, knowledge } = await payloadPlans(ctx, deps);
    const bindings = bindingsPlan(slots, bindingRows);
    const variables = variablesPlan(manifest.solution?.variables, values);

    const readinessFindings = await dep(deps, 'readiness', () => require('./readiness').readiness)(
        { stage, manifest, bindings: bindingRows, values, stamps }, deps);
    for (const f of readinessFindings) if (f.severity === 'error') ctx.blocking.push(blocking(f.code, { ref: f.ref || null, slot: f.slot || undefined, name: f.name || undefined, message: f.message }));
    const crossStage = await dep(deps, 'scanStagePayloads', () => require('./crossStageScan').scanStagePayloads)(
        { solutionId: stage.solutionId, stageProjectId, payloads: ctx.bound.map(b => ({ ref: b.ref, kind: b.kind, payload: b.entity })) }, deps);
    ctx.blocking.push(...crossStage);

    const succeeded = dep(deps, 'releaseSucceededIn', () => defaultReleaseSucceededIn);
    const testedInUat = stage.stage === 'prd' ? await succeeded({ solutionId: stage.solutionId, stage: 'uat', releaseId: release.id }) : null;
    const succeededInPrd = stage.stage === 'prd' && kind === 'rollback'
        ? await succeeded({ solutionId: stage.solutionId, stage: 'prd', releaseId: release.id }) : false;
    const eligible = eligibleForStage({ stage: stage.stage, kind, release, testedInUat: testedInUat === true, succeededInPrd, currentReleaseId: stage.currentReleaseId });
    if (!eligible.ok) ctx.blocking.unshift(blocking(eligible.code));

    const out = {
        kind, stageProjectId, stage: stage.stage,
        release: { id: release.id, seq: release.seq },
        from: stage.currentReleaseId ? { releaseId: stage.currentReleaseId, seq: stage.currentReleaseSeq } : null,
        parts, data: ctx.data, referenceRows, knowledge, bindings, variables,
        readiness: readinessFindings,
        blocking: ctx.blocking,
        gates: {
            releaseClean: release.gate?.blocked === false,
            testedInUat,
            approval: needsApproval({ stage, kind }) ? 'required' : 'not_required',
        },
        differsFromUat: await differsFromUat(stage, bindingRows, values, stageStore),
        acknowledgementsRequired: ctx.acks,
        settingsVersion: stage.settingsVersion,
    };
    out.planHash = planHash(out);
    if (includeBound) Object.defineProperty(out, 'bound', { value: ctx.bound, enumerable: false });
    return out;
}

module.exports = { plan, bindReleaseEntity, dataDiff, bindingsPlan, variablesPlan };
