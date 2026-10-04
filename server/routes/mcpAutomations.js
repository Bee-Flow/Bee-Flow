/**
 * Automations as an MCP server — build Bee Flow automations from an external editor.
 *
 * The sibling of routes/mcpStudio.js. `routes/mcpServer.js` exposes the
 * caller's INTEGRATION tools (mail, calendar, automations) so an assistant can act
 * on their behalf; mcpStudio.js exposes the App Studio BUILDER toolset. This is
 * the third surface: the AUTOMATION builder toolset, so a coding agent — Claude
 * Code in VS Code — authors and edits real automations in a running instance.
 *
 * What it replaces: an automation was previously either talked into existence
 * through the in-product builder agent, or drawn by hand on the canvas. Neither
 * is reachable from outside the browser, so the only remaining option for an
 * agent was to write definition JSON straight into the row — bypassing the
 * builder's binding fixups and learning the contract by trial and error. Over
 * MCP the edit goes through the SAME tools the product uses, and the validator
 * answers in the same words.
 *
 * ── Gate ────────────────────────────────────────────────────────────────────
 * Off unless AUTOMATION_MCP_ENABLED=1. index.js only requires and mounts this
 * file when automation/mcpBuilder.isEnabled() says so, so on a default install
 * the path does not exist and the module is never even loaded. Three more gates
 * sit behind it, and all four must pass:
 *
 *   1. AUTOMATION_MCP_ENABLED=1                      (operator, this file)
 *   2. a valid `bfmcp.…` bearer token                (per user, mcpServer.js)
 *   3. the `automations` beta feature for that user  (entitlements)
 *   4. the automation is owned by that user             (per automation, mcpBuilder.js)
 *
 * Gate 3 is deliberately the SAME predicate that guards every authenticated
 * /api/automation route (`requireBetaFeature('automations')` in
 * routes/automation.js). App Studio's twin checks a licence CAPABILITY because
 * that is what guards its REST routes; copying the mechanism rather than the
 * name would have let an org build automations over MCP that it cannot build in
 * the product.
 *
 * ── Token ───────────────────────────────────────────────────────────────────
 * Deliberately the SAME token as /mcp and /mcp/studio
 * (`bfmcp.<base64url(userId)>.<64 hex>`, minted by routes/mcpServerTokens.js or
 * server/scripts/mint-mcp-token.js). A third token type would mean a third
 * secret to rotate and a third way to get revocation wrong, for no gain: every
 * endpoint already grants exactly what that one user can do, and the surfaces
 * are separated by their env flags and entitlement checks, not by the
 * credential.
 *
 * ── Wiring it up ────────────────────────────────────────────────────────────
 *   claude mcp add --transport http beeflow-automations \
 *     http://localhost:3001/mcp/automations \
 *     --header "Authorization: Bearer bfmcp.…"
 *
 * The protocol is hand-rolled JSON-RPC for the same reason mcpServer.js gives:
 * the SDK is ESM-only and its transport wants to own the response, while this
 * has to live inside the existing Express app.
 */

const express = require('express');
const mcpBuilder = require('../automation/mcpBuilder');
// No validate() middleware here, for the reason routes/mcpServer.js gives:
// the envelope is JSON-RPC's, and so is every refusal. classifyRpc and
// parseToolCall are those refusals, shared by all three MCP surfaces.
const { authenticateToken, PROTOCOL_VERSION, classifyRpc, parseToolCall, INVALID_REQUEST } = require('./mcpServer');
const log = require('../telemetry/log');

const router = express.Router();

/**
 * Sent to the client on initialize. MCP clients put this in the model's
 * context, so it is the one place to say the things a caller cannot infer from
 * tool schemas: read the guide first, every builder_* call needs an
 * automationId, and nothing runs until a human activates it.
 */
const INSTRUCTIONS = [
    'Bee Flow Automations. These tools author real automations in this Bee Flow instance — every call reads and writes the live database, there is no staging copy.',
    '',
    'Start of session: call automations_get_guide once. It returns the trigger catalog, the step vocabulary with every field, the binding kinds (literal/ref/template/expr) and the restricted expression grammar. The builder_* tool descriptions teach the CALL PROTOCOL only; step types and binding shapes come from the guide, and anything invented without it gets rejected by the validator.',
    '',
    'Then: automations_list to find an automation, or automations_create to make one. Every builder_* tool takes the automationId — each call is independent and re-reads the automation from the database.',
    '',
    'Build order that works: builder_propose_trigger (how it starts) → the builder_add_* tools in execution order, each with afterStepId so the edges wire themselves → branch with builder_add_condition / builder_add_switch → builder_wire_error_branch where a failure needs its own path. Verify with builder_request_dry_run and fix every finding before builder_finalize.',
    '',
    'A finalised automation is still INACTIVE. Activation is a human decision made in the product — these tools cannot switch an automation on, and that is deliberate: an automation sends real mail and writes to real systems.',
    '',
    'Tool results carry `_fixHint` when a call was rejected, and `validationErrors` when a save landed but the definition is not yet valid. Both are worth reading: they are how this API teaches its own shape.',
].join('\n');

