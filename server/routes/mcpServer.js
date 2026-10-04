/**
 * Bee Flow as an MCP server.
 *
 * Until now `core/mcpManager.js` was consume-only: Bee Flow could call other
 * people's MCP servers, but nothing could call Bee Flow. That makes us an app.
 * Serving MCP makes us a platform — and specifically it makes every Bee Flow
 * integration tool and every agent-callable automation available inside
 * Nextcloud's own Assistant, because Context Agent takes remote MCP servers
 * straight from its admin settings:
 *
 *   { "bee-flow": { "url": "https://server.beeflow.nl/mcp",
 *                   "transport": "streamable_http" } }
 *
 * ── Authentication ──────────────────────────────────────────────────────────
 * MCP clients send a static `Authorization: Bearer <token>` from a config file,
 * so session cookies are not an option. Each user mints their own token:
 *
 *   bfmcp.<base64url(userId)>.<64 hex>
 *
 * The user id travels in the clear on purpose — it is not a secret, and
 * embedding it means a presented token resolves to exactly one stored secret
 * without needing a reverse index or a migration. The random half is compared
 * in constant time against `mcp_server_token_user_<userId>` in the secret
 * store, which is the same per-user secret mechanism MCP *client* credentials
 * already use. The scheme itself — mint, parse, verify — is `auth/mcpToken.js`,
 * which the sibling routers and the CLI minter read without loading a router.
 *
 * A token grants exactly what that user can do in chat — no more. Tool
 * availability is resolved per request through `getIntegrationTools`, so org,
 * group and per-user integration toggles all still apply, and revoking a
 * user's access to an app immediately revokes it here too.
 *
 * ── Safe vs dangerous ───────────────────────────────────────────────────────
 * Nextcloud's Context Agent splits tools into safe and dangerous and asks the
 * user to confirm the dangerous ones (`@safe_tool` / `@dangerous_tool` in its
 * decorator module). We already have that classification, test-enforced, in
 * `automation/sideEffectMap.js`, so it is exported here as an annotation
 * rather than invented twice. Fail-closed: anything unclassified is treated as
 * having side effects.
 */

const express = require('express');
const { z } = require('zod');
// The tool registry and dispatcher pull in the whole integration surface (and,
// through it, DB-backed stores). Required lazily so importing this module in a
// unit test does not stand up that machinery.
const { isSideEffect } = require('../automation/sideEffectMap');
const log = require('../telemetry/log');
const { SECRET_KEY, mintToken, parseToken, authenticateToken } = require('../auth/mcpToken');

const router = express.Router();

// ── Tool surface ────────────────────────────────────────────────────────────

/**
 * Build the caller's tool list. `loadSession` is the same offline-session
 * builder unattended automations use, so a connector-bound user reaches Nextcloud
 * through the ExApp proxy exactly as they would in a scheduled automation.
 */
async function toolsForUser(userId) {
    const { loadSession } = require('../automation/triggerBus');
    const { getIntegrationTools } = require('../core/integrations/integrationTools');
    const session = await loadSession(userId).catch(() => null);
    return { tools: toolListFrom(await getIntegrationTools({ userId, session })), session };
}

/**
 * The tool array out of getIntegrationTools' answer, `{ tools, n8nOrgId }`.
 * This used to test the answer itself with Array.isArray, which an object
 * never passes: /mcp advertised no tools at all and refused every call as
 * "not available to this account".
 */
function toolListFrom(resolved) {
    return Array.isArray(resolved?.tools) ? resolved.tools : [];
}

/**
 * MCP tool definition from an OpenAI-shaped function definition. The
 * `readOnlyHint`/`destructiveHint` annotations are what let a client decide
 * whether to ask the user before calling — the MCP equivalent of Context
 * Agent's safe/dangerous split.
 */
