/**
 * App Studio as an MCP server — build Bee Flow apps from an external editor.
 *
 * `routes/mcpServer.js` exposes the caller's INTEGRATION tools (mail, calendar,
 * automations) so an assistant can act on their behalf. This is the other half of
 * the platform story: the App Studio BUILDER toolset, so a coding agent — Claude
 * Code in VS Code — authors and edits real apps in a running instance.
 *
 * What it replaces: until now a bespoke customer app was either talked into
 * existence through the in-product builder, or written as a module under
 * appStudio/templates/ and shipped by rebuilding the API image (server/Dockerfile
 * `COPY . .`). Templates stay the right answer for something every tenant gets;
 * they are a bad answer for iterating on one customer's app, where each round
 * trip costs a build, a push and a redeploy. Over MCP the edit lands in the
 * database of the instance you are pointed at, and the image never changes.
 *
 * ── Gate ────────────────────────────────────────────────────────────────────
 * Off unless STUDIO_MCP_ENABLED=1. index.js only requires and mounts this file
 * when appStudio/mcpBuilder.isEnabled() says so, so on a default install the
 * path does not exist and the module is never even loaded. Three more gates sit
 * behind it, and all four must pass:
 *
 *   1. STUDIO_MCP_ENABLED=1                          (operator, this file)
 *   2. a valid `bfmcp.…` bearer token                (per user, mcpServer.js)
 *   3. the app_studio capability for that user       (licence/entitlements)
 *   4. canWriteStudioApp on the target app           (per app, mcpBuilder.js)
 *
 * The env flag is what makes this safe to ship enabled-nowhere: an endpoint
 * that authors application logic with a static token is exactly the kind of
 * surface that should not appear on a self-host box because someone minted a
 * token for the Nextcloud assistant.
 *
 * ── Token ───────────────────────────────────────────────────────────────────
 * Deliberately the SAME token as /mcp (`bfmcp.<base64url(userId)>.<64 hex>`,
 * minted by routes/mcpServerTokens.js or server/scripts/mint-mcp-token.js).
 * A second token type would mean a second secret to rotate and a second way to
 * get revocation wrong, for no gain: both endpoints already grant exactly what
 * that one user can do, and the surfaces are separated by the env flag and the
 * capability check, not by the credential.
 *
 * ── Wiring it up ────────────────────────────────────────────────────────────
 *   claude mcp add --transport http beeflow-studio \
 *     http://localhost:3101/mcp/studio \
 *     --header "Authorization: Bearer bfmcp.…"
 *
 * The protocol is hand-rolled JSON-RPC for the same reason mcpServer.js gives:
 * the SDK is ESM-only and its transport wants to own the response, while this
 * has to live inside the existing Express app.
 */

const express = require('express');
const mcpBuilder = require('../appStudio/mcpBuilder');
// No validate() middleware here, for the reason routes/mcpServer.js gives:
// the envelope is JSON-RPC's, and so is every refusal. classifyRpc and
// parseToolCall are those refusals, shared by all three MCP surfaces.
const { PROTOCOL_VERSION, classifyRpc, parseToolCall, INVALID_REQUEST } = require('./mcpServer');
// Imported as authenticateMcp...: the access-registry sweep recognises a handler
// that authenticates by the name of its check, and this IS the credential gate.
const { gateRequest: authenticateMcpRequest, rpcDenied } = require('../auth/mcpAccess/gate');
const { batchTooLarge, rpcBatchTooLarge } = require('../auth/mcpAccess/batch');
const { scopeAllowsTool, filterToolsByScope } = require('../auth/mcpAccess/scopes');
const log = require('../telemetry/log');

const router = express.Router();

/**
 * Sent to the client on initialize. MCP clients put this in the model's
 * context, so it is the one place to say the two things a caller cannot infer
 * from tool schemas: read the guide first, and every app_* call needs an appId.
 * Kept short on purpose — the 17k-token guide is a tool call away, not a
 * permanent context tax.
 */
const INSTRUCTIONS = [
    'Bee Flow App Studio. These tools author real apps in this Bee Flow instance — every call reads and writes the live database, there is no staging copy.',
    '',
    'Start of session: call studio_get_guide once. It returns the component catalog, action/step vocabulary, binding kinds and formula functions. The app_* tool descriptions teach the CALL PROTOCOL only; component types, props and style knobs come from the guide, and anything invented without it gets rejected by the validator.',
    '',
    'Then: studio_list_apps to find an app, or studio_create_app to make one. Every app_* tool takes the appId — each call is independent and re-reads the app from the database.',
    '',
    'Build order that works: tables (app_upsert_table) → seed rows (app_seed_records) → screens (app_add_screen) → sections and components (app_add_section, app_add_components) → actions (app_set_action, app_bind_action). Verify with app_dry_run and app_screenshot — actually look at the screenshot — and fix findings before app_finalize.',
    '',
    'Tool results carry `_hints` when the canonicalizer repaired your input and `_fixHint` when a call was rejected. Both are worth reading: they are how this API teaches its own shape.',
].join('\n');

// ── JSON-RPC ────────────────────────────────────────────────────────────────

