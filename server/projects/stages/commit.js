/**
 * COMMIT, the second phase of a release deployment (design 6.4): ONE
 * Postgres transaction that moves every live pointer of the stage at once.
 *
 * In this order, all on the transaction's client:
 *
 *   SET LOCAL lock_timeout '5s', statement_timeout '120s'
 *   pg_advisory_xact_lock on the stage, then the CAS: the stage still runs the
 *     release the plan started from and its settings_version is unchanged,
 *     else 409 plan_stale
 *   knowledge content (applyKnowledge: documents + chunks from the source stage)
 *   skills (writeManagedSkill) and replaced templates (writeManagedTemplate)
 *   the flips: an automation's working copy goes live (publishWorkingCopy, exact on
 *     its version, the planGoLive columns; is_active only for a new or revived
 *     automation = new_parts_active, D22), a block's published_version, an app's
 *     published definition, an agent's published version, a page's pinned
 *     version
 *   retire: a part the release no longer has is switched off / unpublished and
 *     its stamp retired (tables and knowledge bases keep their data)
 *   steering variables: applied_value = value
 *   stamps: install_hash = hashPayload(canonicalOf(kind, bound entity))
 *   the stage pointer (setCurrentRelease, itself a CAS) and the deployment row
 *     to `converging` + committed_at, so a committed row is never `committing`
 *   LAST: the org datatable model through saveModel's buildNext: the stage
 *     tables' entries are rebuilt from the entries read UNDER the model lock
 *     (a changed fingerprint is plan_stale), so an unrelated org table edit is
 *     neither lost nor a conflict; the DDL keeps retired columns
 *     (migrationPlan retainRetired), and the reference rows are written after
 *     it, on the same client, so a column this release adds exists for them.
 *
 * Any throw rolls the whole transaction back; the runner then compensates
 * (status `compensating`) and fails the deployment.
 *
 * `commitSettings` is the commit of a `settings` deployment (D19, 6.8): the
 * CAS on settings_version plus the solution_stages update.
 */

'use strict';

const { HttpError } = require('../../core/http/errors');
const { stageLockSql } = require('../../stores/solutionStage/stages');
const { storesOf, makeJournal, WRITE_ACTIONS } = require('./prepare');

const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

const planStale = (details) => new HttpError(409, 'plan_stale',
    'The stage changed since this deployment was planned. Plan it again.', details);

/** Unpublishing a retired part: an audience flag on the row, written on the commit's client. */
const UNPUBLISH_SQL = Object.freeze({
    app: 'UPDATE studio_apps SET is_published = FALSE, updated_at = NOW() WHERE id = $1 AND is_published = TRUE',
    webpage: 'UPDATE webpages SET is_published = FALSE, updated_at = NOW() WHERE id = $1 AND is_published = TRUE',
    agent: 'UPDATE agents SET is_published = FALSE, updated_at = NOW() WHERE id = $1 AND is_published = TRUE',
});

// ── Tables (design 3.2) ──────────────────────────────────────────────────────

async function scopeSchema(client, scope) {
    try {
        return await require('./referenceRows')._resolveScopeSchema(client, scope);
    } catch {
        return null;
    }
}

/**
 * Rebuild the entries of the stage tables in `model` (a copy of the model read
 * under the lock): the release's columns (ids kept, normalised against the
 * stored ones), a column the release leaves out retired with the constraints
 * it relaxes (`retired_fields`), and `rowsLocked` on a reference table. With
 * `checkFingerprints`, an entry that changed since the deployment read it is
 * plan_stale.
 *
 * @returns {Promise<{ model: object, onlyTableIds: string[], retiredFieldIds: Set<string>, retiredMeta: Map<string, object> }>}
 */
