/**
 * Every place a Solution part points at another part, in ONE list.
 *
 * ── Why a registry ──────────────────────────────────────────────────────────
 *
 * Capture turns an in-bundle pointer into `{ $ref }` (toRefs), install turns it
 * back into a real id (fromRefs), the release checks look for pointers that
 * cross from one stage into another, and the scrub nulls whatever is left over.
 * Before this module each of those wrote its own walk, and they disagreed: a
 * datatable step, a knowledge base on an ai_step or a page's table grant was
 * scrubbed on the way out but never rewritten, so a Solution that carried the
 * table still arrived with the step pointing at nothing. Four walks over the
 * same documents is four chances to forget a field; one registry is one.
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 *
 * A HOLDER is an entity-shaped payload (the live row or the manifest entry,
 * which carry the same keys):
 *
 *   automation  { definition }
 *   app         { definition, dataModel }
 *   webpage     { bridgeGrants, knowledgeBaseIds }
 *   agent       { config }          (pipeline releases only, see capture.js)
 *   skill       { knowledge_base_ids, allowed_automation_ids, automation_id }
 *
 * visitPointers hands `fn` one ptr per location:
 *   { targetKind, field, many, get(), set(v), stepId?, layerKey?, actionId?, hint? }
 * `many` marks an id LIST; get/set then read and write the whole list.
 *
 * ── Steering fields ─────────────────────────────────────────────────────────
 *
 * A second, smaller registry: the fields that decide WHERE an automation sends
 * something (an http_request's url and headers, the recipients of mail,
 * notification and integration steps, a Talk/chat send's room via the tool's
 * own destination field, webhook and callback URLs). They are
 * never rewritten. The release cut asks which `vars.<name>` appear in them,
 * because a variable that steers a request is a variable a stage editor must
 * not be able to point at another host (D18).
 */

'use strict';

const walkAllSteps = (definition, fn) => require('../../automation/portability').walkAllSteps(definition, fn);

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isRef(v) { return isObject(v) && typeof v.$ref === 'string'; }

/** Split an id list into the `$ref`s the rewrite made and the raw ids outside the bundle. */
function splitIds(list) {
    const kept = [];
    const outside = [];
    for (const v of Array.isArray(list) ? list : []) {
        if (isRef(v)) kept.push(v);
        else if (typeof v === 'string' && v) outside.push(v);
    }
    return { kept, outside };
}

/**
 * Every pointer location, as data. The tests walk this list and prove each
 * entry round-trips; a location added to a visitor without a row here (or the
 * other way round) fails them.
 */
const POINTER_LOCATIONS = Object.freeze([
    { holder: 'automation', where: 'call_block', field: 'blockId', targetKind: 'automation' },
    { holder: 'automation', where: 'datatable', field: 'datatableId', targetKind: 'datatable' },
    { holder: 'automation', where: 'http_request', field: 'cacheInto.datatableId', targetKind: 'datatable' },
    { holder: 'automation', where: 'ai_step', field: 'knowledgeBaseIds', targetKind: 'knowledgeBase', many: true },
    { holder: 'automation', where: 'ai_step', field: 'skillIds', targetKind: 'skill', many: true },
    { holder: 'automation', where: 'ai_step', field: 'agentId', targetKind: 'agent' },
    { holder: 'automation', where: 'knowledge_write', field: 'knowledgeBaseId', targetKind: 'knowledgeBase' },
    { holder: 'automation', where: 'fill_document', field: 'documentId', targetKind: 'document' },
    { holder: 'automation', where: 'generate_document', field: 'documentId', targetKind: 'document' },
    { holder: 'app', where: 'run_automation', field: 'automationId', targetKind: 'automation' },
    { holder: 'app', where: 'any object', field: 'knowledgeBaseIds', targetKind: 'knowledgeBase', many: true },
    { holder: 'app', where: 'dataModel.tables[].source', field: 'datatableId', targetKind: 'datatable' },
    { holder: 'webpage', where: 'bridgeGrants.automations[]', field: 'automationId', targetKind: 'automation' },
    { holder: 'webpage', where: 'bridgeGrants.tables[]', field: 'datatableId', targetKind: 'datatable' },
    { holder: 'webpage', where: 'bridgeGrants.agent', field: 'agentId', targetKind: 'agent' },
    { holder: 'webpage', where: 'metadata', field: 'knowledgeBaseIds', targetKind: 'knowledgeBase', many: true },
    { holder: 'agent', where: 'config', field: 'knowledge_base_ids', targetKind: 'knowledgeBase', many: true },
    { holder: 'agent', where: 'config', field: 'attachedSkillIds', targetKind: 'skill', many: true },
    { holder: 'skill', where: 'row', field: 'knowledge_base_ids', targetKind: 'knowledgeBase', many: true },
    { holder: 'skill', where: 'row', field: 'allowed_automation_ids', targetKind: 'automation', many: true },
    { holder: 'skill', where: 'row', field: 'automation_id', targetKind: 'automation' },
]);