function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * App Studio is a licensed capability (`requireCapability('app_studio')` guards
 * every /api/studio-apps route). Checked per call rather than per connection:
 * a long-lived MCP client would otherwise keep building after the licence that
 * permitted it lapsed.
 */
async function assertCapability(userId) {
    const { hasCapability } = require('../core/entitlements/entitlements');
    const orgId = await require('../stores/userStore').getUser(userId)
        .then((u) => u?.organizationId || null)
        .catch(() => null);
    const ok = await hasCapability('app_studio', { userId, orgId });
    // Without this line the symptom is an empty tool list and no explanation
    // anywhere — the client shows a server with nothing on it and the operator
    // has no way to tell "licence" from "misconfigured".
    if (!ok) log.warn(`[studio-mcp] app_studio capability denied for user=${userId} org=${orgId || '-'} — advertising no tools`);
    return ok;
}

/**
 * @param {{ token?: { scopes?: object } }|null} [access]  what the access gate
 *        resolved for this request. Its token's scopes narrow tools/list and
 *        are re-checked on tools/call. Absent (unit tests calling this
 *        directly) = no narrowing.
 * @param {{ entitled?: (userId: string) => Promise<boolean> }} [deps]  test
 *        seam for the entitlement check, which needs the database.
 */
async function handleRpc(message, userId, access = null, deps = {}) {
    const scopes = access?.token?.scopes || null;
    const entitled = deps.entitled || assertCapability;
    const call = classifyRpc(message);
    if (call.kind === 'invalid') return rpcError(call.id, -32600, INVALID_REQUEST);
    if (call.kind !== 'request') return null; // notifications and client responses get no answer
    const { id, method, params } = call;

    switch (method) {
        case 'initialize':
            return rpcResult(id, {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'bee-flow-app-studio', version: '1.0.0' },
                instructions: INSTRUCTIONS,
            });

        case 'ping':
            return rpcResult(id, {});

        case 'notifications/initialized':
            return null; // notification — no response

        case 'tools/list': {
            if (!await entitled(userId)) {
                // An empty list rather than an error: a client that cannot use
                // the tools should show none, not fail to connect.
                return rpcResult(id, { tools: [] });
            }
            const listed = mcpBuilder.buildToolList();
            return rpcResult(id, { tools: scopes ? filterToolsByScope(scopes, 'studio', listed) : listed });
        }

        case 'tools/call': {
            const toolCall = parseToolCall(params);
            if (toolCall.error) return rpcError(id, -32602, toolCall.error);
            const { name, args } = toolCall;

            // The token's own scope, on top of the account's entitlement below.
            if (scopes) {
                const tool = mcpBuilder.buildToolList().find((t) => t.name === name);
                if (!scopeAllowsTool(scopes, 'studio', name, { readOnly: tool?.annotations?.readOnlyHint === true })) {
                    return rpcResult(id, {
                        content: [{ type: 'text', text: `Tool "${name}" is not available to this token.` }],
                        isError: true,
                    });
                }
            }

            if (!await entitled(userId)) {
                return rpcResult(id, {
                    content: [{ type: 'text', text: 'App Studio is not available on this account (the app_studio capability is not licensed for it).' }],
                    isError: true,
                });
            }

            try {
                const { result, image, text } = await mcpBuilder.callTool(name, args, { userId });
                const isError = !!(result && typeof result === 'object' && result.error);
                const content = [{ type: 'text', text: text ?? JSON.stringify(result ?? null) }];
                if (image) {
                    content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
                }
                return rpcResult(id, { content, isError });
            } catch (err) {
                // callTool is contracted not to throw; this is belt-and-braces,
                // and it still comes back as a tool error the agent can read
                // rather than a transport failure it cannot.
                log.error('[studio-mcp] tool error:', err.message);
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
// is larger than /mcp's 4mb because a single app_add_components call can carry
// a whole screen's worth of nodes, and the definition ceiling is 512kb before
// JSON overhead.
router.post('/', express.json({ limit: '8mb' }), async (req, res) => {
    const access = await authenticateMcpRequest(req, 'studio');
    if (!access.ok) return rpcDenied(res, access.status, null, access.retryAfter);
    const userId = access.user.id;

    if (batchTooLarge(req.body)) return rpcBatchTooLarge(res);
    const body = req.body;
    const messages = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const message of messages) {
        try {
            const out = await handleRpc(message, userId, access);
            if (out) responses.push(out);
        } catch (err) {
            log.error('[studio-mcp] handler error:', err.message);
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
    const access = await authenticateMcpRequest(req, 'studio');
    if (!access.ok) return rpcDenied(res, access.status, null, access.retryAfter);
    return res.status(405).json(rpcError(null, -32000, 'This MCP endpoint is POST-only; it does not open an SSE stream.'));
});

module.exports = router;
module.exports.handleRpc = handleRpc;
module.exports.INSTRUCTIONS = INSTRUCTIONS;
// The same capability test, for routes/mcpTokens.js: a token may not carry the
// studio server for a user this check would refuse.
module.exports.assertCapability = assertCapability;
