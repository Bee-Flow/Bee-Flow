// @typecheck noImplicitAny
/**
 * Pure helpers of the n8n workflow tools (n8nWorkflowTools.js): JSON parameter
 * parsing, node operations, integrity checks and the summaries sent back to the
 * model. No network access; the executor and its handlers stay in the tool file.
 */

const log = require('../telemetry/log');

/**
 * @typedef {{ name?: string, type?: string, parameters?: Record<string, unknown>, [key: string]: unknown }} N8nNodeShape
 * @typedef {{ node?: string, type?: string, index?: number }} N8nConnectionTarget
 * @typedef {Record<string, Record<string, Array<N8nConnectionTarget[] | null>>>} N8nConnections
 * @typedef {{ message?: string, name?: string, stack?: unknown, description?: string }} N8nError
 * @typedef {{ executionTime?: number, startTime?: number, error?: N8nError, data?: { main?: unknown } }} N8nNodeRun
 * @typedef {{ id?: string, workflowId?: string, workflow_id?: string, status?: string, finished?: boolean, mode?: string,
 *   startedAt?: string, stoppedAt?: string, retryOf?: string | null,
 *   data?: { resultData?: { error?: N8nError & { node?: { name?: string } }, runData?: Record<string, N8nNodeRun[]> } } }} N8nExecution
 */

// ─── JSON Parse Helper ─────────────────────────────────────────
// Dual-accept shim: accepts real arrays/objects (the new contract), falls back
// to parsing stringified JSON with a one-off deprecation warning per process.
const _deprecationWarned = new Set();
/**
 * @param {unknown} value
 * @param {string} paramName
 * @param {string} [toolName]
 */
function parseJsonParam(value, paramName, toolName = '') {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'object') return value; // already real JSON
    if (typeof value === 'string') {
        const key = `${toolName}:${paramName}`;
        if (!_deprecationWarned.has(key)) {
            _deprecationWarned.add(key);
            log.warn(`[n8n-workflow] DEPRECATION: tool "${toolName}" received stringified JSON for "${paramName}". Pass a real JSON array/object instead. Stringified inputs will be rejected in a future release.`);
        }
        try {
            return JSON.parse(value);
        } catch (e) {
            throw new Error(`Invalid JSON for "${paramName}": ${e.message}`);
        }
    }
    throw new Error(`"${paramName}" must be a JSON array/object or a JSON string.`);
}

// ─── Deep-merge helper (objects merge recursively; arrays replace; primitives overwrite) ──
/**
 * @param {unknown} x
 * @returns {x is Record<string, unknown>}
 */
function isPlainObject(x) {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
}
/**
 * @param {{}} target  any value; a non-object is replaced by {}
 * @param {unknown} source
 * @returns {unknown}
 */