// ── JSON-RPC ────────────────────────────────────────────────────────────────

function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Automations are a beta feature (`requireBetaFeature('automations')` guards every
 * authenticated /api/automation route). Checked per call rather than per
 * connection: a long-lived MCP client would otherwise keep building after the
 * org's access was withdrawn.
 */
async function assertEntitled(userId) {
    const { userHasBetaFeature } = require('../core/entitlements/betaFeatures');
    let ok = false;
    try {
        ok = await userHasBetaFeature(userId, 'automations');
    } catch (e) {
        // Fail CLOSED. An entitlement lookup that errors is not permission.
        log.warn(`[automations-mcp] entitlement check failed for user=${userId}: ${e.message}`);
        return false;
    }
    // Without this line the symptom is an empty tool list and no explanation
    // anywhere — the client shows a server with nothing on it and the operator
    // has no way to tell "not enabled" from "misconfigured".
    if (!ok) log.warn(`[automations-mcp] 'automations' beta feature denied for user=${userId} — advertising no tools`);
    return ok;
}

async function handleRpc(message, userId) {
    const call = classifyRpc(message);
    if (call.kind === 'invalid') return rpcError(call.id, -32600, INVALID_REQUEST);
    if (call.kind !== 'request') return null; // notifications and client responses get no answer
    const { id, method, params } = call;

    switch (method) {
        case 'initialize':
            return rpcResult(id, {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'bee-flow-automations', version: '1.0.0' },
                instructions: INSTRUCTIONS,
            });

        case 'ping':
            return rpcResult(id, {});

        case 'notifications/initialized':
            return null; // notification — no response

        case 'tools/list': {
            if (!await assertEntitled(userId)) {
                // An empty list rather than an error: a client that cannot use
                // the tools should show none, not fail to connect.
                return rpcResult(id, { tools: [] });
            }
            return rpcResult(id, { tools: mcpBuilder.buildToolList() });
        }

        case 'tools/call': {
            const toolCall = parseToolCall(params);
            if (toolCall.error) return rpcError(id, -32602, toolCall.error);
            const { name, args } = toolCall;

            if (!await assertEntitled(userId)) {
                return rpcResult(id, {
                    content: [{ type: 'text', text: 'Automations are not available on this account (the "automations" feature is not enabled for it).' }],
                    isError: true,
                });
            }

            try {
                const { result, text } = await mcpBuilder.callTool(name, args, { userId });
                const isError = !!(result && typeof result === 'object' && result.error);
                return rpcResult(id, {
                    content: [{ type: 'text', text: text ?? JSON.stringify(result ?? null) }],
                    isError,
                });
            } catch (err) {
                // callTool is contracted not to throw; this is belt-and-braces,
                // and it still comes back as a tool error the agent can read
                // rather than a transport failure it cannot.
                log.error('[automations-mcp] tool error:', err.message);
                return rpcResult(id, {
                    content: [{ type: 'text', text: `Tool execution failed: ${err.message}` }],
                    isError: true,
                });
            }
        }

        default:
            return rpcError(id, -32601, `Method not found: ${method}`);
    }
}

// Streamable HTTP: one POST carrying a JSON-RPC message or a batch. The limit
// matches /mcp/studio's: a single builder_add_steps call can carry a whole
// branch's worth of nodes, each with prompts and output schemas.
router.post('/', express.json({ limit: '8mb' }), async (req, res) => {
    const userId = await authenticateToken(req.headers.authorization);
    if (!userId) {
        res.set('WWW-Authenticate', 'Bearer realm="bee-flow"');
        return res.status(401).json(rpcError(null, -32001, 'Unauthorized'));
    }

    const body = req.body;
    const messages = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const message of messages) {
        try {
            const out = await handleRpc(message, userId);
            if (out) responses.push(out);
        } catch (err) {
            log.error('[automations-mcp] handler error:', err.message);
            // Only a request is answered — not even an error goes back to a notification.
            if (classifyRpc(message).kind === 'request') responses.push(rpcError(message.id, -32603, 'Internal error'));
        }
    }
    if (!responses.length) return res.status(202).end();
    return res.json(Array.isArray(body) ? responses : responses[0]);
});

// Same honest answer as /mcp: no SSE stream is opened, so say so instead of
// leaving a probing client hanging.
router.get('/', async (req, res) => {
    const userId = await authenticateToken(req.headers.authorization);
    if (!userId) {
        res.set('WWW-Authenticate', 'Bearer realm="bee-flow"');
        return res.status(401).json(rpcError(null, -32001, 'Unauthorized'));
    }
    return res.status(405).json(rpcError(null, -32000, 'This MCP endpoint is POST-only; it does not open an SSE stream.'));
});

module.exports = router;
module.exports.handleRpc = handleRpc;
module.exports.INSTRUCTIONS = INSTRUCTIONS;