const HOLDER_KINDS = Object.freeze([...new Set(POINTER_LOCATIONS.map(l => l.holder))]);

/** A ptr over `obj[key]`. `extra` carries where it was found. */
function slotPtr(obj, key, targetKind, field, extra = {}, many = false) {
    return {
        targetKind, field, many, ...extra,
        get: () => obj[key],
        set: (v) => { obj[key] = v; },
    };
}

/** `anchor` + path segments as `anchor.steps[2].branches[0]`; a root-relative path has no anchor. */
function formatAddress(anchor, segments) {
    let out = anchor || '';
    for (const seg of segments) {
        if (typeof seg === 'number') out += `[${seg}]`;
        else out += (out ? '.' : '') + seg;
    }
    return out || '$';
}

/**
 * Walk every object of an APP definition with a unique, stable address: the
 * nearest object at or above it that carries an `id`, plus the path from
 * there (`act_x.steps[2].branches[0].steps[0]`), or the path from the root
 * when nothing above it has one (`actions.ask`, `screens[0].sections[1].props`).
 * App action steps and component props rarely carry an id, so the key they sit
 * under ('steps', 'props') is not an address: two request_approval steps in
 * one action would share it, and a stage binding addressed by slot name could
 * not tell them apart.
 */
function walkAppObjects(node, fn, anchor = null, segments = []) {
    if (Array.isArray(node)) {
        node.forEach((item, i) => walkAppObjects(item, fn, anchor, [...segments, i]));
        return;
    }
    if (!isObject(node)) return;
    const own = typeof node.id === 'string' && node.id ? node.id : null;
    const here = own ? { anchor: own, segments: [] } : { anchor, segments };
    fn(node, formatAddress(here.anchor, here.segments));
    for (const [k, v] of Object.entries(node)) walkAppObjects(v, fn, here.anchor, [...here.segments, k]);
}

const STEP_POINTERS = {
    call_block: [['blockId', 'automation']],
    datatable: [['datatableId', 'datatable']],
    ai_step: [['knowledgeBaseIds', 'knowledgeBase', true], ['skillIds', 'skill', true], ['agentId', 'agent']],
    knowledge_write: [['knowledgeBaseId', 'knowledgeBase']],
    fill_document: [['documentId', 'document']],
    generate_document: [['documentId', 'document']],
};

function visitAutomation(payload, fn) {
    walkAllSteps(payload.definition, (step, layerKey, isTrigger) => {
        if (isTrigger) return;
        const at = { stepId: step.id || null, layerKey: layerKey || null };
        for (const [field, targetKind, many] of STEP_POINTERS[step.type] || []) {
            if (step[field] === undefined) continue;
            const hint = field === 'datatableId' && typeof step.datatableKey === 'string' ? step.datatableKey : null;
            fn(slotPtr(step, field, targetKind, field, { ...at, hint }, !!many));
        }
        if (step.type === 'http_request' && isObject(step.cacheInto) && step.cacheInto.datatableId !== undefined) {
            fn(slotPtr(step.cacheInto, 'datatableId', 'datatable', 'cacheInto.datatableId', at));
        }
    });
}

