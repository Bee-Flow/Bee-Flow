/**
 * A stage's bindings, written into the holes a release leaves (design 4.1).
 *
 * A pipeline capture lifts every hole out of the payload and lists it as a
 * slot (`manifest.solution.slots`, scrub.js): a connection, approver seats,
 * notification recipients, an out-of-bundle table, knowledge base or
 * template, a page slug, an integration grant, a mirror source. A stage
 * answers each slot with a `solution_bindings` row, and prepare fills the
 * holes of its copy with them, so the deployed content hash covers them.
 *
 * ── Slot grammar (what capture emits; this module reads the same names) ─────
 *
 *   connection:<cn_n>                  every http_request hole mapped to that Dev connection
 *   seats:<ref>:<stepId | address>     the WHOLE seat shape of one approval step / app action
 *   notify:<ref>                       notificationSettings recipients and Talk rooms
 *   table:<logicalKey>                 a datatable step that names the key
 *   table:<ref>:datatableId:<stepId>   …one that does not; :cacheInto:, :source:<key>, :bridgeTables:<i>
 *   kb:<ref>:<field>:<stepId|address|page|agent>
 *   doc:<ref>:<stepId>                 a fill/generate_document template
 *   slug:<ref>  grant:<ref>:<tool>  mirror:<ref>
 *
 * App holes are addressed by pointers.walkAppObjects (`obj.id` and the parent
 * key are not unique in an app definition). A connection hole needs the
 * release's slot list, because the slot is named after the Dev connection
 * (`cn_1`), not after the step.
 *
 * Only HOLES are filled: a pointer that already holds a value (an in-bundle
 * part resolved to its stage id) is never re-pointed by a binding.
 *
 * `validateBinding` is the write-time gate: another stage's or Dev's part, a
 * connection the run-as user may not use, and seats that fail the approval
 * validators are refused with 400 `binding_invalid {slot, why}`.
 */

'use strict';

const { HttpError } = require('../../core/http/errors');
const { walkAppObjects } = require('../packaging/pointers');
const { APP_SEAT_FIELDS, APP_SEAT_LISTS, AUTOMATION_SEAT_FIELDS, SEAT_SHAPE_EXTRA } = require('../packaging/scrub');
const { KIND_OF_SECTION } = require('./stagePayload');

const walkAllSteps = (definition, fn) => require('../../automation/portability').walkAllSteps(definition, fn);

/** Slot prefix → solution_bindings.kind. */
const SLOT_KINDS = Object.freeze({
    connection: 'connection', seats: 'approver_seats', notify: 'approver_seats', table: 'table',
    kb: 'knowledge_base', doc: 'document', slug: 'webpage_slug', grant: 'integration_grant', mirror: 'mirror_source',
});
const NOTIFY_EVENTS = Object.freeze(['onError', 'onApproval', 'onSuccess']);
const SEAT_RULES = Object.freeze(['all', 'first', 'quorum']);

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const uniq = (list) => [...new Set(list)];
const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());

/** The binding kind a slot name stands for, or null. */
function slotKind(slot) {
    if (!nonEmpty(slot)) return null;
    return SLOT_KINDS[slot.split(':')[0]] || null;
}

/** Bindings as a Map slot → value, from a Map, `[{slot, value}]` or `{slot: value}`. */
function bindingMap(bindings) {
    if (bindings instanceof Map) return bindings;
    const out = new Map();
    if (Array.isArray(bindings)) {
        for (const b of bindings) if (b && nonEmpty(b.slot) && b.value !== undefined && b.value !== null) out.set(b.slot, b.value);
    } else if (isObject(bindings)) {
        for (const [slot, value] of Object.entries(bindings)) if (value !== undefined && value !== null) out.set(slot, value);
    }
    return out;
}

/**
 * `["API.Example.com:443", "https://x.org/a"]` → `["api.example.com", "x.org"]`:
 * the lower-cased hostname, no scheme, no port (httpAuth compares the request
 * URL's hostname). An entry that is not a hostname makes the list invalid (null).
 */
