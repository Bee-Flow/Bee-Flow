/**
 * Agent tool loading — builds tool definitions for agents
 */
const componentManager = require('../cms/componentManager');
const agentStore = require('../../stores/agentStore');
const { componentToTool, SYSTEM_TOOLS } = require('../tools/toolExecution');
const log = require('../../telemetry/log');


async function getAgentTools(agentId) {
    const componentIds = await agentStore.getAgentTools(agentId);
    const allComponents = componentManager.getComponents();
    const workflowStore = require('../../stores/workflowStore');

    // Filter to only agent-enabled components.
    //
    // FAIL CLOSED (`=== true`, not `!== false`). A component is a directory of
    // caller-authored code that executionEngine spawns with the server's env,
    // and components/ is ONE GLOBAL UNTENANTED directory — so "agent-callable"
    // has to be a decision someone made, not the absence of a field. It was
    // the absence: POST /ai/create-component writes component.json with no
    // agentEnabled key at all, so a component the model had just written was
    // immediately reachable by every agent, in every org, with nobody having
    // chosen that.
    //
    // Its sibling directChatEnabled has always been `=== true`
    // (core/tools/directChatToolStack.js); this only brings the two into line.
    // The shipped components that relied on the old default now declare
    // `agentEnabled: true` in their component.json, so nothing changes today.
    const agentEnabledComponents = allComponents.filter(c => c.definition?.agentEnabled === true);

    // Get subworkflows as virtual components
    let subworkflowComponents = [];
    try {
        const allWorkflows = await workflowStore.getAllWorkflows();
        const subworkflows = allWorkflows.filter(wf => {
            return wf.nodes?.some(n =>
                n.type === 'trigger-subworkflow' ||
                n.data?.componentId === 'trigger-subworkflow'
            );
        });

        subworkflowComponents = subworkflows.map(wf => {
            const triggerNode = wf.nodes.find(n =>
                n.type === 'trigger-subworkflow' ||
                n.data?.componentId === 'trigger-subworkflow'
            );
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
    const toolConfigs = await agentStore.getAgentToolsWithParams(agentId);
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

    // Inject System Tools (Restricted to AI Component Designer)
    // These tools allow modifications to the codebase and must be protected.
    const AI_COMPONENT_DESIGNER_AGENT_ID = 'system-component-designer';
    if (agentId === AI_COMPONENT_DESIGNER_AGENT_ID) {
        tools.push(...SYSTEM_TOOLS);
    }

    // MCP-server + custom-integration tools (integrations now), gated by the
    // agent OWNER's effective integration set. This path is owner-keyed
    // because chatWithAgent does not call getIntegrationTools. Reuses the
    // shared append helpers so the gating/filter logic lives in ONE place.
    // Fail CLOSED: null set ⇒ no MCP and no custom tools.
    try {
        const agent = await agentStore.getForRuntime(agentId);
        let effectiveIntegrations = null;
        let ownerOrgId = null;
        if (agent?.userId) {
            const userStore = require('../../stores/userStore');
            const entitlements = require('../entitlements/entitlements');
            const owner = await userStore.getUser(agent.userId);
            ownerOrgId = owner?.organizationId || null;
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
        const { appendMcpTools, appendCustomIntegrationTools } = require('../integrations/integrationTools');
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

async function getAvailableComponents() {
    const components = componentManager.getComponents();
    const workflowStore = require('../../stores/workflowStore');

    // Filter to only agent-enabled components — fail closed, same rule and
    // same reason as the filter above.
    const componentList = components
        .filter(c => c.definition?.agentEnabled === true)
        .map(c => ({
            id: c.id,
            name: c.definition?.name || c.id,
            description: c.definition?.description || '',
            category: c.definition?.category || 'Uncategorized',
            inputs: c.definition?.inputs || {}
        }));

    // Get all workflows with subworkflow triggers (virtual components)
    try {
        const allWorkflows = await workflowStore.getAllWorkflows();
        const subworkflows = allWorkflows.filter(wf => {
            return wf.nodes?.some(n =>
                n.type === 'trigger-subworkflow' ||
                n.data?.componentId === 'trigger-subworkflow'
            );
        });

        // Add each subworkflow as a virtual component
        for (const wf of subworkflows) {
            // Find the trigger node to get input schema
            const triggerNode = wf.nodes.find(n =>
                n.type === 'trigger-subworkflow' ||
                n.data?.componentId === 'trigger-subworkflow'
            );

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

module.exports = { getAgentTools, getAvailableComponents };