function visitApp(payload, fn) {
    walkAppObjects(payload.definition, (obj, actionId) => {
        if (obj.kind === 'run_automation' && obj.automationId !== undefined) {
            fn(slotPtr(obj, 'automationId', 'automation', 'automationId', { actionId }));
        }
        if (Array.isArray(obj.knowledgeBaseIds)) {
            fn(slotPtr(obj, 'knowledgeBaseIds', 'knowledgeBase', 'knowledgeBaseIds', { actionId }, true));
        }
    });
    const tables = isObject(payload.dataModel) && Array.isArray(payload.dataModel.tables) ? payload.dataModel.tables : [];
    for (const table of tables) {
        if (!isObject(table) || !isObject(table.source) || table.source.datatableId === undefined) continue;
        fn(slotPtr(table.source, 'datatableId', 'datatable', 'dataModel.source.datatableId',
            { tableKey: table.key || table.id || null }));
    }
}

function visitWebpage(payload, fn) {
    const grants = isObject(payload.bridgeGrants) ? payload.bridgeGrants : {};
    for (const [list, field, targetKind] of [['automations', 'automationId', 'automation'], ['tables', 'datatableId', 'datatable']]) {
        if (!Array.isArray(grants[list])) continue;
        grants[list].forEach((g, index) => {
            if (isObject(g) && g[field] !== undefined) fn(slotPtr(g, field, targetKind, `bridgeGrants.${list}.${field}`, { index }));
        });
    }
    if (isObject(grants.agent) && grants.agent.agentId !== undefined) {
        fn(slotPtr(grants.agent, 'agentId', 'agent', 'bridgeGrants.agent.agentId'));
    }
    if (Array.isArray(payload.knowledgeBaseIds)) {
        fn(slotPtr(payload, 'knowledgeBaseIds', 'knowledgeBase', 'knowledgeBaseIds', {}, true));
    }
}

function visitAgent(payload, fn) {
    const config = isObject(payload.config) ? payload.config : null;
    if (!config) return;
    for (const [field, targetKind] of [['knowledge_base_ids', 'knowledgeBase'], ['attachedSkillIds', 'skill']]) {
        if (Array.isArray(config[field])) fn(slotPtr(config, field, targetKind, `config.${field}`, {}, true));
    }
}

function visitSkill(payload, fn) {
    for (const [field, targetKind] of [['knowledge_base_ids', 'knowledgeBase'], ['allowed_automation_ids', 'automation']]) {
        if (Array.isArray(payload[field])) fn(slotPtr(payload, field, targetKind, field, {}, true));
    }
    if (payload.automation_id !== undefined) fn(slotPtr(payload, 'automation_id', 'automation', 'automation_id'));
}

const VISITORS = { automation: visitAutomation, app: visitApp, webpage: visitWebpage, agent: visitAgent, skill: visitSkill };

/** Call `fn(ptr)` for every pointer location in `payload`. Unknown holder → nothing. */
function visitPointers(holderKind, payload, fn) {
    const visit = VISITORS[holderKind];
    if (!visit || !isObject(payload)) return;
    visit(payload, fn);
}

