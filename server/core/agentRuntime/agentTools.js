/**
 * Agent tool loading — builds tool definitions for agents
 */
const componentManager = require('../cms/componentManager');
const agentStore = require('../../stores/agentStore');
const { componentToTool } = require('../tools/toolExecution');
const log = require('../../telemetry/log');

// The stores and catalogues this module reads, each behind a getter so a test
// swaps them through _setDepsForTests instead of reaching into the module
// cache. componentManager and agentStore were required at load and still are;
// the rest stay lazy, as they were inline.
const DEFAULT_DEPS = {
    componentManager: () => componentManager,
    agentStore: () => agentStore,
    userStore: () => require('../../stores/userStore'),
    workflowStore: () => require('../../stores/workflowStore'),
    entitlements: () => require('../entitlements/entitlements'),
    integrationTools: () => require('../integrations/integrationTools'),
};
let _deps = { ...DEFAULT_DEPS };


const isSubworkflowTrigger = n =>
    n.type === 'trigger-subworkflow' || n.data?.componentId === 'trigger-subworkflow';

/**
 * The subworkflows one user may see as agent tools: those whose owner is in
 * that user's organisation.
 *
 * The workflows table holds every org's workflows, and both lists below used
 * to read all of it (`getAllWorkflows()` is an unscoped SELECT). GET
 * /agents/meta/components is open by design (metadata for the guest chat UI),
 * so anybody on the internet got the name, description and input schema of
 * every subworkflow of every organisation, and an agent in one org was offered
 * another org's subworkflows as tools.
 *
 * Fail closed: no user, a user who no longer exists, or a lookup that fails
 * yields no subworkflows. A user without an organisation sees only their own.
 * The org is read from the user row, not from a session, so a moved or
 * deleted account does not keep its old view.
 *
 * @param {string|null|undefined} userId
 * @returns {Promise<Array<any>>}
 */
async function subworkflowsVisibleTo(userId) {
    if (!userId) return [];
    const userStore = _deps.userStore();
    const caller = await userStore.getUser(userId);
    if (!caller) return [];
    const orgId = caller.organizationId || null;

    const workflowStore = _deps.workflowStore();
    const subworkflows = (await workflowStore.getAllWorkflows())
        .filter(wf => wf.nodes?.some(isSubworkflowTrigger));
    if (!orgId) return subworkflows.filter(wf => wf.owner_id === userId);

    const orgOfOwner = new Map([[userId, orgId]]);
    const visible = [];
    for (const wf of subworkflows) {
        if (!wf.owner_id) continue;
        if (!orgOfOwner.has(wf.owner_id)) {
            const owner = await userStore.getUser(wf.owner_id);
            orgOfOwner.set(wf.owner_id, owner?.organizationId || null);
        }
        if (orgOfOwner.get(wf.owner_id) === orgId) visible.push(wf);
    }
    return visible;
}


/**
 * Whether a FILE component is listed for, and callable by, one caller.
 *
 * components/ is one global directory, so a component written through the
 * Component Designer (removed 2026-10) used to land in the catalogue and the agent tools of
 * EVERY organisation: an admin of org B was offered code a member of org A
 * had the model write, as a tool that would then receive org B's inputs. That
 * route recorded who a component belonged to in component.json, and a
 * component it wrote that is still on disk carries the key:
 *
 *   "owner": { "orgId": "<creator's org>" }      — a creator in an org
 *   "owner": { "userId": "<creator>" }           — a creator without one
 *
 * and this is the one predicate every reader applies. No `owner` key means a
 * shipped component, or one written before owners were recorded: global, as
 * it always was. An `owner` that is present but names nobody we can match is
 * hidden (fail closed). The scope is read from the user row (orgId of the
 * caller, or of the agent's owner), the same source subworkflowsVisibleTo uses.
 *
 * @param {any} definition component.json as loaded
 * @param {{ userId?: string|null, orgId?: string|null }} scope
 */
function componentVisibleTo(definition, { userId = null, orgId = null } = {}) {
    const owner = definition?.owner;
    if (owner === undefined || owner === null) return true;
    if (typeof owner !== 'object') return false;
    if (owner.orgId) return !!orgId && owner.orgId === orgId;
    if (owner.userId) return !!userId && owner.userId === userId;
    return false;
}

/**
 * The scope one user sees file components in: their id and their org, from
 * the user row. Unknown, missing or failing → an empty scope, which sees the
 * unowned components only.
 *
 * @param {string|null|undefined} userId
 * @returns {Promise<{ userId: string|null, orgId: string|null }>}
 */
async function componentScopeOf(userId) {
    if (!userId) return { userId: null, orgId: null };
    try {
        const userStore = _deps.userStore();
        const user = await userStore.getUser(userId);
        if (!user) return { userId: null, orgId: null };
        return { userId, orgId: user.organizationId || null };
    } catch (e) {
        log.warn('[AgentTools] Could not resolve the caller for component scoping:', e.message);
        return { userId: null, orgId: null };
    }
}