async function buildStageTables(client, model, tables, { stage, deps = {}, checkFingerprints = true, referenceIds = new Set() } = {}) {
    const { normalizeFields } = dep(deps, 'datatableFields', () => require('../../core/dataEngine/dataModel/datatableFields'));
    const mp = dep(deps, 'migrationPlanModule', () => require('../../core/dataEngine/dataModel/migrationPlan'));
    const s = storesOf(deps);
    const out = { model, onlyTableIds: [], retiredFieldIds: new Set(), retiredMeta: new Map() };
    const list = Array.isArray(model.tables) ? model.tables : (model.tables = []);
    let schema;
    for (const t of tables) {
        const index = list.findIndex(x => x && x.id === t.id);
        if (index < 0) throw planStale({ ref: t.ref, why: 'table_gone' });
        const entry = list[index];
        if (checkFingerprints && t.fingerprint && s.datatableStore.tableFingerprint(entry) !== t.fingerprint) {
            throw planStale({ ref: t.ref, why: 'table_changed' });
        }
        const current = Array.isArray(entry.fields) ? entry.fields.filter(isObject) : [];
        const columns = Array.isArray(t.release && t.release.columns) ? t.release.columns : [];
        const norm = normalizeFields(columns, current);
        if (!norm.ok) throw new HttpError(409, 'schema_invalid', `The columns of "${t.ref}" do not validate.`, { ref: t.ref });
        const releaseIds = new Set(norm.fields.map(f => f.id));
        const kept = (Array.isArray(entry.retired_fields) ? entry.retired_fields : [])
            .filter(r => isObject(r) && !releaseIds.has(r.id));
        const leaving = current.filter(f => !releaseIds.has(f.id));
        for (const field of leaving) {
            if (schema === undefined) schema = await scopeSchema(client, s.datatableStore.orgScope(stage.organizationId));
            let state = null;
            try { state = await mp.readRetireState(client, { tableKey: entry.key, tableId: entry.id, field, schema }); } catch { state = null; }
            const meta = mp.retireMetaFor(field, state);
            out.retiredMeta.set(field.id, meta);
            out.retiredFieldIds.add(field.id);
            kept.push(meta);
        }
        const next = { ...entry, fields: norm.fields, retired_fields: kept };
        if (typeof t.entity.name === 'string' && t.entity.name) next.name = t.entity.name;
        if (referenceIds.has(t.id)) next.rowsLocked = true;
        if (!next.retired_fields.length) delete next.retired_fields;
        list[index] = next;
        out.onlyTableIds.push(t.id);
    }
    return out;
}

/** The DDL of a stage-table rebuild: only those tables, retired columns kept (never DROP COLUMN). */
function stageMigrationPlan(before, next, built, deps = {}) {
    const { migrationPlan } = dep(deps, 'migrationPlanModule', () => require('../../core/dataEngine/dataModel/migrationPlan'));
    if (!built.onlyTableIds.length) return [];
    return migrationPlan(before, next, {
        dialect: 'pg', onlyTableIds: built.onlyTableIds, retainRetired: true,
        retiredFieldIds: built.retiredFieldIds, retiredMeta: built.retiredMeta,
    });
}

async function applyReferenceRowsAll(client, { scope, model, referenceRows, runAsUserId, journal }, deps) {
    if (!referenceRows.length) return;
    const rr = dep(deps, 'referenceRowsModule', () => require('./referenceRows'));
    const byId = new Map((model.tables || []).filter(isObject).map(t => [t.id, t]));
    const descriptors = referenceRows.map(r => byId.get(r.tableId)).filter(Boolean);
    const order = rr.referenceApplyOrder(descriptors);
    const rowsOf = new Map(referenceRows.map(r => [r.tableId, r]));
    const counts = new Map();
    for (const id of order) {
        const out = await rr.applyReferenceRows(client, { scope, tableMeta: byId.get(id), rows: rowsOf.get(id).rows, runAsUserId, phase: 'upsert' }, deps.referenceRowsDeps || {});
        counts.set(id, { written: out.written, deleted: 0, skipped: out.skippedFieldIds.length });
    }
    for (const id of [...order].reverse()) {
        const out = await rr.applyReferenceRows(client, { scope, tableMeta: byId.get(id), rows: rowsOf.get(id).rows, runAsUserId, phase: 'delete' }, deps.referenceRowsDeps || {});
        counts.get(id).deleted = out.deleted;
    }
    for (const r of referenceRows) {
        const c = counts.get(r.tableId);
        if (c) await journal.record('reference_rows', { ref: r.ref, kind: 'datatable', entityId: r.tableId, detail: c });
    }
}