function lookup(map, key) {
    if (!map) return undefined;
    if (map instanceof Map) return map.get(key);
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function where(ptr) {
    const out = { field: ptr.field, targetKind: ptr.targetKind };
    for (const k of ['stepId', 'layerKey', 'actionId', 'index', 'tableKey']) if (ptr[k] !== undefined && ptr[k] !== null) out[k] = ptr[k];
    return out;
}

/**
 * In-bundle ids become `{ $ref }`. Mutates; returns what it rewrote as
 * `[{ from, ref, field, targetKind, … }]`. An id with no entry in
 * `refByEntityId` is left exactly as it was: that is a hole, for the scrub.
 */
function toRefs(holderKind, payload, refByEntityId) {
    const rewritten = [];
    const asRef = (ptr, id) => {
        if (typeof id !== 'string' || !id) return id;
        const ref = lookup(refByEntityId, id);
        if (!ref) return id;
        rewritten.push({ from: id, ref, ...where(ptr) });
        return { $ref: ref };
    };
    visitPointers(holderKind, payload, (ptr) => {
        const value = ptr.get();
        if (ptr.many) {
            if (Array.isArray(value)) ptr.set(value.map(id => asRef(ptr, id)));
            return;
        }
        const next = asRef(ptr, value);
        if (next !== value) ptr.set(next);
    });
    return rewritten;
}

/**
 * `{ $ref }` back to real ids — the install direction. Mutates. A ref with no
 * entry in `idByRef` becomes null (a scalar) or leaves its list, and is named
 * in `unresolved`: a dangling id with a plausible shape is worse than an empty
 * pointer the editor can ask about.
 */
function fromRefs(holderKind, payload, idByRef) {
    const resolved = [];
    const unresolved = [];
    const resolve = (ptr, value) => {
        if (!isRef(value)) return { keep: true, value };
        const id = lookup(idByRef, value.$ref);
        if (id === undefined || id === null) { unresolved.push({ ref: value.$ref, ...where(ptr) }); return { keep: false, value: null }; }
        resolved.push({ ref: value.$ref, to: id, ...where(ptr) });
        return { keep: true, value: id };
    };
    visitPointers(holderKind, payload, (ptr) => {
        const value = ptr.get();
        if (ptr.many) {
            if (!Array.isArray(value)) return;
            const out = [];
            for (const v of value) { const r = resolve(ptr, v); if (r.keep) out.push(r.value); }
            ptr.set(out);
            return;
        }
        const r = resolve(ptr, value);
        if (isRef(value)) ptr.set(r.value);
    });
    return { resolved, unresolved };
}

// ── Steering fields (D18) ─────────────────────────────────────────────────

/** Keys that name WHO a message goes to. Matched on step fields and step inputs. */
const RECIPIENT_KEY = /^(to|cc|bcc|recipients?|recipientEmails?|toEmails?|toAddress(es)?|replyTo|reply_to|emails?|attendees)$/i;
/** Keys that name WHERE a callback is sent. Matched on every step. */
const CALLBACK_KEY = /^(webhook|callback)_?url$/i;
/** Step types whose recipient fields steer: mail, notification and integration steps. */
const RECIPIENT_STEP = /mail|notif|integration|message|talk/i;

/**
 * Destinations whose input name is too generic for RECIPIENT_KEY (`token` is
 * a credential everywhere else), keyed by the integration tool that sends.
 * Taken from the tools' own schemas: nextcloudTalkTools (`token` = the room),
 * nextcloudNotificationsTools (`userId`), googleGroupsTools (`groupEmail`),
 * signrequestTools (`signers[].email`).
 */
const TOOL_DESTINATION_FIELDS = Object.freeze({
    nextcloud_talk_send_message: Object.freeze(['token']),
    nextcloud_notifications_send: Object.freeze(['userId']),
    groups_reply: Object.freeze(['groupEmail']),
    signrequest_send_document: Object.freeze(['signers']),
});
/**
 * A chat/Talk send the table above does not know yet: its room or channel
 * steers. Matched on the tool name, so a new Talk-like sender is covered by
 * the rule written before it existed.
 */
const CHAT_SEND_TOOL = /(talk|chat|teams|slack|channel).*(send|post|reply)|(send|post|reply).*(talk|chat|teams|slack|channel)/i;
const CHAT_DESTINATION_KEY = /^(token|room|roomToken|roomId|chatId|channel|channelId|conversationId|groupEmail)$/i;

function toolDestinationKeys(step) {
    const tool = typeof step.tool === 'string' ? step.tool : (typeof step.toolName === 'string' ? step.toolName : '');
    const listed = new Set(TOOL_DESTINATION_FIELDS[tool] || []);
    const chat = tool && CHAT_SEND_TOOL.test(tool);
    return (key) => listed.has(key) || (chat && CHAT_DESTINATION_KEY.test(key));
}

const STEERING_FIELDS = Object.freeze([
    Object.freeze({ stepTypes: ['http_request'], fields: ['url', 'headers'] }),
    Object.freeze({ stepTypes: RECIPIENT_STEP.source, fields: RECIPIENT_KEY.source, in: ['step', 'step.inputs'] }),
    Object.freeze({ stepTypes: '*', fields: CALLBACK_KEY.source, in: ['step', 'step.inputs'] }),
    Object.freeze({ stepTypes: RECIPIENT_STEP.source, tools: TOOL_DESTINATION_FIELDS, toolPattern: CHAT_SEND_TOOL.source, fields: CHAT_DESTINATION_KEY.source, in: ['step.inputs'] }),
]);

/** Call `fn({ stepId, layerKey, stepType, field, value })` for every steering field. */
function visitSteeringFields(definition, fn) {
    walkAllSteps(definition, (step, layerKey, isTrigger) => {
        if (isTrigger) return;
        const at = { stepId: step.id || null, layerKey: layerKey || null, stepType: step.type || null };
        if (step.type === 'http_request') {
            for (const field of ['url', 'headers']) if (step[field] !== undefined) fn({ ...at, field, value: step[field] });
        }
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a constant alternation of literals, no repeat: linear
        const recipients = RECIPIENT_STEP.test(String(step.type || ''));
        const destination = recipients ? toolDestinationKeys(step) : () => false;
        for (const [prefix, bag] of [['', step], ['inputs.', isObject(step.inputs) ? step.inputs : {}]]) {
            for (const [key, value] of Object.entries(bag)) {
                if (prefix === '' && step.type === 'http_request' && (key === 'url' || key === 'headers')) continue;
                // `token` on the step itself is never a destination; only the tool's inputs are.
                const toolField = prefix !== '' && destination(key);
                if (CALLBACK_KEY.test(key) || (recipients && RECIPIENT_KEY.test(key)) || toolField) fn({ ...at, field: prefix + key, value });
            }
        }
    });
}

/**
 * `vars.<name>` as a whole token: not `myvars.x`, not `steps.vars.x`. Also
 * the bracket spelling `vars['x']`.
 */
const VARS_TOKEN = /(?<![\w$.])vars(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;

function collectVarNames(value, into) {
    if (typeof value === 'string') {
        for (const m of value.matchAll(VARS_TOKEN)) into.add(m[1] || m[2]);
        return;
    }
    if (Array.isArray(value)) { for (const v of value) collectVarNames(v, into); return; }
    if (isObject(value)) for (const v of Object.values(value)) collectVarNames(v, into);
}

/** The names of every variable that appears in a steering field of `definition`. */
function variablesInSteeringFields(definition) {
    const names = new Set();
    visitSteeringFields(definition, ({ value }) => collectVarNames(value, names));
    return names;
}

// ── Destinations a pipeline release lifts into slots (scrub.js) ─────────

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

const NOTIFY_EVENTS = ['onError', 'onApproval', 'onSuccess'];

/**
 * User/group recipients and Talk rooms of `notificationSettings`; owner/approver
 * stay. Returns `{ onError?, onApproval?, onSuccess? }`, each `{ recipients?,
 * talkRoom? }` (design 4.1). The room is per event: `talkRoom`, or the
 * pre-handoff-5 `ncTalkRoom` that notificationDefaults and approvalDelivery
 * still read as a fallback. Both keys leave the event (mutates), or an automation saved
 * before handoff 5 would post into Dev's room from every stage.
 */
function liftNotify(settings) {
    if (!isObject(settings)) return null;
    const lifted = {};
    for (const event of NOTIFY_EVENTS) {
        const e = isObject(settings[event]) ? settings[event] : null;
        if (!e) continue;
        const people = (Array.isArray(e.recipients) ? e.recipients : []).filter(r => r?.type === 'user' || r?.type === 'group');
        const out = people.length ? { recipients: people } : {};
        if (people.length) e.recipients = e.recipients.filter(r => !people.includes(r));
        const room = nonEmpty(e.talkRoom) ? e.talkRoom : (nonEmpty(e.ncTalkRoom) ? e.ncTalkRoom : null);
        if (room) { out.talkRoom = room.trim(); delete e.talkRoom; delete e.ncTalkRoom; }
        if (Object.keys(out).length) lifted[event] = out;
    }
    return Object.keys(lifted).length ? lifted : null;
}

/**
 * The host a Dev step's LITERAL url names (`api.example.com`), or null when the
 * url is built from a template, an expression or a variable: then there is no
 * Dev host to suggest and the stage binding must name one itself (D18).
 */
function literalUrlHost(url) {
    const raw = typeof url === 'string' ? url
        : (isObject(url) && url.kind === 'literal' && typeof url.value === 'string' ? url.value : null);
    if (!raw || raw.includes('{{')) return null;
    try {
        const parsed = new URL(raw.trim());
        return /^https?:$/.test(parsed.protocol) && parsed.hostname ? parsed.hostname : null;
    } catch { return null; }
}

module.exports = {
    POINTER_LOCATIONS, HOLDER_KINDS, STEERING_FIELDS,
    visitPointers, toRefs, fromRefs, walkAppObjects, isRef, splitIds,
    visitSteeringFields, variablesInSteeringFields, liftNotify, literalUrlHost,
};