async function getAgentTools(agentId) {
    const componentIds = await _deps.agentStore().getAgentTools(agentId);
    const allComponents = _deps.componentManager().getComponents();

    // Filter to only agent-enabled components (applied below, once the
    // agent's owner is known, together with the owner-org scope).
    //
    // FAIL CLOSED (`=== true`, not `!== false`). A component is a directory of
    // code that executionEngine spawns as the server's uid,
    // and components/ is ONE GLOBAL UNTENANTED directory — so "agent-callable"
    // has to be a decision someone made, not the absence of a field. It was
    // the absence: the Component Designer (removed 2026-10) wrote component.json
    // with no agentEnabled key at all, so a component the model had just written was
    // immediately reachable by every agent, in every org, with nobody having
    // chosen that.
    //
    // Its sibling directChatEnabled has always been `=== true`
    // (core/tools/directChatToolStack.js); this only brings the two into line.
    // The shipped components that relied on the old default now declare
    // `agentEnabled: true` in their component.json, so nothing changes today.
    //
    // The agent's owner decides which org's subworkflows it is offered (and,
    // further down, which integrations). Looked up once; a failure here means
    // no subworkflows and, as before, no MCP or custom tools.
    const ownerLookup = (async () => {
        const agent = await _deps.agentStore().getForRuntime(agentId);
        let ownerOrgId = null;
        if (agent?.userId) {
            const userStore = _deps.userStore();
            const owner = await userStore.getUser(agent.userId);
            ownerOrgId = owner?.organizationId || null;
        }
        return { agent, ownerOrgId };
    })();
    ownerLookup.catch(() => { /* awaited (and reported) by both readers below */ });

    // ...and also which org's OWNED file components (componentVisibleTo).
    // A failed lookup leaves the empty scope: unowned components only.
    let componentScope = { userId: null, orgId: null };
    try {
        const { agent, ownerOrgId } = await ownerLookup;
        componentScope = { userId: agent?.userId || null, orgId: ownerOrgId };
    } catch { /* reported by the subworkflow reader below */ }
    const agentEnabledComponents = allComponents.filter(c =>
        c.definition?.agentEnabled === true && componentVisibleTo(c.definition, componentScope));

    // Get subworkflows as virtual components — only the owner's org's.
    let subworkflowComponents = [];
    try {
        const { agent } = await ownerLookup;
        const subworkflows = await subworkflowsVisibleTo(agent?.userId);

        subworkflowComponents = subworkflows.map(wf => {
            const triggerNode = wf.nodes.find(isSubworkflowTrigger);
            const triggerInputs = triggerNode?.data?.inputValues || {};
            const workflowDescription = triggerInputs.workflowDescription ||
                wf.description ||
                `Subworkflow: ${wf.name || wf.id}`;

            // Build inputs from defined parameters
            const inputs = {};
            if (Array.isArray(triggerInputs.inputs) && triggerInputs.inputs.length > 0) {
                for (const input of triggerInputs.inputs) {
                    if (input.name) {
                        inputs[input.name] = {
                            type: input.type || 'string',
                            description: input.description || `Input: ${input.name}`
                        };
                    }
                }
            } else {
                inputs.inputData = {
                    type: 'object',
                    description: 'Data to pass to the subworkflow'
                };
            }

            return {
                id: `subworkflow-${wf.id}`,
                definition: {
                    name: `📁 ${wf.name || 'Unnamed Workflow'}`,
                    description: workflowDescription,
                    inputs: inputs,
                    agentEnabled: true
                }
            };
        });
    } catch (e) {
        log.error('Failed to load subworkflows for agent:', e);
    }

    // Combine real components and subworkflow virtual components
    const allAvailable = [...agentEnabledComponents, ...subworkflowComponents];

    // Select components based on agent config
    // Also load fixed params to filter them from tool schema
    const toolConfigs = await _deps.agentStore().getAgentToolsWithParams(agentId);
    const fixedParamsMap = {};
    for (const tc of toolConfigs) {
        if (tc.params) {
            fixedParamsMap[tc.componentId] = tc.params;
        }
    }

    let tools = [];
    if (componentIds.length > 0) {
        const selectedComponents = allAvailable.filter(c => componentIds.includes(c.id));
        tools = selectedComponents.map(c => componentToTool(c, fixedParamsMap[c.id] || null));
    }

    // MCP-server + custom-integration tools (integrations now), gated by the
    // agent OWNER's effective integration set. This path is owner-keyed
    // because chatWithAgent does not call getIntegrationTools. Reuses the
    // shared append helpers so the gating/filter logic lives in ONE place.
    // Fail CLOSED: null set ⇒ no MCP and no custom tools.
    try {
        const { agent, ownerOrgId } = await ownerLookup;
        let effectiveIntegrations = null;
        if (agent?.userId) {
            const entitlements = _deps.entitlements();
            const snap = await entitlements.resolveEntitlements({
                userId: agent.userId,
                orgId: ownerOrgId,
            });
            if (snap && !snap.degraded) effectiveIntegrations = new Set(snap.effective.integration);
        }
        // Per-action grants apply HERE too, and that is not belt-and-braces.
        // This function runs FIRST in the stack (toolStackAssembly), and the
        // filtered second pass in getIntegrationTools only ever ADDS names it
        // does not already see — so an MCP or custom tool that slips in here
        // can never be taken back out. `mcp:<serverId>` / `custom:<id>` are
        // exactly the app ids a grants map keys on, and appIdForToolDef is
        // what reads them off the definition (their names are not in the
        // registry). Fail closed: if the policy module cannot load, offer no
        // MCP and no custom tools rather than every one of them.
        const { appendMcpTools, appendCustomIntegrationTools } = _deps.integrationTools();
        const policy = require('./toolPolicy');
        const grants = policy.toolsConfigOf(agent?.config);
        const isToolGranted = grants ? (tool) => policy.isToolAllowed(tool, grants) : null;
        await appendMcpTools(tools, { effectiveIntegrations, isToolGranted });
        await appendCustomIntegrationTools(tools, { effectiveIntegrations, orgId: ownerOrgId, isToolGranted });
    } catch (err) {
        log.warn('[AgentTools] Failed to load MCP tools:', err.message);
    }

    return tools;
}

