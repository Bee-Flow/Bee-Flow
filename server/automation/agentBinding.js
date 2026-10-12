/**
 * Which agents may call an `agent_call` automation, and who may say so.
 *
 * Binding an automation to an agent gives the AGENT the right to call it: anyone
 * who may chat with that agent can have the agent start the automation, without
 * run rights of their own on it. The run still executes as the automation's
 * OWNER (their connections, no service account) and records who asked
 * (startedByUserId) and which agent (callerAgentId). That is a real grant, so
 * every rule about it sits in this one module:
 *
 *   WRITE   setAgentBindings is the only gate. The caller needs EDIT on the
 *           automation AND EDIT on every agent they add or remove, and the
 *           automation's OWNER must be allowed to use that agent: an admin
 *           cannot mint a grant the owner never could have made.
 *   READ    describeBindings is what the trigger panel shows: names only for
 *           agents the viewer may edit, an anonymous "another agent" for the
 *           rest.
 *   RUN     agentMayCall is the dispatch-time check, unconditional and
 *           independent of which tools were offered earlier.
 *
 * The rows are in automation_agent_bindings (stores/automationStore/
 * agentBindings.js), deliberately not in the definition: nothing that copies a
 * definition (duplicate, import, template, version restore, packaging) can copy
 * a grant along with it.
 *
 * ── ONE ANSWER FOR "NOT YOURS" ──────────────────────────────────────
 * An agent id that does not exist and one the caller may not edit are refused
 * with the same code, in the same words, so this endpoint is not an oracle for
 * agents in other workspaces. Only once the caller may edit the agent does the
 * next refusal ("the owner cannot use it") say anything about it.
 *
 * ── FAIL CLOSED ─────────────────────────────────────────────────────
 * Unlike the save-time agent catalog (agentCatalog.js, fail-open because the
 * run is the real gate), here the run IS the gate: a lookup that throws means
 * "not allowed", never "allowed".
 *
 * Every dependency is injectable (`deps`) and defaults to the real one,
 * required lazily, so a test hands in its own and the module loads without a
 * database.
 */

'use strict';

const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');
const { roleSatisfies, groupsOf } = require('./access');
const { mayAutomationUseAgent } = require('./agentCatalog');

/** More than this on one automation is a mistake, not a design. */
const MAX_BINDINGS = 50;
/** The picker never needs more rows than this. */
const MAX_CANDIDATES = 200;

const NOT_LINKABLE = 'You cannot link this automation to that agent.';

/** The code a refused call carries; the model reads it, so it names no agent. */
const NOT_ALLOWED_CODE = 'agent_not_allowed';

/**
 * The dependencies with their real defaults. Getters, not values, so a module
 * is only loaded when something asks for it (a test that never reaches the agent
 * store never loads it).
 */
function realDeps(deps = {}) {
    return {
        get store() { return deps.store || deps.automationStore || require('../stores/automationStore'); },
        get agentStore() { return deps.agentStore || require('../stores/agentStore'); },
        get userStore() { return deps.userStore || require('../stores/userStore'); },
        get access() { return deps.access || require('./access'); },
        get agentAccess() { return deps.agentAccess || require('../agents/agentAccess').defaultAgentAccess(); },
    };
}

/**
 * The identity the RUN measures an agent against: the automation owner, their
 * current organisation and groups (the same reading agentCatalogForOwner and
 * the AI step make). Null when it cannot be read.
 *
 * @returns {Promise<{ userId: string, orgId: string|null, groups: string[] }|null>}
 */
async function ownerIdentityOf(ownerId, deps = {}) {
    if (!ownerId) return null;
    try {
        const userStore = deps.userStore || require('../stores/userStore');
        const owner = await userStore.getUser(ownerId);
        if (!owner) return null;
        return { userId: ownerId, orgId: owner.organizationId || null, groups: groupsOf(owner) };
    } catch (e) {
        log.warn(`[automation agent binding] owner identity unreadable for ${ownerId}: ${e.message}`);
        return null;
    }
}