/** The org model write, last in the commit: buildNext under the lock, DDL, then the reference rows. */
async function commitTables(client, { stage, prepared, journal }, deps) {
    const s = storesOf(deps);
    const tables = prepared.tables || [];
    const referenceRows = prepared.referenceRows || [];
    if (!tables.length && !referenceRows.length) return;
    const scope = s.datatableStore.orgScope(stage.organizationId);
    const key = s.datatableDbStore.scopeKey(scope);
    const referenceIds = new Set(referenceRows.map(r => r.tableId));
    const managedWrite = prepared.managedWrite;
    let built = null;
    const saved = await s.datatableStore.saveModel(scope, null, {
        client, managedWrite,
        buildNext: async (locked) => {
            built = await buildStageTables(client, locked, tables, { stage, deps, referenceIds });
            return built.model;
        },
        applyPhysical: async (c, { before, next, modelVersion }) => {
            const ddl = stageMigrationPlan(before, next, built, deps);
            if (ddl.length) await s.datatableDbStore.applyMigration(key, key, ddl, { client: c, targetVersion: modelVersion });
            await applyReferenceRowsAll(c, { scope, model: next, referenceRows, runAsUserId: stage.runAsUserId, journal }, deps);
        },
    });
    if (!saved || saved.ok === false) throw planStale({ why: 'model_conflict' });
    for (const t of tables) {
        await journal.record('schema', { ref: t.ref, kind: 'datatable', entityId: t.id,
            detail: { retired: [...built.retiredFieldIds].length, columns: (t.release.columns || []).length } });
    }
    // The is_reference column follows the release: the rows travel, the table is row-locked.
    for (const id of referenceIds) {
        if (typeof s.datatableStore.setReferenceFlag === 'function') {
            await s.datatableStore.setReferenceFlag(id, scope, true, { client, managedWrite });
        }
    }
}

/** A replaced table's labels and mirror source (applied settings outside the model entry). */
async function tableSettings(client, { stage, prepared }, deps) {
    const s = storesOf(deps);
    const scope = s.datatableStore.orgScope(stage.organizationId);
    for (const t of prepared.tables || []) {
        if (!WRITE_ACTIONS.includes(t.action)) continue;
        if (t.action !== 'create') {
            const patch = { name: t.entity.name || undefined, description: typeof t.entity.description === 'string' ? t.entity.description : undefined };
            if (t.entity.rowScope === 'own' || t.entity.rowScope === 'all') patch.rowScope = t.entity.rowScope;
            await s.datatableStore.updateDatatableMeta(t.id, scope, patch, { client, managedWrite: prepared.managedWrite });
        }
        if (isObject(t.entity.source)) {
            await client.query('UPDATE datatables SET source = $2::jsonb, updated_at = NOW() WHERE id = $1',
                [t.id, JSON.stringify(t.entity.source)]);
        }
    }
}

// ── Flips ────────────────────────────────────────────────────────────────────

async function flipAutomation(client, part, ctx) {
    const { s, stage, managedWrite, deps } = ctx;
    const lifecycle = dep(deps, 'lifecycleFor', () => (c) => require('../../stores/automationStore/lifecycle').makeLifecycleStore(c))(client);
    if (part.installKind === 'block') {
        const out = await s.automationStore.publishBlockVersionWith(client, part.entityId, { managedWrite, savedByUserId: stage.runAsUserId });
        if (!out) throw planStale({ ref: part.ref, why: 'block_gone' });
        return;
    }
    const a = await s.automationStore.getAutomation(part.entityId);
    if (!a) throw planStale({ ref: part.ref, why: 'automation_gone' });
    let columns = {};
    if (part.installKind === 'automation') {
        const { planGoLive } = dep(deps, 'goLive', () => require('../../automation/goLive'));
        const willBeActive = part.newOrRevived ? stage.newPartsActive === true : a.isActive === true;
        const plan = planGoLive(a, a.definition, { willBeActive, verb: 'publish' });
        if (!plan.ok) throw new HttpError(409, plan.code || 'invalid_schedule', plan.message, { ref: part.ref });
        columns = { ...plan.columns, ...(part.newOrRevived ? { isActive: stage.newPartsActive === true } : {}) };
    }
    const out = await lifecycle.publishWorkingCopy(part.entityId, { expectedVersion: a.version, columns, managedWrite });
    if (!out) throw planStale({ ref: part.ref, why: 'version_changed' });
}