/**
 * The component catalogue an agent designer picks tools from.
 *
 * File components (one global directory, no tenant) without an owner are
 * listed for anybody; one written with an owner only for that owner's org
 * (componentVisibleTo). Subworkflows belong to an organisation, so they are
 * listed only when a `userId` is given, and then only that user's org's
 * (subworkflowsVisibleTo). The open route GET /agents/meta/components passes
 * no userId for an anonymous caller.
 *
 * @param {{ userId?: string|null }} [scope]
 */
async function getAvailableComponents({ userId = null } = {}) {
    const components = _deps.componentManager().getComponents();
    const scope = await componentScopeOf(userId);

    // Filter to only agent-enabled components — fail closed, same rule and
    // same reason as the filter above — that this caller's org may see.
    const componentList = components
        .filter(c => c.definition?.agentEnabled === true && componentVisibleTo(c.definition, scope))
        .map(c => ({
            id: c.id,
            name: c.definition?.name || c.id,
            description: c.definition?.description || '',
            category: c.definition?.category || 'Uncategorized',
            inputs: c.definition?.inputs || {}
        }));

    // Subworkflows (virtual components) of the caller's organisation only
    try {
        const subworkflows = await subworkflowsVisibleTo(userId);

        // Add each subworkflow as a virtual component
        for (const wf of subworkflows) {
            // Find the trigger node to get input schema
            const triggerNode = wf.nodes.find(isSubworkflowTrigger);

            // Extract user-defined description and input schema from trigger node
            const triggerInputs = triggerNode?.data?.inputValues || {};
            const workflowDescription = triggerInputs.workflowDescription ||
                wf.description ||
                `Subworkflow: ${wf.name || wf.id}. Runs this workflow with provided inputs.`;

            // Parse inputSchema if defined
            let inputsSchema = {
                inputData: {
                    type: 'object',
                    default: {},
                    description: 'Data to pass to the subworkflow'
                }
            };

            // Check for array-based inputs format (new visual builder)
            if (Array.isArray(triggerInputs.inputs) && triggerInputs.inputs.length > 0) {
                inputsSchema = {};
                for (const input of triggerInputs.inputs) {
                    if (input.name) {
                        inputsSchema[input.name] = {
                            type: input.type || 'string',
                            description: input.description || `Input parameter: ${input.name}`,
                            required: input.required || false
                        };
                    }
                }
            }
            // Legacy: JSON string format
            else if (triggerInputs.inputSchema) {
                try {
                    const userSchema = JSON.parse(triggerInputs.inputSchema);
                    inputsSchema = {};
                    for (const [key, valueType] of Object.entries(userSchema)) {
                        inputsSchema[key] = {
                            type: valueType,
                            description: `Input parameter: ${key} (${valueType})`
                        };
                    }
                } catch (e) {
                    // Keep default if parsing fails
                }
            }

            componentList.push({
                id: `subworkflow-${wf.id}`,
                name: `📁 ${wf.name || 'Unnamed Workflow'}`,
                description: workflowDescription,
                category: 'Subworkflows',
                inputs: inputsSchema,
                isSubworkflow: true,
                workflowId: wf.id
            });
        }
    } catch (e) {
        log.error('Failed to load subworkflows:', e);
    }

    return componentList;
}

/**
 * Test seam: replace any of the getters in DEFAULT_DEPS (each returns the
 * module); no argument restores the real ones.
 * @param {Partial<typeof DEFAULT_DEPS> | null} [over]
 */
function _setDepsForTests(over = null) {
    _deps = { ...DEFAULT_DEPS, ...(over || {}) };
}

module.exports = { getAgentTools, getAvailableComponents, componentVisibleTo, _setDepsForTests };