/**
 * May the automation's OWNER use this agent (owns it, or it is published to
 * their organisation and groups)? The question mayAutomationUseAgent answers
 * for a save and the AI step answers per run, asked here for a grant. A missing
 * agent, an unreadable owner or a failed lookup is false.
 *
 * `identity` is a prefetched ownerIdentityOf result, so a list of agents costs
 * one owner read.
 */
async function ownerMayUseAgent(ownerId, agentId, { deps = {}, identity, agent } = {}) {
    if (!ownerId || !agentId) return false;
    try {
        const agentStore = deps.agentStore || require('../stores/agentStore');
        const row = agent || await agentStore.getForRuntime(agentId);
        if (!row) return false;
        const who = identity !== undefined ? identity : await ownerIdentityOf(ownerId, deps);
        if (!who) return false;
        return mayAutomationUseAgent(row, who) === true;
    } catch (e) {
        log.warn(`[automation agent binding] agent check failed for ${agentId}: ${e.message}`);
        return false;
    }
}

/** Does this automation declare itself an agent tool (in its working copy or the one that runs live)? */
function declaresAgentCall(automation) {
    if (!automation) return false;
    const working = automation.definition && automation.definition.trigger;
    if (working && working.kind === 'agent_call') return true;
    const { definitionForRun } = require('../core/automationRunner/definitionForRun');
    const live = definitionForRun(automation, { mode: 'live' }).definition;
    return !!(live && live.trigger && live.trigger.kind === 'agent_call');
}

/** The tool name the agent sees for an automation (its trigger's, else automation_<id>). */
function toolNameOf(automation) {
    const { automationToTool } = require('./agentCallableTools');
    const tool = automationToTool(automation);
    return tool ? tool.function.name : null;
}

function normaliseAgentIds(agentIds) {
    if (!Array.isArray(agentIds)) {
        throw new HttpError(400, 'agent_bindings_invalid', 'agentIds is the list of agents, [] for none.');
    }
    const out = [];
    for (const id of agentIds) {
        if (typeof id !== 'string' || !id.trim() || id.length > 200) {
            throw new HttpError(400, 'agent_bindings_invalid', 'agentIds holds the ids of agents.');
        }
        if (!out.includes(id.trim())) out.push(id.trim());
    }
    if (out.length > MAX_BINDINGS) {
        throw new HttpError(400, 'agent_bindings_invalid', `At most ${MAX_BINDINGS} agents can call one automation.`);
    }
    return out;
}

/**
 * Another automation bound to this agent already answers to the same tool
 * name. The agent runtime keeps the FIRST tool of a name and silently drops
 * the rest, so the second automation would never be called; refuse it here, where
 * the author can still rename it.
 */
async function toolNameTaken({ automation, agentId, store }) {
    const mine = toolNameOf(automation);
    if (!mine) return false;
    const { automationForRun } = require('../core/automationRunner/definitionForRun');
    const { automationToTool } = require('./agentCallableTools');
    const others = await store.listAutomationsBoundToAgent(agentId);
    return others.some((other) => {
        if (!other || other.id === automation.id) return false;
        const tool = automationToTool(automationForRun(other, { mode: 'live' }));
        return !!tool && tool.function.name === mine;
    });
}

/**
 * THE write gate: make `agentIds` the set of editable agents bound to this
 * automation.
 *
 * The list means "the agents the caller can edit that should be linked". A
 * binding to an agent the caller cannot edit is neither shown to them nor
 * touched by this call: taking an agent's access away, like handing it out,
 * needs edit rights on that agent as well as on the automation.
 *
 * @param {object} p
 * @param {object} p.automation  a store row (rowToAutomation shape)
 * @param {string[]} p.agentIds
 * @param {string} p.actorId     the person (or builder session) asking
 * @param {object|null} [p.session]
 * @param {object} [p.deps]
 * @returns {Promise<{ bindings: Array, added: string[], removed: string[], kept: number }>}
 * @throws {HttpError}
 */