const FLIPS = {
    automation: flipAutomation,
    async app(client, part, { s, managedWrite, prepared }) {
        const app = prepared.apps.get(part.entityId);
        if (!app) return;
        const ok = await s.studioAppStore.publishDefinitionWith(client, part.entityId, app.definition, app.version, { managedWrite });
        if (!ok) throw planStale({ ref: part.ref, why: 'app_gone' });
    },
    async agent(client, part, { s, managedWrite }) {
        const out = await s.agentStore.publishAgentVersion(part.entityId, { client, managedWrite });
        if (!out || out.ok === false) throw planStale({ ref: part.ref, why: 'agent_conflict' });
    },
    async webpage(client, part, { s, stage, managedWrite, prepared }) {
        const versionId = prepared.webpages.get(part.entityId);
        if (!versionId) return;
        const ok = await s.webpageStore.setPublishedVersion(part.entityId, stage.runAsUserId, versionId, { client, managedWrite });
        if (!ok) throw planStale({ ref: part.ref, why: 'page_gone' });
    },
};

async function retirePart(client, stamp, ctx) {
    const { s, managedWrite, deps } = ctx;
    if (stamp.kind === 'automation') {
        const a = await s.automationStore.getAutomation(stamp.entityId);
        if (a && a.kind === 'automation' && a.isActive) {
            const lifecycle = dep(deps, 'lifecycleFor', () => (c) => require('../../stores/automationStore/lifecycle').makeLifecycleStore(c))(client);
            const out = await lifecycle.publishWorkingCopy(stamp.entityId, { expectedVersion: a.version, columns: { isActive: false }, managedWrite });
            if (!out) throw planStale({ ref: stamp.ref, why: 'version_changed' });
        }
    } else if (UNPUBLISH_SQL[stamp.kind]) {
        await client.query(UNPUBLISH_SQL[stamp.kind], [stamp.entityId]);
    }
    await s.blueprintStore.upsertStamp(client, {
        projectId: ctx.stage.projectId, ref: stamp.ref, kind: stamp.kind, entityId: stamp.entityId,
        installHash: stamp.installHash, retired: true,
    });
}

// ── commit ───────────────────────────────────────────────────────────────────