function normalizeHosts(list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const raw of list) {
        if (!nonEmpty(raw)) return null;
        const text = raw.trim();
        let host;
        try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname.toLowerCase(); } catch { return null; }
        if (!host || !/^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/.test(host)) return null;
        out.push(host);
    }
    return uniq(out);
}

// ── Seats ────────────────────────────────────────────────────────────────────

/** The seat fields of each holder, and the policy fields that travel with them. */
const SEAT_FIELDS = Object.freeze({
    automation: Object.freeze([...AUTOMATION_SEAT_FIELDS, ...SEAT_SHAPE_EXTRA]),
    app: Object.freeze([...APP_SEAT_FIELDS, ...APP_SEAT_LISTS, ...SEAT_SHAPE_EXTRA]),
});

/**
 * Write the WHOLE seat shape of one approval into `target` (an automation
 * step's `approval` object or an app `request_approval` action): every seat
 * and policy field it had is replaced by the binding's. The gallery's
 * applyStepResolutions writes `assignee` only and stays for gallery installs.
 *
 * @param {object} target
 * @param {object} value  the seat shape (design 4.1 `seats:`)
 * @param {'automation'|'app'} [holder]
 */
function applySeatBinding(target, value, holder = 'automation') {
    if (!isObject(target) || !isObject(value)) return target;
    const fields = SEAT_FIELDS[holder] || SEAT_FIELDS.automation;
    for (const f of fields) delete target[f];
    for (const f of fields) if (value[f] !== undefined && value[f] !== null) target[f] = JSON.parse(JSON.stringify(value[f]));
    return target;
}

/** Bound user/group recipients and Talk rooms into `notificationSettings`; owner/approver stay. */
function applyNotifyBinding(definition, value) {
    if (!isObject(definition) || !isObject(value)) return;
    if (!isObject(definition.notificationSettings)) definition.notificationSettings = {};
    const settings = definition.notificationSettings;
    for (const event of NOTIFY_EVENTS) {
        const bound = isObject(value[event]) ? value[event] : null;
        if (!bound) continue;
        if (!isObject(settings[event])) settings[event] = {};
        const e = settings[event];
        const kept = (Array.isArray(e.recipients) ? e.recipients : []).filter(r => !(r && (r.type === 'user' || r.type === 'group')));
        const people = (Array.isArray(bound.recipients) ? bound.recipients : []).filter(r => r && (r.type === 'user' || r.type === 'group'));
        e.recipients = [...kept, ...people.map(r => ({ ...r }))];
        if (nonEmpty(bound.talkRoom)) e.talkRoom = bound.talkRoom.trim();
    }
}

// ── applyBindingsTo ──────────────────────────────────────────────────────────

const hole = (v) => v === undefined || v === null || v === '';
const kbIdsOf = (value) => (isObject(value) && Array.isArray(value.kbIds) ? value.kbIds.filter(nonEmpty) : []);

/** Map `<layerKey>|<stepId>` → connection slot name, from the release's slot list. */
function connectionSlotIndex(slots, ref) {
    const out = new Map();
    for (const s of Array.isArray(slots) ? slots : []) {
        if (!s || s.kind !== 'connection' || s.ref !== ref || !nonEmpty(s.slot)) continue;
        out.set(`${s.layerKey || ''}|${s.stepId || ''}`, s.slot);
    }
    return out;
}