function toMcpTool(fn) {
    // isSideEffect is fail-closed: an unclassified tool counts as
    // side-effecting, so a new tool is never advertised as safe by omission.
    const readOnly = !isSideEffect(fn.name);
    return {
        name: fn.name,
        description: fn.description || '',
        inputSchema: fn.parameters && typeof fn.parameters === 'object'
            ? fn.parameters
            : { type: 'object', properties: {} },
        annotations: {
            readOnlyHint: readOnly,
            destructiveHint: !readOnly,
            title: fn.name,
        },
    };
}

// ── MCP protocol ────────────────────────────────────────────────────────────
//
// Implemented directly rather than through the SDK's server class: the SDK is
// ESM-only and its transport wants to own the HTTP response, while this has to
// live inside the existing Express app behind the same proxy and logging as
// every other route. The surface a tool-consumer needs is small and stable —
// initialize, tools/list, tools/call, ping — and speaking it directly keeps
// this file honest about exactly what is supported.

const PROTOCOL_VERSION = '2025-06-18';

function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

// ── The JSON-RPC envelope ───────────────────────────────────────────────────
//
// Why there is no validate() middleware on this router, nor on its two
// siblings (mcpStudio.js, mcpAutomations.js): the body is a JSON-RPC 2.0
// message whose shape the MCP specification dictates, and a refusal has to BE
// a JSON-RPC error carrying the call's id, or the client cannot pair it with
// what it asked. A 400 `{ error, code, correlationId }` from the terminal
// handler is nothing an MCP client can read. So the envelope is checked here,
// with zod, and answered in the protocol's own terms. What that changed:
//
//   - a notification (no `id`) is never answered. Only notifications/
//     initialized was recognised; every other one — notifications/cancelled,
//     which Claude Code sends when someone interrupts a tool call — got a
//     "Method not found" error without an id, under a 200, where the
//     transport wants a bare 202. A tools/call sent as a notification is not
//     run: nobody would ever see its result;
//   - a RESPONSE from the client (result or error, no method) is not a call
//     either, and got the same error;
//   - anything else without a method is -32600 Invalid Request;
//   - tools/call `arguments` that are not an object were handed to the tool
//     as-is; they are -32602 now. `params` stays OPEN beyond name and
//     arguments: the specification lets a client add fields (`_meta`).

const RpcId = z.union([z.string(), z.number(), z.null()]);
const RpcMessage = z.object({
    id: RpcId.optional(),
    method: z.string().min(1).optional(),
}).passthrough();

/**
 * What one incoming message is: a 'request' (answer it), a 'notification' or
 * a client 'response' (never answer either), or 'invalid' (-32600).
 */
function classifyRpc(message) {
    const parsed = RpcMessage.safeParse(message);
    if (!parsed.success) {
        const id = message && typeof message === 'object' && RpcId.safeParse(message.id).success ? message.id : null;
        return { kind: 'invalid', id: id ?? null };
    }
    const m = parsed.data;
    const hasId = m.id !== undefined;
    if (m.method !== undefined) return { kind: hasId ? 'request' : 'notification', id: m.id, method: m.method, params: m.params };
    if (hasId && ('result' in m || 'error' in m)) return { kind: 'response' };
    return { kind: 'invalid', id: hasId ? m.id : null };
}

const INVALID_REQUEST = 'Invalid Request: a JSON-RPC message needs a method (or, from a client, a result).';

const ToolCallParams = z.object({
    name: z.string().min(1),
    arguments: z.record(z.unknown()).nullish(),
}).passthrough();

/**
 * tools/call's params → `{ name, args }`, or `{ error }` worded for the agent
 * that sent them (a -32602 message is read by a model, not a person).
 */
function parseToolCall(params) {
    const parsed = ToolCallParams.safeParse(params);
    if (parsed.success) return { name: parsed.data.name, args: parsed.data.arguments || {} };
    const field = parsed.error.issues[0]?.path?.[0];
    if (field === 'arguments') return { error: 'Tool arguments must be a JSON object.' };
    return { error: 'Missing tool name' };
}

/**
 * @param {object} [deps]  test seam: `{ toolsForUser }`. The real one needs
 *                         Postgres, and this router's tests run without it.
 */