async function setAgentBindings({ automation, agentIds, actorId, session = null, deps = {} }) {
    const d = realDeps(deps);
    const wanted = normaliseAgentIds(agentIds);
    if (!automation || !actorId) throw new HttpError(404, 'not_found', 'Not found');

    const { role } = await d.access.roleFor(automation, actorId, { session });
    if (!roleSatisfies(role, 'edit')) {
        log.info(`[automation agent binding] refused automation=${automation.id} actor=${actorId} reason=no_automation_edit`);
        throw new HttpError(403, 'automation_forbidden', 'You need edit rights on this automation to link agents to it.');
    }
    if ((automation.kind || 'automation') !== 'automation') {
        throw new HttpError(400, 'not_an_automation', 'Only an automation can be linked to an agent.');
    }

    const current = await d.store.listBindingsForAutomation(automation.id);
    const currentIds = current.map((b) => b.agentId);
    const toAdd = wanted.filter((id) => !currentIds.includes(id));
    const toDrop = currentIds.filter((id) => !wanted.includes(id));

    if (toAdd.length && !declaresAgentCall(automation)) {
        throw new HttpError(409, 'not_agent_call', 'Set the trigger to "Agent tool" and save before linking agents.');
    }

    // The caller needs a request-shaped object for the agent edit gate (it reads
    // the session for the super-admin flag and the org memberships).
    const req = { session: session || { user: { id: actorId } } };
    const editCtx = await d.agentAccess.buildCanModifyContext(actorId, req);
    const ownerIdentity = await ownerIdentityOf(automation.userId, d);

    const mayEdit = async (agent) => !!agent && await d.agentAccess.canModifyAgent(agent, actorId, req, editCtx);

    for (const agentId of toAdd) {
        let agent = null;
        try { agent = await d.agentStore.getForRuntime(agentId); }
        catch (e) {
            log.warn(`[automation agent binding] agent ${agentId} could not be read: ${e.message}`);
            throw new HttpError(503, 'agent_lookup_failed', 'The agent could not be checked just now. Try again.');
        }
        if (!(await mayEdit(agent))) {
            log.info(`[automation agent binding] refused automation=${automation.id} agent=${agentId} actor=${actorId} reason=no_agent_edit`);
            throw new HttpError(403, 'agent_not_linkable', NOT_LINKABLE);
        }
        if (!(await ownerMayUseAgent(automation.userId, agentId, { deps: d, identity: ownerIdentity, agent }))) {
            log.info(`[automation agent binding] refused automation=${automation.id} agent=${agentId} actor=${actorId} reason=owner_cannot_use`);
            throw new HttpError(403, 'agent_owner_cannot_use', 'The owner of this automation cannot use that agent, so the agent cannot call it for them. Publish the agent, or pick one the owner can use.');
        }
        if (await toolNameTaken({ automation, agentId, store: d.store })) {
            throw new HttpError(409, 'tool_name_taken', 'Another automation linked to that agent already uses this tool name. Rename the tool first.');
        }
    }

    const removable = [];
    let kept = 0;
    for (const agentId of toDrop) {
        let agent = null;
        try { agent = await d.agentStore.getForRuntime(agentId); }
        catch (_) { kept += 1; continue; }
        // An agent that no longer exists has nobody left to edit it: whoever may
        // edit the automation can clear the dead row.
        if (!agent || await mayEdit(agent)) removable.push(agentId);
        else kept += 1;
    }

    const bindings = (toAdd.length || removable.length)
        ? await d.store.applyAgentBindings(automation.id, { add: toAdd, remove: removable }, actorId)
        : current;

    for (const agentId of toAdd) {
        log.info(`[automation agent binding] bound automation=${automation.id} agent=${agentId} actor=${actorId}`);
    }
    for (const agentId of removable) {
        log.info(`[automation agent binding] unbound automation=${automation.id} agent=${agentId} actor=${actorId}`);
    }
    return { bindings, added: toAdd, removed: removable, kept };
}