function bindAutomation(entity, get, { slots }) {
    const ref = entity.ref;
    const definition = entity.definition;
    if (!isObject(definition)) return;
    const conn = connectionSlotIndex(slots, ref);
    walkAllSteps(definition, (step, layerKey, isTrigger) => {
        if (isTrigger || !isObject(step)) return;
        const stepId = step.id || null;
        if (step.type === 'http_request' && isObject(step.auth) && hole(step.auth.connectionId)) {
            const slot = conn.get(`${layerKey || ''}|${stepId || ''}`) || `connection:${ref}:${stepId}`;
            const v = get(slot);
            if (isObject(v) && nonEmpty(v.connectionId)) {
                step.auth.connectionId = v.connectionId;
                const hosts = normalizeHosts(v.allowedHosts);
                if (hosts && hosts.length) step.auth.allowedHosts = hosts;
            }
        }
        if (step.type === 'datatable' && hole(step.datatableId)) {
            const key = nonEmpty(step.datatableKey) ? step.datatableKey : null;
            const v = get(key ? `table:${key}` : `table:${ref}:datatableId:${stepId}`);
            if (isObject(v) && nonEmpty(v.datatableId)) step.datatableId = v.datatableId;
        }
        if (step.type === 'http_request' && isObject(step.cacheInto) && hole(step.cacheInto.datatableId)) {
            const v = get(`table:${ref}:cacheInto:${stepId}`);
            if (isObject(v) && nonEmpty(v.datatableId)) step.cacheInto.datatableId = v.datatableId;
        }
        if (step.type === 'ai_step') {
            const ids = kbIdsOf(get(`kb:${ref}:knowledgeBaseIds:${stepId}`));
            if (ids.length) step.knowledgeBaseIds = uniq([...(Array.isArray(step.knowledgeBaseIds) ? step.knowledgeBaseIds : []), ...ids]);
        }
        if (step.type === 'knowledge_write' && hole(step.knowledgeBaseId)) {
            const ids = kbIdsOf(get(`kb:${ref}:knowledgeBaseId:${stepId}`));
            if (ids.length) step.knowledgeBaseId = ids[0];
        }
        if ((step.type === 'fill_document' || step.type === 'generate_document') && hole(step.documentId)) {
            const v = get(`doc:${ref}:${stepId}`);
            if (isObject(v) && nonEmpty(v.documentId)) {
                step.documentId = v.documentId;
                if (nonEmpty(v.documentVersionId)) step.documentVersionId = v.documentVersionId;
            }
        }
        if (step.type === 'approval' && isObject(step.approval)) {
            const v = get(`seats:${ref}:${stepId}`);
            if (isObject(v)) applySeatBinding(step.approval, v, 'automation');
        }
    });
    const notify = get(`notify:${ref}`);
    if (isObject(notify)) applyNotifyBinding(definition, notify);
}

function bindApp(entity, get) {
    const ref = entity.ref;
    if (isObject(entity.definition)) {
        walkAppObjects(entity.definition, (obj, address) => {
            if (Array.isArray(obj.knowledgeBaseIds)) {
                const ids = kbIdsOf(get(`kb:${ref}:knowledgeBaseIds:${address}`));
                if (ids.length) obj.knowledgeBaseIds = uniq([...obj.knowledgeBaseIds, ...ids]);
            }
            if (obj.kind === 'request_approval') {
                const v = get(`seats:${ref}:${address}`);
                if (isObject(v)) applySeatBinding(obj, v, 'app');
            }
        });
    }
    const tables = isObject(entity.dataModel) && Array.isArray(entity.dataModel.tables) ? entity.dataModel.tables : [];
    for (const table of tables) {
        if (!isObject(table) || !isObject(table.source) || !hole(table.source.datatableId)) continue;
        const v = get(`table:${ref}:source:${table.key || table.id || null}`);
        if (isObject(v) && nonEmpty(v.datatableId)) table.source.datatableId = v.datatableId;
    }
}

function bindWebpage(entity, get, { all }) {
    const ref = entity.ref;
    if (!isObject(entity.bridgeGrants)) entity.bridgeGrants = {};
    const grants = entity.bridgeGrants;
    (Array.isArray(grants.tables) ? grants.tables : []).forEach((g, index) => {
        if (!isObject(g) || !hole(g.datatableId)) return;
        const v = get(`table:${ref}:bridgeTables:${index}`);
        if (isObject(v) && nonEmpty(v.datatableId)) g.datatableId = v.datatableId;
    });
    const ids = kbIdsOf(get(`kb:${ref}:knowledgeBaseIds:page`));
    if (ids.length) entity.knowledgeBaseIds = uniq([...(Array.isArray(entity.knowledgeBaseIds) ? entity.knowledgeBaseIds : []), ...ids]);
    const slug = get(`slug:${ref}`);
    if (isObject(slug) && nonEmpty(slug.slug)) entity.slug = slug.slug.trim().toLowerCase();
    const prefix = `grant:${ref}:`;
    for (const [slot, value] of all) {
        if (!slot.startsWith(prefix)) continue;
        const tool = slot.slice(prefix.length);
        if (!tool) continue;
        if (!Array.isArray(grants.integrations)) grants.integrations = [];
        const label = isObject(value) && nonEmpty(value.label) ? String(value.label) : null;
        const existing = grants.integrations.find(g => isObject(g) && g.tool === tool);
        if (existing) { if (label) existing.label = label; } else grants.integrations.push({ tool, ...(label ? { label } : {}) });
    }
}