async function handleRpc(message, userId, deps = {}) {
    const listTools = deps.toolsForUser || toolsForUser;
    const call = classifyRpc(message);
    if (call.kind === 'invalid') return rpcError(call.id, -32600, INVALID_REQUEST);
    if (call.kind !== 'request') return null; // notifications and client responses get no answer
    const { id, method, params } = call;

    switch (method) {
        case 'initialize':
            return rpcResult(id, {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'bee-flow', version: '1.0.0' },
            });

        case 'ping':
            return rpcResult(id, {});

        case 'notifications/initialized':
            return null; // notification — no response

        case 'tools/list': {
            const { tools } = await listTools(userId);
            return rpcResult(id, {
                tools: tools
                    .map(t => t.function)
                    .filter(Boolean)
                    .map(toMcpTool),
            });
        }

        case 'tools/call': {
            const toolCall = parseToolCall(params);
            if (toolCall.error) return rpcError(id, -32602, toolCall.error);
            const { name, args } = toolCall;

            // Re-resolve on every call rather than trusting a cached list: a
            // long-lived MCP client would otherwise keep calling a tool after
            // an admin revoked the integration.
            const { tools, session } = await listTools(userId);
            const permitted = tools.some(t => t.function?.name === name);
            if (!permitted) {
                return rpcResult(id, {
                    content: [{ type: 'text', text: `Tool "${name}" is not available to this account.` }],
                    isError: true,
                });
            }

            try {
                const { executeTool } = require('../core/tools/toolDispatcher');
                const result = await executeTool(name, args, {
                    userId,
                    session,
                    // An MCP client calling in: the dispatcher's chokepoint
                    // writes the egress row under this user and org.
                    egress: {
                        source: 'mcp_server',
                        ids: { organization_id: session?.user?.organizationId || null, user_id: userId },
                    },
                });
                const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
                // A tool that returns {error} is a failure the model must see as
                // one — the same soft-error trap that made automations report
                // success while doing nothing.
                const isError = !!(result && typeof result === 'object' && result.error);
                return rpcResult(id, { content: [{ type: 'text', text }], isError });
            } catch (err) {
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

// Streamable HTTP transport: a single POST carrying one JSON-RPC message (or a
// batch), answering with JSON. We do not advertise an SSE stream — nothing in
// this surface pushes server-initiated messages, and claiming the capability
// would leave clients waiting on a stream that never emits.
router.post('/', express.json({ limit: '4mb' }), async (req, res) => {
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
            log.error('[MCP server] handler error:', err.message);
            // Only a request is answered — not even an error goes back to a notification.
            if (classifyRpc(message).kind === 'request') responses.push(rpcError(message.id, -32603, 'Internal error'));
        }
    }
    if (!responses.length) return res.status(202).end();
    return res.json(Array.isArray(body) ? responses : responses[0]);
});

// Some clients probe with GET before POSTing. Answer honestly rather than
// leaving them hanging on a stream we never write to.
router.get('/', async (req, res) => {
    const userId = await authenticateToken(req.headers.authorization);
    if (!userId) {
        res.set('WWW-Authenticate', 'Bearer realm="bee-flow"');
        return res.status(401).json(rpcError(null, -32001, 'Unauthorized'));
    }
    return res.status(405).json(rpcError(null, -32000, 'This MCP endpoint is POST-only; it does not open an SSE stream.'));
});

module.exports = router;
module.exports.authenticateToken = authenticateToken;
module.exports.parseToken = parseToken;
module.exports.mintToken = mintToken;
module.exports.toMcpTool = toMcpTool;
module.exports.toolListFrom = toolListFrom;
module.exports.handleRpc = handleRpc;
module.exports.classifyRpc = classifyRpc;
module.exports.parseToolCall = parseToolCall;
module.exports.INVALID_REQUEST = INVALID_REQUEST;
module.exports.SECRET_KEY = SECRET_KEY;
module.exports.PROTOCOL_VERSION = PROTOCOL_VERSION;