function deepMerge(target, source) {
    if (!isPlainObject(source)) return source; // arrays/primitives replace
    if (!isPlainObject(target)) target = {};
    /** @type {Record<string, unknown>} */
    const out = { ...target };
    for (const [k, v] of Object.entries(source)) {
        if (isPlainObject(v) && isPlainObject(out[k])) {
            out[k] = deepMerge(out[k], v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

// ─── node_operations applier ───────────────────────────────────
// Applies add/update/remove ops to a nodes+connections snapshot and returns a new one.
// On remove, also prunes every connection reference to the removed node (source and target).
/**
 * @param {{ nodes?: N8nNodeShape[], connections?: N8nConnections }} current
 * @param {Array<{ action?: string, node_name?: string, node_data?: unknown }>} ops
 * @param {string} toolName
 */
function applyNodeOperations(current, ops, toolName) {
    let nodes = Array.isArray(current.nodes) ? [...current.nodes] : [];
    let connections = current.connections && typeof current.connections === 'object'
        ? JSON.parse(JSON.stringify(current.connections))
        : {};

    for (const op of ops) {
        if (!op || !op.action) {
            throw new Error('Each node_operation must have an "action".');
        }
        const action = op.action;
        const nodeData = parseJsonParam(op.node_data, 'node_data', toolName);

        if (action === 'add') {
            if (!nodeData || typeof nodeData !== 'object') {
                throw new Error('node_operations: "add" requires node_data with a full node object.');
            }
            const name = op.node_name || nodeData.name;
            if (!name) throw new Error('node_operations: "add" requires node_name (or node_data.name).');
            if (nodes.some(n => n.name === name)) {
                throw new Error(`node_operations: "add" failed — a node named "${name}" already exists.`);
            }
            nodes.push({ ...nodeData, name });
            continue;
        }

        if (action === 'update') {
            const name = op.node_name;
            if (!name) throw new Error('node_operations: "update" requires node_name.');
            const idx = nodes.findIndex(n => n.name === name);
            if (idx === -1) throw new Error(`node_operations: node "${name}" not found.`);
            if (!nodeData || typeof nodeData !== 'object') {
                throw new Error('node_operations: "update" requires node_data with fields to merge.');
            }
            // Guard: do not allow renaming via update — it would silently break connections.
            if (nodeData.name && nodeData.name !== name) {
                throw new Error(`node_operations: cannot rename "${name}" via update — connections key on node name. Remove and re-add instead.`);
            }
            nodes[idx] = /** @type {N8nNodeShape} */ (deepMerge(nodes[idx], nodeData));
            continue;
        }

        if (action === 'remove') {
            const name = op.node_name;
            if (!name) throw new Error('node_operations: "remove" requires node_name.');
            const before = nodes.length;
            nodes = nodes.filter(n => n.name !== name);
            if (nodes.length === before) {
                throw new Error(`node_operations: node "${name}" not found.`);
            }
            // Prune connections referencing the removed node.
            delete connections[name]; // source-side entry
            for (const src of Object.keys(connections)) {
                const outputsByType = connections[src];
                for (const outputType of Object.keys(outputsByType)) {
                    const sockets = outputsByType[outputType]; // array of arrays
                    outputsByType[outputType] = sockets.map((/** @type {N8nConnectionTarget[] | null} */ socket) =>
                        (socket || []).filter((/** @type {N8nConnectionTarget} */ target) => target && target.node !== name)
                    );
                }
            }
            continue;
        }

        throw new Error(`node_operations: unknown action "${action}" (expected add | update | remove).`);
    }

    return { nodes, connections };
}

// ─── Connection integrity check ────────────────────────────────
// Post-condition: every source key and target reference in `connections` must
// exist in `nodes[]`. Catches drift from partial updates or renames.
/**
 * @param {N8nNodeShape[]} nodes
 * @param {N8nConnections | null | undefined} connections
 */
function assertConnectionsIntegrity(nodes, connections) {
    if (!connections || typeof connections !== 'object') return;
    const names = new Set(nodes.map(n => n.name));
    /** @type {string[]} */
    const orphans = [];
    for (const src of Object.keys(connections)) {
        if (!names.has(src)) { orphans.push(`source "${src}"`); continue; }
        const outputsByType = connections[src];
        if (!outputsByType || typeof outputsByType !== 'object') continue;
        for (const outputType of Object.keys(outputsByType)) {
            const sockets = outputsByType[outputType];
            if (!Array.isArray(sockets)) continue;
            for (const socket of sockets) {
                if (!Array.isArray(socket)) continue;
                for (const target of socket) {
                    if (target && target.node && !names.has(target.node)) {
                        orphans.push(`target "${target.node}" (from "${src}")`);
                    }
                }
            }
        }
    }
    if (orphans.length) {
        throw new Error(`Connection integrity check failed — ${orphans.length} orphaned reference(s): ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ', ...' : ''}`);
    }
}

// ─── Workflow Summary Helper ───────────────────────────────────

/**
 * @param {{ id?: string, name?: string, active?: boolean, nodes?: N8nNodeShape[], tags?: Array<string | { name?: string }>, createdAt?: string, updatedAt?: string }} wf
 */
function summarizeWorkflow(wf) {
    const nodes = (wf.nodes || []).filter(n => n.type !== 'n8n-nodes-base.stickyNote');
    return {
        id: wf.id,
        name: wf.name,
        active: wf.active,
        nodeCount: nodes.length,
        nodeTypes: [...new Set(nodes.map(n => n.type))],
        tags: (wf.tags || []).map(t => typeof t === 'string' ? t : t.name).filter(Boolean),
        createdAt: wf.createdAt,
        updatedAt: wf.updatedAt,
    };
}

// ─── Node filter helpers ───────────────────────────────────────

/**
 * @param {unknown} obj
 * @param {string} path
 * @returns {unknown}
 */
function getByPath(obj, path) {
    if (!obj || !path) return undefined;
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
        if (cur === null || cur === undefined) return undefined;
        cur = /** @type {Record<string, unknown>} */ (cur)[p];
    }
    return cur;
}

/**
 * @param {{ nodes?: N8nNodeShape[] }} workflow
 * @param {{ node_type_pattern?: string, node_names?: string[], has_param?: string }} filters
 */
function filterNodes(workflow, { node_type_pattern, node_names, has_param }) {
    const nodes = workflow.nodes || [];
    const hasAny = !!(node_type_pattern || (node_names && node_names.length) || has_param);
    if (!hasAny) return []; // require at least one filter

    const typeRe = node_type_pattern ? new RegExp(node_type_pattern, 'i') : null;
    const nameSet = Array.isArray(node_names) && node_names.length ? new Set(node_names) : null;

    return nodes.filter(n => {
        if (typeRe && !typeRe.test(n.type || '')) return false;
        if (nameSet && !nameSet.has(n.name)) return false;
        if (has_param) {
            const val = getByPath(n.parameters || {}, has_param);
            if (val === undefined || val === null) return false;
        }
        return true;
    });
}

// ─── Execution summary helpers ─────────────────────────────────

/** @param {N8nExecution | null | undefined} exec */
function summarizeExecution(exec) {
    if (!exec) return null;
    return {
        id: exec.id,
        workflow_id: exec.workflowId || exec.workflow_id,
        status: exec.status || (exec.finished ? (exec.data?.resultData?.error ? 'error' : 'success') : 'running'),
        mode: exec.mode,
        started_at: exec.startedAt,
        stopped_at: exec.stoppedAt,
        finished: !!exec.finished,
        retryOf: exec.retryOf || null,
    };
}

/** @param {N8nExecution | null | undefined} exec */
function buildExecutionDetail(exec) {
    const nodes = exec?.data?.resultData?.runData || {};
    /** @type {Record<string, { executionTime?: number, startTime?: number, output: unknown[], error: { message?: string, name?: string, stack?: string, description?: string } | null }>} */
    const nodeDetails = {};
    for (const [nodeName, runs] of Object.entries(nodes)) {
        // runs is an array of per-run results; we take the last run for each node
        const last = runs[runs.length - 1];
        if (!last) continue;
        /** @type {{ executionTime?: number, startTime?: number, output: unknown[], error: { message?: string, name?: string, stack?: string, description?: string } | null }} */
        const entry = {
            executionTime: last.executionTime,
            startTime: last.startTime,
            // Output data — capped at 5 items per node to keep context small
            output: [],
            error: null,
        };
        if (last.error) {
            entry.error = {
                message: last.error.message,
                name: last.error.name,
                stack: typeof last.error.stack === 'string' ? last.error.stack.slice(0, 2000) : undefined,
                description: last.error.description,
            };
        }
        const mainOut = last.data?.main;
        if (Array.isArray(mainOut) && mainOut.length > 0) {
            // mainOut is an array of branches; each branch is an array of items
            for (const branch of mainOut) {
                if (!Array.isArray(branch)) continue;
                entry.output.push(...branch.slice(0, 5).map(item => item?.json ?? item));
                if (entry.output.length >= 5) { entry.output = entry.output.slice(0, 5); break; }
            }
        }
        nodeDetails[nodeName] = entry;
    }

    const topError = exec?.data?.resultData?.error;
    return {
        ...summarizeExecution(exec),
        error: topError ? {
            message: topError.message,
            node: topError.node?.name,
            stack: typeof topError.stack === 'string' ? topError.stack.slice(0, 2000) : undefined,
        } : null,
        nodes: nodeDetails,
    };
}

// ─── Strip read-only fields before PUT (n8n rejects some) ──────
const READ_ONLY_WORKFLOW_FIELDS = [
    'active', 'id', 'createdAt', 'updatedAt', 'versionId', 'hash', 'meta',
    'shared', 'homeProject', 'tags', 'usedCredentials', 'pinnedData', 'triggerCount',
];

// n8n's PUT /workflows/:id validates `settings` with `additionalProperties: false`,
// so ANY key outside this whitelist makes the whole request 400. The current
// workflow's settings object (returned from GET) often contains keys n8n itself
// added that are NOT in the PUT schema (like `executionTimeout`, internal flags,
// or legacy keys from older versions). If we blindly round-trip settings we get
// "request/body/settings must NOT have additional properties".
// Solution: filter settings to only the keys n8n currently accepts on PUT.
const SETTINGS_WHITELIST = new Set([
    'executionOrder',
    'saveManualExecutions',
    'saveDataErrorExecution',
    'saveDataSuccessExecution',
    'saveExecutionProgress',
    'timezone',
    'errorWorkflow',
    'callerPolicy',
    'executionTimeout',
    'maxExecutionTimeout',
]);
/**
 * @param {unknown} settings
 * @returns {Record<string, unknown>}
 */
function sanitiseSettings(settings) {
    if (!settings || typeof settings !== 'object') return {};
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(settings)) {
        if (SETTINGS_WHITELIST.has(k) && v !== null && v !== undefined) out[k] = v;
    }
    return out;
}

/** @param {Record<string, unknown>} wf */
function stripReadOnly(wf) {
    const out = { ...wf };
    for (const k of READ_ONLY_WORKFLOW_FIELDS) delete out[k];
    // Filter settings to n8n's PUT schema — prevents the common 400 error.
    if ('settings' in out) out.settings = sanitiseSettings(out.settings);
    return out;
}

module.exports = {
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
};