function bindAgent(entity, get) {
    const ids = kbIdsOf(get(`kb:${entity.ref}:knowledge_base_ids:agent`));
    if (!ids.length) return;
    if (!isObject(entity.config)) entity.config = {};
    const list = Array.isArray(entity.config.knowledge_base_ids) ? entity.config.knowledge_base_ids : [];
    entity.config.knowledge_base_ids = uniq([...list, ...ids]);
}

function bindDatatable(entity, get) {
    const v = get(`mirror:${entity.ref}`);
    if (isObject(v)) entity.source = JSON.parse(JSON.stringify(v));
}

const BINDERS = {
    automation: bindAutomation, block: bindAutomation, app: bindApp, webpage: bindWebpage,
    agent: bindAgent, datatable: bindDatatable,
};

/**
 * Fill the holes of one bound release entity (MUTATES it) with the stage's
 * bindings. Kinds without holes (knowledge bases, skills, templates) pass
 * through unchanged.
 *
 * @param {string} kind  part kind or manifest section
 * @param {object} entity  the release entity (with `ref`), pointers already resolved
 * @param {Map|object[]|object} bindings  slot → value
 * @param {{ slots?: object[] }} [opts]  the release's `solution.slots` (needed for connections)
 * @returns {{ entity: object, applied: string[] }} the slots that were read
 */
function applyBindingsTo(kind, entity, bindings, { slots = null } = {}) {
    const k = KIND_OF_SECTION[kind] || kind;
    const all = bindingMap(bindings);
    const applied = new Set();
    const get = (slot) => {
        const value = all.get(slot);
        if (value !== undefined) applied.add(slot);
        return value;
    };
    const bind = BINDERS[k];
    if (bind && isObject(entity)) bind(entity, get, { slots, all });
    if (k === 'webpage' && isObject(entity)) for (const slot of all.keys()) if (slot.startsWith(`grant:${entity.ref}:`)) applied.add(slot);
    return { entity, applied: [...applied] };
}

// ── validateBinding ──────────────────────────────────────────────────────────

function invalid(slot, why, extra = {}) {
    return new HttpError(400, 'binding_invalid', `The setting "${slot}" cannot be used here (${why.replace(/_/g, ' ')}).`, { slot, why, ...extra });
}

const SEAT = (v) => isObject(v) && (nonEmpty(v.userId) || nonEmpty(v.groupId));
const seatOf = (v) => (nonEmpty(v.userId) ? { userId: v.userId } : { groupId: v.groupId });

