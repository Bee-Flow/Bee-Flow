const { spawn } = require('child_process');
const path = require('path');
const componentManager = require('./cms/componentManager');
const watcherStateStore = require('../stores/watcherStateStore');
const { buildMcpChildEnv } = require('./mcpChildEnv');
const log = require('../telemetry/log');
// @typecheck
/**
 * Variables a component child gets on top of the MCP child allow-list.
 *
 * Paths, not secrets: NODE_EXTRA_CA_CERTS lets the web-fetching components
 * verify HTTPS behind a TLS-inspecting proxy; ATTACHMENTS_DIR is the only
 * folder email-sender-smtp attaches files from, ATTACHMENT_MAX_BYTES its size cap.
 */
const COMPONENT_EXTRA_ENV = Object.freeze(['NODE_EXTRA_CA_CERTS', 'ATTACHMENTS_DIR', 'ATTACHMENT_MAX_BYTES']);

/**
 * The environment a component's index.js runs with.
 *
 * A component is a directory of code (until 2026-10 it could be written from a
 * request). It used to be spawned with `env: process.env`, which handed
 * that code every
 * secret the server holds (MASTER_ENCRYPTION_KEY, DATABASE_URL,
 * OPAQUE_SERVER_SETUP, provider API keys, licence and session secrets). A
 * component needs none of them: what it needs from the server (the caller's
 * Nextcloud credentials) arrives on stdin as `_accessToken`/`_appPassword`
 * inputs, per run and per user.
 *
 * Same allow-list as MCP children (core/mcpChildEnv.js), for the same reason:
 * a deny-list leaks the next secret somebody adds to the server's env.
 *
 * @param {Record<string, string | undefined>} [source=process.env]
 * @returns {Record<string, string>} a fresh object, never process.env itself
 */
function buildComponentEnv(source = process.env) {
    /** @type {Record<string, string>} */
    const extra = {};
    for (const name of COMPONENT_EXTRA_ENV) {
        const value = source[name];
        if (value !== undefined) extra[name] = value;
    }
    return /** @type {Record<string, string>} */ (buildMcpChildEnv(extra, source));
}