/**
 * The agents the viewer may pick: the ones they can edit AND the owner may
 * use. Their own agents plus the published ones their organisation and groups
 * show them (the same two lists the AI step's picker draws from).
 */
async function candidateAgentsFor({ automation, viewerId, session, deps }) {
    const viewer = await deps.userStore.getUser(viewerId);
    if (!viewer) throw new Error('viewer unreadable');
    const isSuperAdmin = !!(session && (session.isAdmin || (session.user && session.user.role === 'admin')));
    const [mine, published] = await Promise.all([
        deps.agentStore.getAgents(viewerId),
        isSuperAdmin
            ? deps.agentStore.getPublishedAgents()
            : deps.agentStore.getPublishedAgentsForUser(groupsOf(viewer), viewer.organizationId || null, null),
    ]);
    const req = { session: session || { user: { id: viewerId } } };
    const editCtx = await deps.agentAccess.buildCanModifyContext(viewerId, req);
    const ownerIdentity = await ownerIdentityOf(automation.userId, deps);

    const seen = new Set();
    const out = [];
    for (const agent of [...(mine || []), ...(published || [])]) {
        if (!agent || typeof agent.id !== 'string' || seen.has(agent.id)) continue;
        seen.add(agent.id);
        // The product's own agents are nobody's to link.
        if (agent.owner_id === 'system' || agent.owner_id === 'swarm') continue;
        if (!(await deps.agentAccess.canModifyAgent(agent, viewerId, req, editCtx))) continue;
        if (!(await ownerMayUseAgent(automation.userId, agent.id, { deps, identity: ownerIdentity, agent }))) continue;
        out.push({ id: agent.id, name: agent.name || agent.id, description: typeof agent.description === 'string' ? agent.description : null });
        if (out.length >= MAX_CANDIDATES) break;
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

/**
 * The agent curates its automations and leaves this one out, so being linked is
 * not enough: the offer and the dispatch both want the grant too. True means
 * "linked but never offered", which the trigger panel says out loud. Null when
 * the config could not be read (not the same as granted).
 */
function notGrantedBy(agent, automationId, deps) {
    try {
        const { curated, grants } = curationOf(agent.config, deps);
        if (!curated) return false;
        return !grants || !Object.prototype.hasOwnProperty.call(grants, automationId);
    } catch (_) { return null; }
}

/**
 * The automations linked to one agent, for the agent editor (which marks a
 * granted automation that is not linked as never offered). Only for a viewer who
 * may edit the agent; anyone else, and an agent that does not exist, get the
 * same null, so this is no oracle for agents in other workspaces.
 *
 * @returns {Promise<string[]|null>}
 */
async function linkedAutomationIds({ agentId, viewerId, session = null, deps = {} }) {
    const d = realDeps(deps);
    if (!agentId || !viewerId) return null;
    const agent = await d.agentStore.getForRuntime(agentId);
    const req = { session: session || { user: { id: viewerId } } };
    if (!agent || !(await d.agentAccess.canModifyAgent(agent, viewerId, req))) return null;
    const bound = await d.store.listAutomationsBoundToAgent(agentId);
    return bound.map((a) => a.id);
}

/**
 * What the trigger panel shows for this viewer.
 *
 *   bindings    every linked agent. One the viewer may edit carries its id,
 *               name, whether the owner can still use it and whether the agent
 *               leaves the automation out of its own list (`notGranted`); any other is
 *               `{ agentId: null, canEdit: false }`, "another agent", no name.
 *   candidates  what the viewer may add (null = could not be read)
 *   canManage   the viewer may edit the automation at all
 *
 * @returns {Promise<{ bindings: Array, candidates: Array|null, candidatesError: string|null,
 *   canManage: boolean, isAgentCall: boolean, toolName: string|null }>}
 */
async function describeBindings({ automation, viewerId, session = null, deps = {} }) {
    const d = realDeps(deps);
    const { role } = await d.access.roleFor(automation, viewerId, { session });
    const canManage = roleSatisfies(role, 'edit');
    const current = await d.store.listBindingsForAutomation(automation.id);

    const req = { session: session || { user: { id: viewerId } } };
    const editCtx = current.length ? await d.agentAccess.buildCanModifyContext(viewerId, req) : null;
    const ownerIdentity = current.length ? await ownerIdentityOf(automation.userId, d) : null;

    const bindings = [];
    for (const b of current) {
        let agent = null;
        try { agent = await d.agentStore.getForRuntime(b.agentId); } catch (_) { agent = null; }
        if (!agent) {
            // Gone: nothing to hide, and the row can be cleared by an editor.
            bindings.push({ agentId: b.agentId, name: null, canEdit: canManage, missing: true, usable: false, notGranted: false });
            continue;
        }
        if (!(await d.agentAccess.canModifyAgent(agent, viewerId, req, editCtx))) {
            bindings.push({ agentId: null, name: null, canEdit: false, missing: false, usable: null, notGranted: null });
            continue;
        }
        bindings.push({
            agentId: b.agentId,
            name: agent.name || b.agentId,
            canEdit: true,
            missing: false,
            usable: await ownerMayUseAgent(automation.userId, b.agentId, { deps: d, identity: ownerIdentity, agent }),
            notGranted: notGrantedBy(agent, automation.id, d),
        });
    }

    let candidates = null;
    let candidatesError = null;
    if (canManage) {
        try { candidates = await candidateAgentsFor({ automation, viewerId, session, deps: d }); }
        catch (e) {
            candidatesError = 'agents_unavailable';
            log.warn(`[automation agent binding] candidate agents unavailable for ${automation.id}: ${e.message}`);
        }
    } else {
        candidates = [];
    }

    return {
        bindings,
        candidates,
        candidatesError,
        canManage,
        isAgentCall: declaresAgentCall(automation),
        toolName: toolNameOf(automation),
    };
}

/**
 * The dispatch-time question: may THIS agent start THIS automation right now?
 * Reads the binding and the agent fresh; a lookup that fails is a no. The
 * definition and active checks are the caller's (they belong to the run).
 *
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'no_agent'|'not_bound'|'owner_cannot_use' }>}
 */
async function agentMayCall({ automation, agentId, deps = {} }) {
    if (!agentId) return { ok: false, reason: 'no_agent' };
    const store = deps.store || require('../stores/automationStore');
    try {
        if (!(await store.hasAgentBinding(automation.id, agentId))) return { ok: false, reason: 'not_bound' };
    } catch (e) {
        log.warn(`[automation agent binding] binding lookup failed for ${automation.id}: ${e.message}`);
        return { ok: false, reason: 'not_bound' };
    }
    if (!(await ownerMayUseAgent(automation.userId, agentId, { deps }))) return { ok: false, reason: 'owner_cannot_use' };
    return { ok: true };
}

/**
 * Has the agent's owner curated the automations section, and what does it grant?
 * The PRESENCE of the key is the choice (an empty section is "all switched off",
 * see integrationTools), so `curated` says whether `grants` narrows anything.
 * Throws when the policy module cannot read it; callers decide what that means.
 *
 * @returns {{ curated: boolean, grants: object|null }}
 */
function curationOf(config, deps = {}) {
    const tools = config && typeof config === 'object' && config.tools && typeof config.tools === 'object' && !Array.isArray(config.tools)
        ? config.tools : null;
    const curated = !!tools && Object.prototype.hasOwnProperty.call(tools, 'automations');
    if (!curated) return { curated: false, grants: null };
    const policy = deps.toolPolicy || require('../core/agentRuntime/toolPolicy');
    return { curated: true, grants: policy.automationGrantsOf(policy.toolsConfigOf(config)) };
}

/**
 * The part of the dispatch-time answer that is the agent's OWN choice, on top of
 * the binding: the grant list the agent's owner curated
 * (`config.tools.automations`) and the per-automation confirm in it.
 *
 * Offering already narrows by this list, but only streaming chat and the AI
 * step also refuse a tool NAME they did not offer. Voice and the non-streaming
 * chat dispatch whatever name the model emits, so the choice has to be read
 * again here, where every surface passes:
 *
 *   - a CURATED agent (the section exists, even when empty: that is "I switched
 *     them all off") runs only the automations listed in it;
 *   - a grant on `confirm: 'ask'` runs only when the surface says its confirm
 *     layer already stood between the model and this call (`confirmed`, set by
 *     the tool round executor and nowhere else). Voice, the non-streaming chat
 *     and unattended AI steps have nobody to ask, so for them 'ask' is a no.
 *
 * An agent nobody curated is untouched: the binding alone is the grant. A
 * config that cannot be read is a no, like every other lookup in this file.
 *
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'agent_unreadable'|'not_granted'|'needs_confirmation' }>}
 */
async function agentGrantVerdict({ automation, agentId, confirmed = false, deps = {} }) {
    if (!agentId) return { ok: false, reason: 'agent_unreadable' };
    let curated;
    let grants;
    try {
        const agentStore = deps.agentStore || require('../stores/agentStore');
        const agent = await agentStore.getForRuntime(agentId);
        if (!agent) return { ok: false, reason: 'agent_unreadable' };
        ({ curated, grants } = curationOf(agent.config, deps));
    } catch (e) {
        log.warn(`[automation agent binding] grant lookup failed for agent ${agentId}: ${e.message}`);
        return { ok: false, reason: 'agent_unreadable' };
    }
    if (!curated) return { ok: true };
    if (!grants || !Object.prototype.hasOwnProperty.call(grants, automation.id)) return { ok: false, reason: 'not_granted' };
    const grant = grants[automation.id];
    if (grant && grant.confirm === 'ask' && confirmed !== true) return { ok: false, reason: 'needs_confirmation' };
    return { ok: true };
}

/**
 * After an automation changes owner: drop the bindings whose agent the NEW
 * owner may not use (a grant the new owner could not have made). A lookup that
 * fails keeps the row; the dispatch check refuses it either way. Best effort.
 *
 * @returns {Promise<string[]>} the agent ids that were unbound
 */
async function pruneBindingsForOwner({ automation, actorId = null, deps = {} }) {
    const d = realDeps(deps);
    try {
        const current = await d.store.listBindingsForAutomation(automation.id);
        if (!current.length) return [];
        const identity = await ownerIdentityOf(automation.userId, d);
        if (!identity) return [];
        const drop = [];
        for (const b of current) {
            if (!(await ownerMayUseAgent(automation.userId, b.agentId, { deps: d, identity }))) drop.push(b.agentId);
        }
        if (!drop.length) return [];
        await d.store.applyAgentBindings(automation.id, { remove: drop }, actorId);
        for (const agentId of drop) {
            log.info(`[automation agent binding] unbound automation=${automation.id} agent=${agentId} actor=${actorId || 'system'} reason=new_owner_cannot_use`);
        }
        return drop;
    } catch (e) {
        log.warn(`[automation agent binding] pruning after the owner change failed for ${automation.id}: ${e.message}`);
        return [];
    }
}

module.exports = {
    MAX_BINDINGS,
    NOT_ALLOWED_CODE,
    ownerIdentityOf,
    ownerMayUseAgent,
    declaresAgentCall,
    setAgentBindings,
    describeBindings,
    agentMayCall,
    agentGrantVerdict,
    linkedAutomationIds,
    pruneBindingsForOwner,
};