/** Every seat of a shape passes the org gate (validateAssignee/validatePanel/validateStages), or the reason. */
async function seatProblem(value, ctx, v) {
    const orgId = ctx.organizationId || null;
    const owner = ctx.runAsUserId || null;
    let seats = 0;
    for (const f of ['assignee', 'escalateTo', 'finalApprover']) {
        if (value[f] === undefined || value[f] === null) continue;
        if (!SEAT(value[f])) return 'seat_invalid';
        seats += 1;
        if (!(await v.validateAssignee(seatOf(value[f]), orgId))) return 'seat_invalid';
    }
    if (value.approvers !== undefined && value.approvers !== null) {
        const list = Array.isArray(value.approvers) ? value.approvers : null;
        if (!list || !list.every(SEAT)) return 'seat_invalid';
        const kept = await v.validatePanel(list.map(seatOf), orgId);
        if (list.length && (!kept || kept.length !== new Set(list.map(s => JSON.stringify(seatOf(s)))).size)) return 'seat_invalid';
        seats += list.length;
    }
    for (const f of APP_SEAT_FIELDS) {
        if (value[f] === undefined || value[f] === null) continue;
        if (!nonEmpty(value[f])) return 'seat_invalid';
        seats += 1;
        const seat = /GroupId$/.test(f) ? { groupId: value[f] } : { userId: value[f] };
        if (!(await v.validateAssignee(seat, orgId))) return 'seat_invalid';
    }
    for (const f of APP_SEAT_LISTS) {
        if (value[f] === undefined || value[f] === null) continue;
        if (!Array.isArray(value[f]) || !value[f].every(nonEmpty)) return 'seat_invalid';
        const asSeats = value[f].map(id => (f === 'approverGroupIds' ? { groupId: id } : { userId: id }));
        const kept = await v.validatePanel(asSeats, orgId);
        if (value[f].length && (!kept || kept.length !== new Set(value[f]).size)) return 'seat_invalid';
        seats += value[f].length;
    }
    if (value.stages !== undefined && value.stages !== null) {
        if (!Array.isArray(value.stages) || !value.stages.length) return 'seat_invalid';
        const out = await v.validateStages(value.stages, orgId, owner);
        if (!out) return 'seat_invalid';
        // A stage that lost a seat (validateStages drops strangers, and falls
        // back to the owner when none is left) is a chain that is not what was asked.
        const key = (seat) => (nonEmpty(seat.userId) ? `u:${seat.userId}` : `g:${seat.groupId}`);
        for (const st of value.stages) {
            if (!isObject(st) || st.skipped) continue;
            const asked = Array.isArray(st.approvers) ? st.approvers.filter(SEAT).map(key) : [];
            const got = out.find(o => o && o.key === st.key);
            const kept = new Set(((got && got.approvers) || []).filter(SEAT).map(key));
            if (!asked.length || !asked.every(k => kept.has(k))) return 'seat_invalid';
            seats += asked.length;
        }
    }
    if (value.rule !== undefined && value.rule !== null && !SEAT_RULES.includes(value.rule)) return 'invalid_value';
    return seats ? null : 'no_seat';
}

async function notifyProblem(value, ctx, v) {
    let any = false;
    for (const key of Object.keys(value)) if (!NOTIFY_EVENTS.includes(key)) return 'invalid_value';
    for (const event of NOTIFY_EVENTS) {
        const e = value[event];
        if (e === undefined || e === null) continue;
        if (!isObject(e)) return 'invalid_value';
        if (e.talkRoom !== undefined && e.talkRoom !== null && !nonEmpty(e.talkRoom)) return 'invalid_value';
        if (nonEmpty(e.talkRoom)) any = true;
        for (const r of Array.isArray(e.recipients) ? e.recipients : []) {
            if (!isObject(r) || !['user', 'group'].includes(r.type) || !nonEmpty(r.id)) return 'invalid_value';
            any = true;
            const seat = r.type === 'group' ? { groupId: r.id } : { userId: r.id };
            if (!(await v.validateAssignee(seat, ctx.organizationId || null))) return 'seat_invalid';
        }
    }
    return any ? null : 'invalid_value';
}

async function ownedElsewhere(ids, ctx, deps) {
    if (!ctx.solutionId) return false;
    const { foreignOwners } = require('./crossStageScan');
    const owners = await foreignOwners({ solutionId: ctx.solutionId, exceptProjectId: ctx.stageProjectId || null }, deps);
    return ids.some(id => owners.has(id));
}

async function connectionProblem(value, ctx, deps) {
    if (!isObject(value) || !nonEmpty(value.connectionId)) return { why: 'invalid_value' };
    const hosts = normalizeHosts(value.allowedHosts);
    if (!hosts) return { why: 'invalid_hosts' };
    if (ctx.stage === 'prd' && !hosts.length) return { why: 'hosts_required' };
    const authorize = dep(deps, 'authorizeConnectionUse', () => require('../../stores/integrationConnectionStore').authorizeConnectionUse);
    const groupsOf = dep(deps, 'groupsOf', () => async (userId) => {
        const user = await require('../../stores/userStore').getUser(userId);
        return user ? require('../../auth/orgMembership').parseGroupIds(user).map(String) : [];
    });
    const verdict = await authorize({
        connectionId: value.connectionId, runningUserId: ctx.runAsUserId,
        runningUserOrgId: ctx.organizationId || null, runningUserGroups: await groupsOf(ctx.runAsUserId),
    });
    if (!verdict || !verdict.ok) return { why: 'connection_unusable', reason: (verdict && verdict.reason) || null };
    return { value: { connectionId: value.connectionId, allowedHosts: hosts } };
}