async function executeWorkflow(workflow, userAuth = {}) {
    log.info('Executing workflow with', workflow.nodes.length, 'nodes');

    const executionResults = {}; // nodeId -> output

    // 1. Build Dependency Graph
    const adjList = {};
    const inDegree = {};
    workflow.nodes.forEach(node => {
        adjList[node.id] = [];
        inDegree[node.id] = 0;
    });

    workflow.edges.forEach(edge => {
        if (adjList[edge.source]) {
            adjList[edge.source].push(edge.target);
            inDegree[edge.target] = (inDegree[edge.target] || 0) + 1;
        }
    });

    // 2. Queue of ready nodes
    const queue = workflow.nodes.filter(node => inDegree[node.id] === 0);
    const sortedNodes = [];

    while (queue.length > 0) {
        const node = queue.shift();
        sortedNodes.push(node);

        if (adjList[node.id]) {
            adjList[node.id].forEach(neighbor => {
                inDegree[neighbor]--;
                if (inDegree[neighbor] === 0) {
                    const neighborNode = workflow.nodes.find(n => n.id === neighbor);
                    queue.push(neighborNode);
                }
            });
        }
    }

    if (sortedNodes.length !== workflow.nodes.length) {
        throw new Error('Cycle detected or disconnected nodes in workflow');
    }

    // 3. Execute in order
    for (const node of sortedNodes) {
        // For 'custom' type nodes, use componentId from data; otherwise use node.type
        const componentId = (node.type === 'custom' || node.type === 'default')
            ? (node.data?.componentId || node.type)
            : node.type;

        log.info(`Running node ${node.id} (${componentId})...`);
        const componentPath = componentManager.getComponentPath(componentId);

        if (!componentPath) {
            log.warn(`Component ${componentId} not found, skipping execution.`);
            executionResults[node.id] = {};
            continue;
        }

        // Prepare Inputs - start with static values from node configuration
        // Check both 'inputs' and 'inputValues' for compatibility
        const inputs = { ...(node.data.inputs || {}), ...(node.data.inputValues || {}) };

        // Inject user auth info for components that need it
        if (userAuth.accessToken) {
            inputs._accessToken = userAuth.accessToken;
        }
        if (userAuth.nextcloudUrl) {
            inputs._nextcloudUrl = userAuth.nextcloudUrl;
        }
        if (userAuth.appPasswordUsername) {
            inputs._appPasswordUsername = userAuth.appPasswordUsername;
        }
        if (userAuth.appPassword) {
            inputs._appPassword = userAuth.appPassword;
        }

        // Find incoming edges to this node and map connected values
        const incomingEdges = workflow.edges.filter(e => e.target === node.id);
        incomingEdges.forEach(edge => {
            const sourceResult = executionResults[edge.source];
            if (!sourceResult) return;

            // Parse handle IDs to determine field mapping
            // sourceHandle format: "output-{fieldName}-{type}" or "output-{fieldName}" or null
            // targetHandle format: "input-{fieldName}-{type}" or "input-{fieldName}" or null
            const sourceHandle = edge.sourceHandle || '';
            const targetHandle = edge.targetHandle || '';

            // Extract field names from handles (handle format: prefix-fieldName or prefix-fieldName-type)
            const extractFieldName = (handleId, prefix) => {
                if (!handleId.startsWith(prefix + '-')) return null;
                const withoutPrefix = handleId.slice(prefix.length + 1); // Remove "output-" or "input-"
                // If there's a type suffix, remove it (fieldName-type -> fieldName)
                const parts = withoutPrefix.split('-');
                if (parts.length >= 2) {
                    // Last part might be type, rest is field name
                    // Check if last part looks like a type (normalize parameterized types like array<object> to array)
                    const knownTypes = ['string', 'number', 'boolean', 'object', 'array', 'any', 'json'];
                    const lastPart = parts[parts.length - 1];
                    const normalizedType = lastPart.includes('<') ? lastPart.split('<')[0] : lastPart;
                    if (knownTypes.includes(normalizedType)) {
                        return parts.slice(0, -1).join('-');
                    }
                }
                return withoutPrefix;
            };

            // Helper to get value at nested path (e.g., "result.files")
            const getValueAtPath = (obj, path) => {
                if (!path) return obj;
                const parts = path.split('.');
                let current = obj;
                for (const part of parts) {
                    if (current === null || current === undefined) return undefined;
                    current = current[part];
                }
                return current;
            };

            const sourceField = extractFieldName(sourceHandle, 'output');
            const targetField = extractFieldName(targetHandle, 'input');

            if (sourceField && targetField) {
                // Specific field-to-field mapping - support nested paths
                let sourceValue = getValueAtPath(sourceResult, sourceField);
                if (sourceValue !== undefined) {
                    inputs[targetField] = sourceValue;
                } else if (sourceResult.value !== undefined) {
                    // Fallback: check for 'value' field (common for Manual Input)
                    inputs[targetField] = sourceResult.value;
                }
            } else if (sourceField) {
                // Source specific, target generic - use source field value
                let sourceValue = getValueAtPath(sourceResult, sourceField);
                if (sourceValue !== undefined) {
                    Object.assign(inputs, { [sourceField]: sourceValue });
                }
            } else if (targetField) {
                // Source generic, target specific - try to get first value or 'value'
                if (sourceResult.value !== undefined) {
                    inputs[targetField] = sourceResult.value;
                } else {
                    // Use first key from result
                    const firstKey = Object.keys(sourceResult)[0];
                    if (firstKey) {
                        inputs[targetField] = sourceResult[firstKey];
                    }
                }
            } else {
                // Both generic - merge all outputs into inputs
                Object.assign(inputs, sourceResult);
            }
        });

        log.info(`Node ${node.id} inputs:`, inputs);

        // Run Component
        try {
            let output = await runComponent(componentPath, inputs);

            // Special handling for watcher trigger - also execute the watch component
            if (componentId === 'trigger-watcher' && output?.result?.config?.componentId) {
                const watchComponentId = output.result.config.componentId;
                const watchInputs = { ...(output.result.config.componentInputs || {}) };

                // Create unique watcher ID based on component and inputs
                const watcherId = `${node.id}_${watchComponentId}_${JSON.stringify(watchInputs)}`;

                // Add auth to watch component inputs
                if (userAuth.accessToken) watchInputs._accessToken = userAuth.accessToken;
                if (userAuth.nextcloudUrl) watchInputs._nextcloudUrl = userAuth.nextcloudUrl;
                if (userAuth.appPasswordUsername) watchInputs._appPasswordUsername = userAuth.appPasswordUsername;
                if (userAuth.appPassword) watchInputs._appPassword = userAuth.appPassword;

                const watchComponentPath = componentManager.getComponentPath(watchComponentId);
                if (watchComponentPath) {
                    try {
                        const watchResult = await runComponent(watchComponentPath, watchInputs);
                        // Extract items from watch result
                        let currentItems = [];
                        if (watchResult?.result) {
                            if (Array.isArray(watchResult.result)) {
                                currentItems = watchResult.result;
                            } else if (Array.isArray(watchResult.result.files)) {
                                currentItems = watchResult.result.files;
                            } else if (Array.isArray(watchResult.result.items)) {
                                currentItems = watchResult.result.items;
                            } else if (Array.isArray(watchResult.result.events)) {
                                currentItems = watchResult.result.events;
                            } else if (Array.isArray(watchResult.result.contacts)) {
                                currentItems = watchResult.result.contacts;
                            } else if (Array.isArray(watchResult.result.tasks)) {
                                currentItems = watchResult.result.tasks;
                            }
                        }

                        // Get previous state from SQLite
                        const prevState = await watcherStateStore.getWatcherState(watcherId);
                        const prevItems = prevState?.items || {};
                        const previousItems = Object.values(prevItems).map(p => p.data);

                        // Detect changes
                        const getId = (item) => item.id || item.filename || item.href || item.name || JSON.stringify(item);
                        const getModified = (item) => item.lastmod || item.modified || item.updatedAt || item.mtime;

                        const changes = { added: [], modified: [], removed: [] };
                        const currentItemMap = {};

                        currentItems.forEach(item => {
                            const itemId = getId(item);
                            currentItemMap[itemId] = {
                                modified: getModified(item),
                                data: item
                            };

                            if (!prevItems[itemId]) {
                                changes.added.push(item);
                            } else if (prevItems[itemId].modified !== getModified(item)) {
                                changes.modified.push(item);
                            }
                        });

                        // Check for removed items
                        Object.keys(prevItems).forEach(itemId => {
                            if (!currentItemMap[itemId]) {
                                changes.removed.push(prevItems[itemId].data);
                            }
                        });

                        // Save current state to SQLite for next comparison
                        await watcherStateStore.saveWatcherState(watcherId, currentItemMap);

                        // Update output with actual data
                        output.result.currentItems = currentItems;
                        output.result.previousItems = previousItems;
                        output.result.addedItems = changes.added;
                        output.result.modifiedItems = changes.modified;
                        output.result.removedItems = changes.removed;
                        output.result.hasChanges = changes.added.length > 0 || changes.modified.length > 0 || changes.removed.length > 0;
                        output.result.watchComponentResult = watchResult.result;
                    } catch (watchErr) {
                        log.error('Failed to execute watch component:', watchErr);
                        output.result.watchError = watchErr.message;
                    }
                }
            }

            executionResults[node.id] = output;
            log.info(`Node ${node.id} finished with output:`, output);
        } catch (err) {
            log.error(`Node ${node.id} failed:`, err);
            throw err;
        }
    }

    return executionResults;
}

