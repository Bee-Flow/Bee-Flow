/**
 * n8n Workflow Management Tools — Static AI tools for managing n8n workflows
 *
 * Full CRUD + surgical edits + execute/debug on the org's connected n8n instance.
 * Split into two permission buckets — see N8N_TOOL_PERMISSIONS.
 *
 * Uses the n8n REST API v1 with org-level credentials.
 */

const configStore = require('../stores/configStore');
const { n8nFetch } = require('./n8nHttp');
const log = require('../telemetry/log');

// ─── n8n API Helper ────────────────────────────────────────────

async function n8nApiFetch(orgId, path, options = {}) {
    const n8nUrl = await configStore.getConfig(`n8n_url_org_${orgId}`);
    const apiKey = await configStore.getSecret(`n8n_api_key_org_${orgId}`);

    if (!n8nUrl || !apiKey) {
        throw new Error('n8n is not configured for this organization. Set the URL and API key in Organisation Settings.');
    }

    const base = n8nUrl.replace(/\/+$/, '');
    const apiBase = base.includes('/api/v1') ? base : `${base}/api/v1`;
    const url = `${apiBase}${path}`;

    const res = await n8nFetch(url, {
        ...options,
        headers: {
            'X-N8N-API-KEY': apiKey,
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(options.timeoutMs || 30000),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const cap = res.status >= 400 && res.status < 500 ? 1500 : 300;
        throw new Error(`n8n API error (${res.status}): ${errText.slice(0, cap)}`);
    }

    // Some endpoints (activate/deactivate) return 204 No Content
    if (res.status === 204) return {};
    return res.json();
}

// ─── Tool Definitions ──────────────────────────────────────────
//
// All array/object fields accept REAL JSON — not stringified JSON.
// A dual-accept shim in parseJsonParam still handles stringified inputs from
// older models during the transition, with a deprecation warning.

const N8N_WORKFLOW_TOOLS = [
    // ── READ ─────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_list',
            description: 'List all workflows on the connected n8n instance. Returns summary per workflow (ID, name, active status, node count, tags, timestamps). ALWAYS call this first to discover IDs before any get/patch/update/delete — never guess a workflow ID. If you already called list in this conversation and the user asks to edit "the first one" or "that workflow", reuse the ID from the previous list result.',
            parameters: {
                type: 'object',
                properties: {
                    active: { type: 'boolean', description: 'Filter by active status. Omit for all.' },
                    limit: { type: 'integer', description: 'Max workflows to return (default 50, max 250).' },
                    tags: { type: 'string', description: 'Comma-separated tag names to filter by.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_get',
            description: 'Get the full definition of a workflow — nodes, connections, settings. The workflow_id MUST come from a prior n8n_workflow_list call — don\'t guess. If you get a 404, the ID is wrong or stale; re-list to find the current ID. Workflows over ~200KB auto-summarise; pass full:true to force the complete shape. For targeted edits prefer n8n_workflow_nodes_find instead — it\'s much cheaper.',
            parameters: {
                type: 'object',
                properties: {
                    workflow_id: { type: 'string', description: 'The workflow ID.' },
                    full: { type: 'boolean', description: 'Force full output above the 200KB threshold. Default false.' },
                },
                required: ['workflow_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_nodes_find',
            description: 'Return only matching nodes from a workflow. Cheaper than pulling the whole workflow for targeted edits (e.g. "all AI agent nodes", "the node named Summary Agent", "anything with a systemMessage parameter"). Returns matches in full node shape — pass each match straight to n8n_workflow_patch as node_data. Filters are AND-combined; at least one filter must be provided.',
            parameters: {
                type: 'object',
                properties: {
                    workflow_id: { type: 'string' },
                    node_type_pattern: { type: 'string', description: "Case-insensitive substring match against each node's `type`. E.g. 'langchain' matches @n8n/n8n-nodes-langchain.agent AND .chainLlm; 'agent' matches any type containing 'agent'." },
                    node_names: { type: 'array', items: { type: 'string' }, description: 'Case-sensitive exact-match list. Real JSON array — NOT a stringified array.' },
                    has_param: { type: 'string', description: "Dot-path into node.parameters; matches nodes where the path resolves to a defined non-null value. Examples: 'systemMessage', 'options.systemMessage', 'url', 'text'." },
                },
                required: ['workflow_id'],
            },
        },
    },

    // ── WRITE ────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_create',
            description: 'Create a new workflow. `nodes` MUST be a real JSON array; `connections` MUST be a real JSON object. Never pass stringified JSON. Do not wrap in an extra "workflow" key. Do NOT include `id`, `active`, `tags`, `pinData`, `versionId`, `meta`, `createdAt`, or `updatedAt` in the body — those are read-only on n8n\'s public API and the request will 400. Activation is handled via the `active` parameter on this tool (server makes a separate /activate call after create).',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    nodes: {
                        type: 'array',
                        description: 'Array of node objects. Each node needs name, type, typeVersion, position ([x,y]), and parameters.',
                        items: { type: 'object' },
                    },
                    connections: { type: 'object', description: 'Keyed by source node name. connections[src][outputType][outputIndex] = [{ node, type, index }, ...].' },
                    settings: { type: 'object', description: 'Optional, e.g. { "executionOrder": "v1" }.' },
                    active: { type: 'boolean', description: 'If true, the server activates the workflow after creation via a separate POST /workflows/{id}/activate call (default: false).' },
                },
                required: ['name', 'nodes', 'connections'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_update',
            description: 'Fully REPLACE a workflow. Every field you omit is deleted. DO NOT use this for targeted edits — use n8n_workflow_patch (with node_operations) instead. Only call this when the user explicitly wants to wipe-and-rewrite.',
            parameters: {
                type: 'object',
                properties: {
                    workflow_id: { type: 'string' },
                    name: { type: 'string' },
                    nodes: { type: 'array', items: { type: 'object' } },
                    connections: { type: 'object' },
                    settings: { type: 'object' },
                    active: { type: 'boolean' },
                },
                required: ['workflow_id', 'name', 'nodes', 'connections'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_patch',
            description: 'Partially update a workflow. Only the fields you provide change; everything else is preserved. RULES: (1) Strongly prefer `node_operations` over `nodes`/`connections` — surgical edits by node name, with deep-merge on update and automatic connection cleanup on remove. (2) Do NOT send `settings` unless the user explicitly asked to change a setting; the server preserves the current settings automatically and filters them to n8n\'s accepted keys. Sending arbitrary settings causes a 400 from n8n. (3) Never rename a node via update — connections key on node name. To rename: remove + re-add and re-wire. (4) Deep-merge replaces arrays wholesale (e.g. parameters.assignments.assignments, headerParameters.parameters); include every row you want to keep if you touch an array. (5) For adding documentation (sticky notes) to the canvas, use node_operations with action:"add" and type:"n8n-nodes-base.stickyNote" — sticky notes don\'t need connections.',
            parameters: {
                type: 'object',
                properties: {
                    workflow_id: { type: 'string' },
                    name: { type: 'string', description: 'New name (only if renaming).' },
                    node_operations: {
                        type: 'array',
                        description: 'Surgical per-node edits. Apply sequentially: add new nodes, deep-merge updates into existing nodes, remove nodes (and prune their connections).',
                        items: {
                            type: 'object',
                            properties: {
                                action: { type: 'string', enum: ['add', 'update', 'remove'] },
                                node_name: { type: 'string', description: 'Required for update/remove; optional for add (taken from node_data.name otherwise).' },
                                node_data: { type: 'object', description: 'For add: complete node object (name, type, typeVersion, position, parameters). For update: only fields to change (deep-merged; arrays replace). Omit for remove.' },
                            },
                            required: ['action'],
                        },
                    },
                    nodes: { type: 'array', items: { type: 'object' }, description: 'Advanced: replace all nodes wholesale. Prefer node_operations.' },
                    connections: { type: 'object', description: 'Advanced: replace ALL connections. To tweak connections surgically, get the current value first and merge client-side before sending.' },
                    settings: { type: 'object', description: 'Shallow-merged with existing settings.' },
                    active: { type: 'boolean' },
                },
                required: ['workflow_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_delete',
            description: 'Permanently delete a workflow. THIS CANNOT BE UNDONE. Requires explicit confirm:true — always confirm with the user first and only call this after they agree.',
            parameters: {
                type: 'object',
                properties: {
                    workflow_id: { type: 'string' },
                    confirm: { type: 'boolean', description: 'Must be true. Guard against accidental deletes.' },
                },
                required: ['workflow_id', 'confirm'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_activate',
            description: 'Activate a workflow so it processes events (triggers, schedules, webhooks). Activation can incur cost on scheduled workflows — confirm intent before calling.',
            parameters: {
                type: 'object',
                properties: { workflow_id: { type: 'string' } },
                required: ['workflow_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_deactivate',
            description: 'Deactivate a workflow so it stops processing events. Preserves the definition.',
            parameters: {
                type: 'object',
                properties: { workflow_id: { type: 'string' } },
                required: ['workflow_id'],
            },
        },
    },

    // ── EXECUTE / DEBUG ──────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_execute',
            description: 'Execute a workflow synchronously and wait up to timeout_seconds for completion. Returns the execution summary and per-node output on finish, or a running status + execution_id on timeout (follow up with n8n_execution_get_detail). Webhook-triggered workflows will NOT start via this tool — they wait for an external HTTP POST.',
            parameters: {
                type: 'object',
                properties: {
                    workflow_id: { type: 'string' },
                    timeout_seconds: { type: 'integer', description: 'Default 120, max 300.' },
                },
                required: ['workflow_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_execution_list',
            description: 'List recent workflow executions. Filter by workflow ID and/or status.',
            parameters: {
                type: 'object',
                properties: {
                    workflow_id: { type: 'string', description: 'Filter to a single workflow.' },
                    status: { type: 'string', enum: ['success', 'error', 'waiting', 'running'], description: 'Filter by status.' },
                    limit: { type: 'integer', description: 'Max to return (default 20, max 100).' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_execution_get',
            description: 'Get a high-level execution summary (status, timestamps, mode, error message if any).',
            parameters: {
                type: 'object',
                properties: { execution_id: { type: 'string' } },
                required: ['execution_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_execution_get_detail',
            description: 'Comprehensive debug info for a single execution: per-node output (first 5 items/node), errors with stack traces, timing. Use when a run failed or produced unexpected output.',
            parameters: {
                type: 'object',
                properties: { execution_id: { type: 'string' } },
                required: ['execution_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_execution_retry',
            description: 'Retry a failed execution from where it stopped.',
            parameters: {
                type: 'object',
                properties: { execution_id: { type: 'string' } },
                required: ['execution_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_execution_stop',
            description: 'Stop a running execution.',
            parameters: {
                type: 'object',
                properties: { execution_id: { type: 'string' } },
                required: ['execution_id'],
            },
        },
    },
];

const {
    parseJsonParam,
    deepMerge,
    applyNodeOperations,
    assertConnectionsIntegrity,
    summarizeWorkflow,
    filterNodes,
    summarizeExecution,
    buildExecutionDetail,
    sanitiseSettings,
    stripReadOnly,
    SETTINGS_WHITELIST,
} = require('./n8nWorkflowHelpers');

// ─── Tool Execution ────────────────────────────────────────────

async function workflowList(args, { orgId }) {
    const { active, limit = 50, tags } = args;
    const cap = Math.min(Math.max(limit || 50, 1), 250);
    let q = `limit=${cap}`;
    if (active !== undefined) q += `&active=${active}`;
    if (tags) q += `&tags=${encodeURIComponent(tags)}`;
    const data = await n8nApiFetch(orgId, `/workflows?${q}`);
    const workflows = data.data ?? data;
    return {
        total: Array.isArray(workflows) ? workflows.length : 0,
        workflows: (Array.isArray(workflows) ? workflows : []).map(summarizeWorkflow),
    };
}

// ── Get Workflow ────────────────────────────────────
async function workflowGet(args, { orgId }) {
    const { workflow_id, full = false } = args;
    if (!workflow_id) return { error: 'workflow_id is required' };
    const wf = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}`);
    const result = {
        id: wf.id,
        name: wf.name,
        active: wf.active,
        tags: (wf.tags || []).map(t => typeof t === 'string' ? t : t.name).filter(Boolean),
        createdAt: wf.createdAt,
        updatedAt: wf.updatedAt,
        settings: wf.settings || {},
        nodes: (wf.nodes || []).map(n => ({
            name: n.name,
            type: n.type,
            typeVersion: n.typeVersion,
            position: n.position,
            parameters: n.parameters || {},
            disabled: n.disabled || false,
            credentials: n.credentials,
        })),
        connections: wf.connections || {},
    };
    const json = JSON.stringify(result);
    // Threshold bumped to ~200KB per the manual (§3.2). Older cap was 30KB.
    if (json.length > 200000 && !full) {
        return {
            ...summarizeWorkflow(wf),
            _note: `Full workflow JSON is ${json.length} chars. Auto-summarised — pass full:true to override, or use n8n_workflow_nodes_find to grab just the nodes you need.`,
            settings: wf.settings || {},
            nodeDetails: (wf.nodes || []).map(n => ({ name: n.name, type: n.type, disabled: n.disabled || false })),
        };
    }
    return result;
}

// ── Find Nodes (filtered subset) ────────────────────
async function workflowNodesFind(args, { orgId, toolName }) {
    const { workflow_id, node_type_pattern, node_names, has_param } = args;
    if (!workflow_id) return { error: 'workflow_id is required' };
    if (!node_type_pattern && (!node_names || !node_names.length) && !has_param) {
        return { error: 'At least one filter is required (node_type_pattern, node_names, or has_param).' };
    }
    // node_names may arrive stringified from older models — dual-accept
    const parsedNames = typeof node_names === 'string' ? parseJsonParam(node_names, 'node_names', toolName) : node_names;
    const wf = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}`);
    const matched = filterNodes(wf, { node_type_pattern, node_names: parsedNames, has_param });
    return {
        workflow_id: wf.id,
        workflow_name: wf.name,
        match_count: matched.length,
        matched_nodes: matched.map(n => ({
            name: n.name,
            type: n.type,
            typeVersion: n.typeVersion,
            position: n.position,
            parameters: n.parameters || {},
            disabled: n.disabled || false,
            credentials: n.credentials,
        })),
        _note: matched.length === 0 ? 'No nodes matched. Check your filter; remember node_type_pattern is a case-insensitive substring match on node.type.' : undefined,
    };
}

// ── Create Workflow ─────────────────────────────────
async function workflowCreate(args, { orgId, toolName }) {
    const { name, active = false } = args;
    if (!name) return { error: 'name is required' };
    const nodes = parseJsonParam(args.nodes, 'nodes', toolName);
    const connections = parseJsonParam(args.connections, 'connections', toolName);
    const settings = parseJsonParam(args.settings, 'settings', toolName);
    if (!Array.isArray(nodes)) return { error: 'nodes must be a JSON array of node objects' };
    if (!connections || typeof connections !== 'object' || Array.isArray(connections)) {
        return { error: 'connections must be a JSON object' };
    }
    assertConnectionsIntegrity(nodes, connections);

    // n8n's POST /workflows rejects `active`, `tags`, `id`, `pinData`, etc.
    // Reuse the same hygiene as PUT: stripReadOnly drops forbidden top-level
    // keys and filters settings to n8n's accepted whitelist.
    const body = stripReadOnly({
        name,
        nodes,
        connections,
        settings: settings || {},
    });

    const created = await n8nApiFetch(orgId, '/workflows', {
        method: 'POST',
        body: JSON.stringify(body),
    });

    // Activation is a separate endpoint on the public API.
    if (active) {
        try {
            await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(created.id)}/activate`, { method: 'POST' });
            created.active = true;
        } catch (e) {
            return {
                success: true,
                message: `Workflow "${created.name}" created but activation failed: ${e.message}`,
                ...summarizeWorkflow(created),
            };
        }
    }

    return { success: true, message: `Workflow "${created.name}" created${active ? ' and activated' : ''}.`, ...summarizeWorkflow(created) };
}

// ── Full Update (PUT) ───────────────────────────────
async function workflowUpdate(args, { orgId, toolName }) {
    const { workflow_id, name, active } = args;
    if (!workflow_id) return { error: 'workflow_id is required' };
    if (!name) return { error: 'name is required for full update' };
    const nodes = parseJsonParam(args.nodes, 'nodes', toolName);
    const connections = parseJsonParam(args.connections, 'connections', toolName);
    const settings = parseJsonParam(args.settings, 'settings', toolName);
    if (!Array.isArray(nodes)) return { error: 'nodes must be a JSON array' };
    if (!connections || typeof connections !== 'object' || Array.isArray(connections)) {
        return { error: 'connections must be a JSON object' };
    }
    assertConnectionsIntegrity(nodes, connections);
    const body = { name, nodes, connections };
    if (settings) body.settings = settings;
    if (active !== undefined) body.active = !!active;
    const updated = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}`, {
        method: 'PUT',
        body: JSON.stringify(stripReadOnly(body)),
    });
    return { success: true, message: `Workflow "${updated.name}" fully updated.`, ...summarizeWorkflow(updated) };
}

// ── Patch (Partial, with node_operations) ───────────
async function workflowPatch(args, { orgId, toolName }) {
    const { workflow_id, name, active } = args;
    if (!workflow_id) return { error: 'workflow_id is required' };

    // Fetch current workflow
    const current = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}`);

    let mergedNodes = Array.isArray(current.nodes) ? [...current.nodes] : [];
    let mergedConnections = current.connections && typeof current.connections === 'object'
        ? current.connections
        : {};
    let mergedSettings = current.settings || {};
    let mergedName = name !== undefined ? name : current.name;

    // Apply node_operations first (surgical), then allow wholesale overrides.
    if (args.node_operations) {
        const ops = Array.isArray(args.node_operations)
            ? args.node_operations
            : parseJsonParam(args.node_operations, 'node_operations', toolName);
        if (!Array.isArray(ops)) return { error: 'node_operations must be a JSON array' };
        const result = applyNodeOperations(
            { nodes: mergedNodes, connections: mergedConnections },
            ops,
            toolName
        );
        mergedNodes = result.nodes;
        mergedConnections = result.connections;
    }

    // Wholesale overrides (documented as full-replace per manual §7.4)
    if (args.nodes !== undefined) {
        const parsed = parseJsonParam(args.nodes, 'nodes', toolName);
        if (!Array.isArray(parsed)) return { error: 'nodes must be a JSON array' };
        mergedNodes = parsed;
    }
    if (args.connections !== undefined) {
        const parsed = parseJsonParam(args.connections, 'connections', toolName);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { error: 'connections must be a JSON object' };
        }
        mergedConnections = parsed;
    }
    if (args.settings !== undefined) {
        const parsed = parseJsonParam(args.settings, 'settings', toolName);
        if (parsed && typeof parsed === 'object') mergedSettings = { ...mergedSettings, ...parsed };
    }

    // Post-condition: refuse to save an internally inconsistent workflow.
    assertConnectionsIntegrity(mergedNodes, mergedConnections);

    const body = {
        name: mergedName,
        nodes: mergedNodes,
        connections: mergedConnections,
        settings: mergedSettings,
    };
    if (active !== undefined) body.active = !!active;

    const updated = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}`, {
        method: 'PUT',
        body: JSON.stringify(stripReadOnly(body)),
    });
    return {
        success: true,
        message: `Workflow "${updated.name}" patched.`,
        ...summarizeWorkflow(updated),
    };
}

// ── Delete (permanent) ──────────────────────────────
async function workflowDelete(args, { orgId }) {
    const { workflow_id, confirm } = args;
    if (!workflow_id) return { error: 'workflow_id is required' };
    if (confirm !== true) {
        return { error: 'Delete requires confirm:true. Confirm with the user before calling this tool.' };
    }
    await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}`, { method: 'DELETE' });
    return { success: true, message: `Workflow ${workflow_id} deleted.` };
}

// ── Activate / Deactivate ───────────────────────────
async function workflowActivate(args, { orgId }) {
    const { workflow_id } = args;
    if (!workflow_id) return { error: 'workflow_id is required' };
    const result = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}/activate`, { method: 'POST' });
    return { success: true, message: `Workflow "${result.name || workflow_id}" activated.`, id: result.id || workflow_id, name: result.name, active: true };
}

async function workflowDeactivate(args, { orgId }) {
    const { workflow_id } = args;
    if (!workflow_id) return { error: 'workflow_id is required' };
    const result = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}/deactivate`, { method: 'POST' });
    return { success: true, message: `Workflow "${result.name || workflow_id}" deactivated.`, id: result.id || workflow_id, name: result.name, active: false };
}

// ── Execute (async-poll) ────────────────────────────
async function workflowExecute(args, { orgId }) {
    const { workflow_id, timeout_seconds = 120 } = args;
    if (!workflow_id) return { error: 'workflow_id is required' };
    const timeoutMs = Math.min(Math.max(timeout_seconds, 1), 300) * 1000;

    // Webhook-triggered workflows: surface a diagnostic — execute won't start them.
    try {
        const wf = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}`);
        const triggers = (wf.nodes || []).filter(n => /trigger|webhook/i.test(n.type || ''));
        const onlyWebhook = triggers.length > 0 && triggers.every(n => /webhook/i.test(n.type || ''));
        if (onlyWebhook) {
            return { error: 'This workflow is webhook-triggered. Trigger it by calling its webhook URL directly, or temporarily swap in a Manual Trigger.', workflow_id };
        }
    } catch (err) { log.debug('fall through — let the execute attempt surface the real error', err); }

    // Kick off the run. n8n's POST /workflows/:id/execute returns an execution record.
    const start = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}/execute`, {
        method: 'POST',
        body: JSON.stringify({}),
    });
    const execId = start?.data?.executionId || start?.executionId || start?.id;
    if (!execId) {
        return { success: false, _note: 'n8n accepted the execute request but did not return an execution ID.', raw: start };
    }

    // Poll /executions/:id
    const deadline = Date.now() + timeoutMs;
    let lastExec = null;
    while (Date.now() < deadline) {
        try {
            lastExec = await n8nApiFetch(orgId, `/executions/${encodeURIComponent(execId)}?includeData=true`);
            if (lastExec?.finished) break;
        } catch (e) { log.debug('transient — keep polling', e); }
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!lastExec?.finished) {
        return {
            status: 'running',
            execution_id: execId,
            workflow_id,
            _note: `Timed out after ${timeout_seconds}s. Follow up with n8n_execution_get_detail using execution_id=${execId}.`,
        };
    }

    return buildExecutionDetail(lastExec);
}

// ── Execution: list / get / detail / retry / stop ───
async function executionList(args, { orgId }) {
    const { workflow_id, status, limit = 20 } = args;
    const cap = Math.min(Math.max(limit || 20, 1), 100);
    const qp = [`limit=${cap}`];
    if (workflow_id) qp.push(`workflowId=${encodeURIComponent(workflow_id)}`);
    if (status) qp.push(`status=${encodeURIComponent(status)}`);
    const data = await n8nApiFetch(orgId, `/executions?${qp.join('&')}`);
    const execs = data.data ?? data;
    return {
        total: Array.isArray(execs) ? execs.length : 0,
        executions: (Array.isArray(execs) ? execs : []).map(summarizeExecution),
    };
}

async function executionGet(args, { orgId }) {
    const { execution_id } = args;
    if (!execution_id) return { error: 'execution_id is required' };
    const exec = await n8nApiFetch(orgId, `/executions/${encodeURIComponent(execution_id)}`);
    return summarizeExecution(exec);
}

async function executionGetDetail(args, { orgId }) {
    const { execution_id } = args;
    if (!execution_id) return { error: 'execution_id is required' };
    const exec = await n8nApiFetch(orgId, `/executions/${encodeURIComponent(execution_id)}?includeData=true`);
    return buildExecutionDetail(exec);
}

async function executionRetry(args, { orgId }) {
    const { execution_id } = args;
    if (!execution_id) return { error: 'execution_id is required' };
    const result = await n8nApiFetch(orgId, `/executions/${encodeURIComponent(execution_id)}/retry`, { method: 'POST' });
    return { success: true, message: `Retry started for execution ${execution_id}.`, ...summarizeExecution(result) };
}

async function executionStop(args, { orgId }) {
    const { execution_id } = args;
    if (!execution_id) return { error: 'execution_id is required' };
    const result = await n8nApiFetch(orgId, `/executions/${encodeURIComponent(execution_id)}/stop`, { method: 'POST' });
    return { success: true, message: `Stop signal sent to execution ${execution_id}.`, ...summarizeExecution(result) };
}

const HANDLERS = {
    n8n_workflow_list: workflowList,
    n8n_workflow_get: workflowGet,
    n8n_workflow_nodes_find: workflowNodesFind,
    n8n_workflow_create: workflowCreate,
    n8n_workflow_update: workflowUpdate,
    n8n_workflow_patch: workflowPatch,
    n8n_workflow_delete: workflowDelete,
    n8n_workflow_activate: workflowActivate,
    n8n_workflow_deactivate: workflowDeactivate,
    n8n_workflow_execute: workflowExecute,
    n8n_execution_list: executionList,
    n8n_execution_get: executionGet,
    n8n_execution_get_detail: executionGetDetail,
    n8n_execution_retry: executionRetry,
    n8n_execution_stop: executionStop,
};

async function executeN8nWorkflowTool(toolName, args, orgId) {
    if (!orgId) {
        return { error: 'No organization found. n8n workflow management requires an organization with n8n configured.' };
    }

    try {
        const handler = Object.hasOwn(HANDLERS, toolName) ? HANDLERS[toolName] : null;
        if (!handler) return { error: `Unknown n8n workflow tool: ${toolName}` };
        return await handler(args, { orgId, toolName });
    } catch (err) {
        log.error(`[n8n-workflow] ${toolName} error:`, err.message);
        return { error: `n8n operation failed: ${err.message}` };
    }
}

// ─── Identification ────────────────────────────────────────────

function isN8nWorkflowTool(toolName) {
    return toolName && (toolName.startsWith('n8n_workflow_') || toolName.startsWith('n8n_execution_'));
}

// ─── Permission buckets ────────────────────────────────────────
// Map each tool name to the permission it requires:
//   - 'use_n8n_tools'         → read-only: list, get, nodes_find, execution reads
//   - 'modify_n8n_workflows'  → write / execute / delete / activate
// Tools NOT in this map are treated as write (safe default).
const N8N_TOOL_PERMISSIONS = {
    // read-only
    n8n_workflow_list: 'use_n8n_tools',
    n8n_workflow_get: 'use_n8n_tools',
    n8n_workflow_nodes_find: 'use_n8n_tools',
    n8n_execution_list: 'use_n8n_tools',
    n8n_execution_get: 'use_n8n_tools',
    n8n_execution_get_detail: 'use_n8n_tools',
    // write / execute / activate / delete
    n8n_workflow_create: 'modify_n8n_workflows',
    n8n_workflow_update: 'modify_n8n_workflows',
    n8n_workflow_patch: 'modify_n8n_workflows',
    n8n_workflow_delete: 'modify_n8n_workflows',
    n8n_workflow_activate: 'modify_n8n_workflows',
    n8n_workflow_deactivate: 'modify_n8n_workflows',
    n8n_workflow_execute: 'modify_n8n_workflows',
    n8n_execution_retry: 'modify_n8n_workflows',
    n8n_execution_stop: 'modify_n8n_workflows',
};

function getN8nToolPermission(toolName) {
    return (Object.hasOwn(N8N_TOOL_PERMISSIONS, toolName) && N8N_TOOL_PERMISSIONS[toolName]) || 'modify_n8n_workflows';
}

// ─── Exports ───────────────────────────────────────────────────

module.exports = {
    N8N_WORKFLOW_TOOLS,
    N8N_TOOL_PERMISSIONS,
    getN8nToolPermission,
    executeN8nWorkflowTool,
    isN8nWorkflowTool,
    // Exposed for unit tests
    applyNodeOperations,
    assertConnectionsIntegrity,
    deepMerge,
    parseJsonParam,
    sanitiseSettings,
    SETTINGS_WHITELIST,
};