/**
 * Check one binding before it is stored (and again at readiness for a
 * connection). Answers the normalised `{ slot, kind, value }`; a value of
 * `null` clears the slot and is always accepted.
 *
 * @param {string} slot
 * @param {any} value
 * @param {{ stageProjectId?: string, solutionId?: string, stage?: 'uat'|'prd', runAsUserId?: string,
 *   organizationId?: string|null, deps?: object }} ctx
 * @throws {HttpError} 400 binding_invalid {slot, why}
 */
async function validateBinding(slot, value, ctx = {}) {
    const deps = ctx.deps || {};
    const kind = slotKind(slot);
    if (!kind) throw invalid(String(slot), 'unknown_slot');
    if (value === null) return { slot, kind, value: null };
    const seatValidators = () => {
        const life = () => require('../../core/automationRunner/approvalLifecycle');
        return {
            validateAssignee: dep(deps, 'validateAssignee', () => life().validateAssignee),
            validatePanel: dep(deps, 'validatePanel', () => life().validatePanel),
            validateStages: dep(deps, 'validateStages', () => life().validateStages),
        };
    };
    if (kind === 'connection') {
        const out = await connectionProblem(value, ctx, deps);
        if (out.why) throw invalid(slot, out.why, out.reason ? { reason: out.reason } : {});
        return { slot, kind, value: out.value };
    }
    if (kind === 'approver_seats') {
        if (!isObject(value)) throw invalid(slot, 'invalid_value');
        const why = slot.startsWith('notify:')
            ? await notifyProblem(value, ctx, seatValidators())
            : await seatProblem(value, ctx, seatValidators());
        if (why) throw invalid(slot, why);
        return { slot, kind, value };
    }
    if (kind === 'table' || kind === 'document') {
        const field = kind === 'table' ? 'datatableId' : 'documentId';
        if (!isObject(value) || !nonEmpty(value[field])) throw invalid(slot, 'invalid_value');
        if (await ownedElsewhere([value[field]], ctx, deps)) throw invalid(slot, 'other_stage');
        const out = { [field]: value[field] };
        if (kind === 'document' && nonEmpty(value.documentVersionId)) out.documentVersionId = value.documentVersionId;
        return { slot, kind, value: out };
    }
    if (kind === 'knowledge_base') {
        const ids = kbIdsOf(value);
        if (!ids.length) throw invalid(slot, 'invalid_value');
        if (await ownedElsewhere(ids, ctx, deps)) throw invalid(slot, 'other_stage');
        return { slot, kind, value: { kbIds: uniq(ids) } };
    }
    if (kind === 'webpage_slug') {
        const s = isObject(value) && typeof value.slug === 'string' ? value.slug.trim().toLowerCase() : '';
        if (!s || s.length > 128 || !/^[a-z0-9-]+$/.test(s)) throw invalid(slot, 'invalid_value');
        return { slot, kind, value: { slug: s } };
    }
    if (kind === 'integration_grant') {
        if (!isObject(value) || (value.label !== undefined && typeof value.label !== 'string')) throw invalid(slot, 'invalid_value');
        return { slot, kind, value: value.label ? { label: value.label } : {} };
    }
    // mirror_source: the `datatables.source` object, as the mirror engine reads it.
    if (!isObject(value)) throw invalid(slot, 'invalid_value');
    return { slot, kind, value };
}

module.exports = {
    SLOT_KINDS, slotKind, bindingMap, normalizeHosts,
    applyBindingsTo, applySeatBinding, applyNotifyBinding, validateBinding,
};