/**
 * Wall-clock limit for one component run. A component that hangs (an endless
 * loop, a socket that never answers) used to keep its workflow, and the chat
 * turn or HTTP request awaiting it, pending forever. Generous on purpose: the
 * bundled components that fetch the web (website-sitemap-fetcher walks nested
 * sitemaps with a per-request timeout of its own) finish far inside it.
 */
const COMPONENT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Most stdout a component may produce. Its stdout is buffered in the server's
 * heap until the child exits, so a component that floods it could exhaust the
 * memory of a server every tenant shares. Above the cap the child is killed
 * and the run fails, like exec's maxBuffer.
 */
const COMPONENT_MAX_STDOUT_BYTES = 32 * 1024 * 1024;

/**
 * stderr only ends up in the error message of a failed run, so it is not a
 * reason to fail: past this many bytes the rest is dropped.
 */
const COMPONENT_MAX_STDERR_BYTES = 64 * 1024;

/**
 * @param {string} componentPath
 * @param {unknown} inputs
 * @param {{ timeoutMs?: number, maxStdoutBytes?: number, maxStderrBytes?: number }} [limits]
 *   overridable for tests; production callers use the defaults.
 * @returns {Promise<any>}
 */
function runComponent(componentPath, inputs, limits = {}) {
    const timeoutMs = limits.timeoutMs ?? COMPONENT_TIMEOUT_MS;
    const maxStdoutBytes = limits.maxStdoutBytes ?? COMPONENT_MAX_STDOUT_BYTES;
    const maxStderrBytes = limits.maxStderrBytes ?? COMPONENT_MAX_STDERR_BYTES;

    return new Promise((resolve, reject) => {
        const entryFile = path.join(componentPath, 'index.js');

        // We use 'spawn' to run a separate node process.
        // We pass inputs via STDIN JSON string.
        const child = spawn('node', [entryFile], {
            cwd: componentPath, // FORCE CWD to component folder for node_modules resolution
            // Never process.env: see buildComponentEnv.
            env: buildComponentEnv(),
        });

        /** @type {Buffer[]} */
        const stdoutChunks = [];
        let stdoutBytes = 0;
        let stderrData = '';
        let stderrBytes = 0;
        let settled = false;
        /** @type {Error | null} why the server killed the child, if it did */
        let killReason = null;

        const kill = (/** @type {Error} */ reason) => {
            if (killReason) return;
            killReason = reason;
            child.kill('SIGKILL');
        };

        const fail = (/** @type {Error} */ err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        };

        const timer = setTimeout(() => {
            kill(new Error(`Component timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        // A pending run must not keep the process alive on shutdown by itself.
        timer.unref?.();

        child.stdout.on('data', (data) => {
            if (killReason) return;
            stdoutBytes += data.length;
            if (stdoutBytes > maxStdoutBytes) {
                stdoutChunks.length = 0;
                kill(new Error(`Component output exceeded ${maxStdoutBytes} bytes`));
                return;
            }
            stdoutChunks.push(data);
        });

        child.stderr.on('data', (data) => {
            if (stderrBytes >= maxStderrBytes) return;
            const room = maxStderrBytes - stderrBytes;
            const slice = data.length > room ? data.subarray(0, room) : data;
            stderrBytes += slice.length;
            stderrData += slice.toString();
        });

        // spawn failures (ENOENT, EAGAIN) arrive here, not on 'close'.
        child.on('error', (err) => {
            fail(err);
        });

        // A child that dies before reading its input makes the write fail
        // with EPIPE; the exit code on 'close' is the error that matters.
        child.stdin.on('error', () => {});

        child.on('close', (code) => {
            clearTimeout(timer);
            if (settled) return;
            if (killReason) return fail(killReason);
            if (code !== 0) {
                return fail(new Error(`Component exited with code ${code}: ${stderrData}`));
            }
            const stdoutData = Buffer.concat(stdoutChunks).toString();
            try {
                // Rule: Component MUST output a JSON string as its whole stdout.
                const jsonOutput = JSON.parse(stdoutData.trim());
                settled = true;
                resolve(jsonOutput);
            } catch (e) {
                log.error("Failed to parse output:", stdoutData);
                fail(new Error(`Invalid JSON output from component: ${e.message}`));
            }
        });

        // Write inputs
        child.stdin.write(JSON.stringify(inputs));
        child.stdin.end();
    });
}

module.exports = {
    executeWorkflow,
    // Exported for executionEngine.env.test.js.
    runComponent,
    buildComponentEnv,
};
