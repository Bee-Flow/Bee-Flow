/**
 * Apply a proposal that creates tables.
 *
 * In a preview the assistant only STAGES a new table (builderTools/
 * pendingDatatables): the proposal carries it as `pendingDatatables`, and the
 * staged steps point at "pending:<n>". Pressing Apply is the one act that
 * creates them, and this module does it, in this order, so that every failure
 * leaves something a retry can finish and nothing a stranger could trip over:
 *
 *   1. the proposal must still be current (the flow it was staged against is
 *      unchanged) - checked BEFORE anything is created;
 *   2. the proposal is CLAIMED with a compare-and-set write (a lease of two
 *      minutes), so a double click or a second tab cannot create tables twice;
 *   3. the access rules of POST /api/datatables are checked (scope,
 *      manage_datatables, organisation, training, quota);
 *   4. each table is created in order. Before the create, the table's KEY is
 *      reserved in the proposal (`applyKey`), and the create asks for exactly
 *      that key: a retry after a crash between "created" and "recorded" finds
 *      its own table by that key (same owner, same name) and adopts it instead
 *      of creating a second one;
 *   5. the staged ids are swapped for the real ones in the definition, which
 *      goes back to the client to save (the client owns the flow save);
 *   6. the proposal is cleared and the outcome recorded.
 *
 * A failure part way keeps the proposal and what was created (`createdId`), so
 * Apply can simply be pressed again. Discard never creates anything; it only
 * reports tables an earlier failed Apply had already made (`keptDatatables`)
 * and never deletes them.
 *
 * Every dependency is injected, so the flow is testable without a database.
 */

'use strict';

const { randomUUID } = require('node:crypto');
const { HttpError } = require('../../../core/http/errors');
const { pendingProposal } = require('./workMode');
const { rebindPendingDatatables, collectPendingRefs } = require('../../../automation/builderTools/pendingDatatables');

const CLAIM_LEASE_MS = 120000;
const APPROVED_CAP = 200;