async function lockAndCas(client, { deployment, stage }) {
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '120s'`);
    await client.query(stageLockSql, [stage.projectId]);
    const row = (await client.query(
        'SELECT current_release_id, settings_version FROM solution_stages WHERE project_id = $1 FOR UPDATE', [stage.projectId],
    )).rows[0];
    if (!row) throw new HttpError(404, 'stage_not_found', 'This stage does not exist.');
    if ((row.current_release_id || null) !== (deployment.fromReleaseId || null)
        || Number(row.settings_version) !== Number(deployment.stageSettingsVersion)) {
        throw planStale({ why: 'stage_moved' });
    }
}

async function toConverging(client, s, deployment) {
    const moved = await s.stageStore.transitionDeployment(deployment.id, ['committing'], 'converging', { committed: true }, { client });
    if (!moved) throw new HttpError(409, 'deployment_lost', 'This deployment is no longer committing.');
    return moved;
}

/**
 * @param {{ deployment: object, stage: object, prepared: object }} input  `prepared` is prepare's result
 * @param {object} [deps]  stores (prepare.storesOf), `applyKnowledge`, `referenceRowsModule`, `goLive`,
 *   `lifecycleFor(client)`, `beforeTables(client)` (a test's hook into the transaction)
 * @returns {Promise<object>} the deployment row, now `converging`
 */
async function commit({ deployment, stage, prepared }, deps = {}) {
    const s = storesOf(deps);
    const managedWrite = prepared.managedWrite || { deploymentId: deployment.id };
    const ctx = { s, deps, stage, prepared, managedWrite };
    return s.withTransaction(async (client) => {
        await lockAndCas(client, { deployment, stage });
        const journal = makeJournal(s.stageStore, deployment.id, 'commit', { client });

        const applyKnowledge = dep(deps, 'applyKnowledge', () => require('./knowledgeContent').applyKnowledge);
        for (const k of prepared.knowledge || []) {
            const out = await applyKnowledge(client, { sourceKbId: k.sourceKbId, targetKbId: k.targetKbId,
                tenantId: stage.organizationId, releaseDocs: k.releaseDocs, previousDocs: k.previousDocs });
            await journal.record('knowledge', { ref: k.ref, kind: 'knowledge_base', entityId: k.targetKbId, detail: out });
        }
        for (const sk of prepared.skills || []) {
            await s.skillStore.writeManagedSkill(client, { id: sk.id, ownerId: stage.runAsUserId, orgId: stage.organizationId || null,
                projectId: stage.projectId, fields: sk.fields, managedWrite });
            await journal.record('skill', { ref: sk.ref, kind: 'skill', entityId: sk.id });
        }
        for (const t of prepared.templates || []) {
            await s.templates.writeManagedTemplate(client, { id: t.id, ownerId: stage.runAsUserId, orgId: stage.organizationId || null,
                projectId: stage.projectId, fields: t.fields }, { managedWrite });
            await journal.record('template', { ref: t.ref, kind: 'document', entityId: t.id });
        }

        for (const part of prepared.parts) {
            if (!WRITE_ACTIONS.includes(part.action)) continue;
            const flip = FLIPS[part.kind];
            if (!flip) continue;
            await flip(client, part, ctx);
            await journal.record('flip', { ref: part.ref, kind: part.kind, entityId: part.entityId, afterHash: part.hash });
        }
        for (const stamp of prepared.retire || []) {
            await retirePart(client, stamp, ctx);
            await journal.record('retire', { ref: stamp.ref, kind: stamp.kind, entityId: stamp.entityId });
        }
        const steering = await s.stageStore.applySteeringValues(client, stage.projectId);
        if (steering) await journal.record('variables', { detail: { applied: steering } });

        for (const part of prepared.parts) {
            if (!part.entityId) continue;
            await s.blueprintStore.upsertStamp(client, {
                projectId: stage.projectId, ref: part.ref, kind: part.kind, entityId: part.entityId,
                installHash: part.hash, sourceHash: part.sourceHash, releaseId: prepared.release.id,
                installedVersion: Number.isInteger(prepared.release.seq) && prepared.release.seq > 0 ? prepared.release.seq : 1,
                retired: false,
            });
        }
        await tableSettings(client, { stage, prepared }, deps);
        const moved = await s.stageStore.setCurrentRelease(client, {
            stageProjectId: stage.projectId, releaseId: prepared.release.id, releaseSeq: prepared.release.seq,
            expectedReleaseId: deployment.fromReleaseId || null, expectedSettingsVersion: deployment.stageSettingsVersion,
        });
        if (!moved) throw planStale({ why: 'stage_moved' });
        const row = await toConverging(client, s, deployment);
        if (typeof deps.beforeTables === 'function') await deps.beforeTables(client);
        await commitTables(client, { stage, prepared, journal }, deps);
        return row;
    });
}

/**
 * The commit of a `settings` deployment: the CAS on settings_version and the
 * gate settings, in one transaction with the move to `converging`.
 */
async function commitSettings({ deployment, stage }, deps = {}) {
    const s = storesOf(deps);
    return s.withTransaction(async (client) => {
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        await client.query(stageLockSql, [stage.projectId]);
        try {
            await s.stageStore.updateStageSettings(stage.projectId, deployment.stageSettingsVersion, deployment.settingsPatch || {}, { client });
        } catch (err) {
            if (err && err.code === 'settings_stale') throw planStale({ why: 'settings_changed' });
            throw err;
        }
        await makeJournal(s.stageStore, deployment.id, 'commit', { client })
            .record('settings', { detail: { keys: Object.keys(deployment.settingsPatch || {}).sort() } });
        return toConverging(client, s, deployment);
    });
}

module.exports = { commit, commitSettings, buildStageTables, stageMigrationPlan, lockAndCas, toConverging, planStale, UNPUBLISH_SQL };