function defaultDeps() {
    return {
        automationStore: require('../../../stores/automationStore'),
        listDatatablesForScope: (scope) => require('../../../stores/datatableStore').listDatatablesForScope(scope),
        assertDatatableQuota: (...a) => require('../../../core/dataEngine/datatableLimits').assertDatatableQuota(...a),
        checkDatatableCreate: (...a) => require('../../../automation/builderTools/datatableCreateAccess').checkDatatableCreate(...a),
        createPendingDatatable: (...a) => require('../../../automation/builderTools/datatableCreate').createPendingDatatable(...a),
        keyFromTitle: (...a) => require('../../../core/dataEngine/sources/mirror/keys').keyFromTitle(...a),
        emptyDefinition: () => require('../../../automation/builderTools/draftGraph').emptyDefinition(),
        log: require('../../../telemetry/log'),
        now: () => Date.now(),
        uuid: randomUUID,
    };
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * @param {{ req: object, automationId: string, userId: string, snapshot: object }} p
 *   `snapshot` is the stored session, whose proposal has pendingDatatables.
 * @returns {Promise<{ ok: true, outcome: 'applied', definition: object, createdDatatables: Array<{ref,id,key,name}> }>}
 * @throws {HttpError}
 */
async function applyPendingDatatables({ req, automationId, userId, snapshot }, deps = {}) {
    const d = { ...defaultDeps(), ...deps };
    const { automationStore, log } = d;
    const p = snapshot.proposal;
    let snap = snapshot;
    let version = snapshot.version;

    // A compare-and-set write of the whole snapshot; every write below moves
    // `snap` and `version` forward, so the next one expects this one.
    const save = async (next) => {
        const res = await automationStore.setBuilderSession(automationId, userId, next, { expectedVersion: version });
        if (!res || !res.ok) throw new HttpError(409, 'apply_in_progress', 'This proposal is already being applied, or the builder session changed. Reload and try again.');
        snap = res.snapshot || { ...next, version: (version || 0) + 1 };
        version = snap.version;
        return snap;
    };
    const withProposal = (patch) => ({ ...snap, proposal: { ...snap.proposal, ...patch } });
    // Best effort: a lost claim is released by its lease anyway.
    const release = async () => {
        try { if (snap.proposal) await save(withProposal({ applying: null })); }
        catch (e) { log.warn(`[AutomationBuilder] apply: releasing the claim failed (automation ${automationId}): ${e.message}`); }
    };
    const fail = async (status, code, message) => {
        await release();
        return new HttpError(status, code, message);
    };

    // ── 1. still current? Nothing has been created yet. ──
    const automation = await automationStore.getAutomation(automationId);
    if (!automation || automation.userId !== userId) throw new HttpError(404, 'not_found', 'Automation not found');
    const live = automation.definition && Object.keys(automation.definition).length ? automation.definition : d.emptyDefinition();
    if (!pendingProposal(p, live)) {
        throw new HttpError(409, 'stale_proposal', 'The flow has changed since this proposal. Ask the assistant for an updated proposal.');
    }

    // ── 2. claim ──
    if (p.applying && d.now() - Date.parse(p.applying.at) < CLAIM_LEASE_MS) {
        throw new HttpError(409, 'apply_in_progress', 'This proposal is already being applied.');
    }
    await save(withProposal({ applying: { token: d.uuid(), at: new Date(d.now()).toISOString() } }));

    // ── 3. access and quota ──
    const access = await d.checkDatatableCreate({ userId, req, automationOrgId: automation.organizationId || null });
    if (!access.ok) throw await fail(access.status, access.code, access.message);
    const entries = structuredClone(snap.proposal.pendingDatatables || []);
    const toCreate = entries.filter((e) => !e.createdId).length;
    if (toCreate) {
        try { await d.assertDatatableQuota(access.scope, { addTables: toCreate }); }
        catch (err) { throw await fail(409, 'datatable_quota', err.message); }
    }

    // ── 4. create, in order ──
    const persistEntries = () => save(withProposal({ pendingDatatables: entries }));
    for (const entry of entries) {
        if (entry.createdId) continue;
        const inScope = async () => (await d.listDatatablesForScope(access.scope)) || [];
        const adoptByKey = (tables) => {
            const hit = tables.find((t) => t && t.key === entry.applyKey);
            if (!hit) return 'free';
            if (hit.ownerUserId === userId && sameName(hit.name, entry.name)) {
                entry.createdId = hit.id; entry.createdKey = hit.key;
                return 'adopted';
            }
            entry.applyKey = null;   // someone else's table: reserve another key
            return 'taken';
        };
        let tables = await inScope();
        if (entry.applyKey && adoptByKey(tables) === 'adopted') { await persistEntries(); continue; }
        if (!entry.applyKey) {
            entry.applyKey = d.keyFromTitle(entry.key, 0, new Set(tables.map((t) => t && t.key).filter(Boolean)));
            // Persisted BEFORE the create: this is what lets a retry recognise its own table.
            await persistEntries();
        }
        const r = await d.createPendingDatatable(userId, entry, { key: entry.applyKey, principal: access.principal, hasManage: access.hasManage });
        if (r && r.ok) {
            entry.createdId = r.table.id; entry.createdKey = r.table.key;
            await persistEntries();
            continue;
        }
        if (r && r.code === 'key_taken') {
            tables = await inScope();
            if (adoptByKey(tables) === 'adopted') { await persistEntries(); continue; }
            // Not ours after all: drop the reservation so a retry picks another key.
            entry.applyKey = null;
            await persistEntries();
        }
        // Ids only: the driver's text can carry names and values.
        log.warn(`[AutomationBuilder] apply: creating a table failed (automation ${automationId}, ${entry.ref}, code ${r && r.code}): ${r && r.error}`);
        const code = r && r.code;
        if (code === 'manage_datatables_required') throw await fail(403, code, 'You may not create organisation tables.');
        if (code === 'schema_invalid') throw await fail(422, code, `The columns of the table "${entry.name}" are not valid, so nothing was applied. Ask the assistant to fix the table.`);
        if (code === 'quota') throw await fail(409, 'datatable_quota', (r && r.error) || 'The workspace is at its table limit.');
        throw await fail(409, 'datatable_create_failed', `The table "${entry.name}" could not be created. Nothing was applied; press Apply again or ask the assistant.`);
    }

    // ── 5. rebind ──
    const created = entries.map((e) => ({ ref: e.ref, id: e.createdId, key: e.createdKey, name: e.name }));
    const map = new Map(created.map((c) => [c.ref, { id: c.id, key: c.key }]));
    const { definition, unknownRefs } = rebindPendingDatatables(p.definition, map);
    if (unknownRefs.length || collectPendingRefs(definition).size) {
        throw await fail(409, 'proposal_inconsistent', 'This proposal points at a table that is not part of it. Ask the assistant for an updated proposal.');
    }

    // ── 6. clear the proposal, record the outcome ──
    const outcome = { kind: 'proposal', id: p.id, status: 'applied', at: new Date(d.now()).toISOString(), datatables: created };
    const finalOf = (base) => ({
        ...base, proposal: null, reviewOutcome: outcome,
        approvedDatatableIds: [...new Set([...(base.approvedDatatableIds || []), ...created.map((c) => c.id)])].slice(-APPROVED_CAP),
    });
    try {
        await save(finalOf(snap));
    } catch (e) {
        // Someone wrote in between (a chat turn). Look once more: if it is still
        // this proposal, write again; otherwise the tables exist and the client
        // saves the flow, which is all that matters.
        const cur = await automationStore.getBuilderSession(automationId, userId).catch(() => null);
        if (cur && cur.proposal && cur.proposal.id === p.id) {
            version = cur.version;
            try { await save(finalOf(cur)); } catch (e2) { log.warn(`[AutomationBuilder] apply: recording the outcome failed twice (automation ${automationId}): ${e2.message}`); }
        } else {
            log.warn(`[AutomationBuilder] apply: the session changed while applying (automation ${automationId}); tables exist, outcome not recorded.`);
        }
    }
    return { ok: true, outcome: 'applied', definition, createdDatatables: created };
}

/** The tables an earlier failed Apply had already created, for a proposal being discarded. */
function keptDatatables(proposal) {
    return (Array.isArray(proposal?.pendingDatatables) ? proposal.pendingDatatables : [])
        .filter((e) => e && e.createdId)
        .map((e) => ({ id: e.createdId, name: e.name }));
}

module.exports = { applyPendingDatatables, keptDatatables, CLAIM_LEASE_MS };
