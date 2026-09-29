/**
 * Execution endpoint for Nextcloud Task Processing.
 *
 * Nextcloud schedules a task → AppAPI triggers the connector → the connector
 * posts here → we run it on the organisation's configured model and return the
 * output, which the connector reports back to Nextcloud. See
 * `nextcloud-connector/src/taskProcessing.js` for the other half.
 *
 * The point of this is that it is not one feature. Nextcloud routes Assistant,
 * Mail thread summaries, Talk summaries, Text, Collectives, Notes, Deck and
 * Office through the same Task Processing API, so implementing these task types
 * puts Bee Flow behind all of them at once — with the organisation's own model
 * choice and its Privacy Shield settings, rather than a third-party endpoint.
 *
 * Auth: the connector's tenant-key HMAC over (timestamp, method, path, body),
 * the same scheme the event ingest uses. No user session is involved — the
 * request is machine-to-machine and identifies the org by its NC instance id.
 *
 * ── What the connector may send ─────────────────────────────────────
 *
 * The schema runs AFTER the signature, so an unsigned request still hears
 * 401 and never learns the shape. The HMAC is over the raw bytes captured
 * before parsing, so what the schema does to `req.body` cannot break it.
 *
 * The top level is NOT `.strict()`, deliberately. Its five keys are written
 * by our own connector (`executeViaSaaS`), but the connector ships through
 * the Nextcloud app store and a self-hosted server is updated on its own
 * schedule: a newer connector adding a sixth key would turn every Assistant,
 * Mail and Talk task on an older server into a 400. Unknown keys are dropped;
 * the known ones are typed. `input` is Nextcloud's own task input and stays
 * open for the same reason routes/automation/events.js gives: its shape is
 * versioned by Nextcloud, not by us. An EMPTY input arrives as `[]`, because
 * that is how PHP encodes an empty array.
 *
 * One rule on `input` is ours: a text task needs its text. `String(input.input
 * || '')` sent a missing or misnamed text to the model as an empty message,
 * and the model answered anyway: `{ taskType: 'core:text2text:summary',
 * input: {} }` came back 200 with a "summary" of nothing, which the connector
 * then reported to Nextcloud as the result of that person's task. The agent
 * type is exempt; its turns are conversational and an empty one is not ours
 * to refuse.
 */

const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { validate } = require('../core/http/validate');
// configStore and userStore are required lazily inside the handlers, not here:
// importing configStore stands up the Postgres pool at module load, which makes
// this file un-requireable in the infra-free unit tests (and in any tooling that
// only wants to read TASK_TYPES or the agent contract).

const router = express.Router();

// Same 5-minute skew and raw-body capture as routes/automation/events.js.
const captureRaw = express.json({
    limit: '2mb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
});

// Shared with routes/nextcloudStudioApps.js — the scheme is documented (and
// must stay byte-identical to the connector's signing side) in auth/connectorSig.
const { verifyConnectorSig } = require('../auth/connectorSig');

/**
 * Per-task-type prompt construction.
 *
 * Nextcloud hands us a typed input shape, not a prompt — turning it into one is
 * this layer's whole job. The language instruction is on every prompt for a
 * reason Nextcloud's own developer manual calls out: models answer in the
 * language of the *instruction* by default, so an English system prompt over a
 * Dutch document produces an English summary unless told otherwise. On a Dutch
 * product that is not a rough edge, it is a wrong answer.
 */
const LANGUAGE_RULE =
    'Detect the language used in the text and make sure to answer in the same '
    + 'language, without mentioning the language explicitly.';

const HANDLERS = {
    'core:text2text': (input) => ({
        system: `You are a helpful assistant. ${LANGUAGE_RULE}`,
        user: String(input.input || ''),
    }),
    'core:text2text:chat': (input) => ({
        system: String(input.system_prompt || `You are a helpful assistant. ${LANGUAGE_RULE}`),
        user: String(input.input || ''),
        history: Array.isArray(input.history) ? input.history : [],
    }),
    'core:text2text:summary': (input) => ({
        system: `Summarise the text the user provides. Return only the summary. ${LANGUAGE_RULE}`,
        user: String(input.input || ''),
    }),
    'core:text2text:headline': (input) => ({
        system: `Write a single short headline for the text the user provides. Return only the headline, with no quotes or trailing punctuation. ${LANGUAGE_RULE}`,
        user: String(input.input || ''),
    }),
    'core:text2text:topics': (input) => ({
        system: `List the topics of the text the user provides as a comma-separated list. Return only that list. ${LANGUAGE_RULE}`,
        user: String(input.input || ''),
    }),
    'core:text2text:proofread': (input) => ({
        system: `Proofread the text the user provides. List the grammar and spelling mistakes you find, and nothing else. ${LANGUAGE_RULE}`,
        user: String(input.input || ''),
    }),
    'core:text2text:reformulation': (input) => ({
        system: `Reformulate the text the user provides, preserving its meaning. Return only the reformulated text. ${LANGUAGE_RULE}`,
        user: String(input.input || ''),
    }),
    'core:text2text:simplification': (input) => ({
        system: `Rewrite the text the user provides so that a child could understand it, preserving its meaning. Return only the rewritten text. ${LANGUAGE_RULE}`,
        user: String(input.input || ''),
    }),
    'core:text2text:formalization': (input) => ({
        system: `Rewrite the text the user provides in a more formal tone, preserving its meaning. Return only the rewritten text. ${LANGUAGE_RULE}`,
        user: String(input.input || ''),
    }),
    'core:text2text:improve': (input) => ({
        system: `Rewrite the text the user provides according to their instructions. Return only the rewritten text. ${LANGUAGE_RULE}`,
        user: `Instructions: ${String(input.instructions || 'Improve the text.')}\n\nText:\n${String(input.input || '')}`,
    }),
    'core:text2text:translate': (input) => ({
        // Explicitly NOT applying LANGUAGE_RULE here: the whole point is to
        // answer in a different language from the input.
        system: 'You are a translator. Return only the translation, with no commentary.',
        user: `Translate the following${input.origin_language ? ` from ${input.origin_language}` : ''}`
            + ` into ${String(input.target_language || 'English')}:\n\n${String(input.input || '')}`,
    }),
};

// ── The agent task type ─────────────────────────────────────────────────────

const AGENT_TASK_TYPE = 'core:contextagent:interaction';
const AGENT_MAX_STEPS = 12;

/**
 * Conversation state for the agent, keyed by the `conversation_token` we hand
 * back to Nextcloud.
 *
 * Nextcloud does not persist the turn history for us — it echoes an opaque
 * token (declared as plain Text in ContextAgentInteraction's output shape, and
 * never parsed on its side) and expects the provider to hold the state behind
 * it.
 *
 * IN MEMORY, AND THAT IS A REAL LIMIT: a SaaS restart or a second replica loses
 * the thread and the next turn starts cold. Acceptable for a single-replica
 * deployment and for the first version of this path; it needs Redis or a table
 * before this is load-bearing. Bounded and TTL'd so it cannot become a leak in
 * the meantime.
 */
const AGENT_TTL_MS = 60 * 60 * 1000;
const AGENT_MAX_THREADS = 2000;
const agentThreads = new Map();

/*
 * A thread belongs to the org and the Bee Flow user whose turn created it.
 * It used to be keyed by the token alone, and the token is task INPUT: any
 * Nextcloud user can schedule a `core:contextagent:interaction` task through
 * the OCS TaskProcessing API with whatever `conversation_token` they like.
 * Holding someone else's token was enough to continue their conversation,
 * with their earlier tool results (files, calendar, mail) in the model's
 * context. A token owned by someone else now starts a fresh conversation
 * under a fresh token, and leaves the owner's thread as it was.
 */
function threadOwner(org, userId) {
    return `${org?.id || ''}\u0000${userId || ''}`;
}

function threadPut(token, messages, owner) {
    agentThreads.delete(token);
    agentThreads.set(token, { messages, at: Date.now(), owner });
    for (const [k, v] of agentThreads) {
        if (agentThreads.size <= AGENT_MAX_THREADS && Date.now() - v.at < AGENT_TTL_MS) break;
        agentThreads.delete(k);
    }
}

/** The live entry under `token`, or null; expired entries are dropped on read. */
function threadEntry(token) {
    const e = token ? agentThreads.get(token) : null;
    if (!e) return null;
    if (Date.now() - e.at > AGENT_TTL_MS) { agentThreads.delete(token); return null; }
    return e;
}

const AGENT_SYSTEM = 'You are Bee Flow, an assistant working inside the user\'s own Nextcloud. '
    + 'Use the available tools to look things up before answering, and answer from what they return '
    + 'rather than from memory. Cite the file, event or record you used. '
    + `${LANGUAGE_RULE}`;

/**
 * Run one agent turn.
 *
 * READ-ONLY TOOLS ONLY, and this is a deliberate safety bound rather than an
 * oversight. Nextcloud's agent contract has a confirmation step — a provider
 * returns pending tool calls in `actions`, Nextcloud renders its own confirm /
 * deny dialog, and the next turn arrives with `confirmation: 0|1`. Bee Flow's
 * agent runtime has no interrupt-before-dangerous-tool hook to populate that
 * with: `isSideEffect` is consumed by the automation builder and the summariser,
 * and never by the chat agent. Until that hook exists, offering write tools here
 * would let the agent take destructive actions in someone's Nextcloud with no
 * confirmation at all — so the tool list is filtered through the SAME
 * fail-closed classifier the MCP surface uses, and `actions` is always empty.
 *
 * Removing this filter is the last step of the confirmation-gate work, not an
 * independent change.
 */
async function runAgentTurn({ input, org, user, ncUid }) {
    const userId = user?.id || null;
    if (!userId) {
        // Checked before anything is loaded or called: no mapped Bee Flow user
        // means no per-user tool scope, and running an agent as "the
        // organisation" would hand one person another user's data.
        throw new Error(`No Bee Flow user is linked to the Nextcloud account "${ncUid}"`);
    }

    const { getIntegrationTools } = require('../core/integrations/integrationTools');
    const { executeTool } = require('../core/tools/toolDispatcher');
    const { isSideEffect } = require('../automation/sideEffectMap');
    const { resolveModelWithGlobalFallback } = require('../core/llm/modelResolver');
    const llmClient = require('../core/llm/llmClient');

    // getIntegrationTools returns { tools, n8nOrgId }, not a bare array — taking
    // the whole object here made the filter below throw ".filter is not a
    // function" and 500 every agent turn (the Assistant/Talk agent path).
    const { tools: all } = await getIntegrationTools({ userId, session: null });
    const tools = (all || []).filter(t => {
        const name = t?.function?.name || t?.name;
        return name && !isSideEffect(name);
    });

    const owner = threadOwner(org, userId);
    const suppliedToken = typeof input.conversation_token === 'string' && input.conversation_token
        ? input.conversation_token
        : null;
    const entry = threadEntry(suppliedToken);
    const foreign = !!entry && entry.owner !== owner;
    const prior = entry && !foreign ? entry.messages : null;
    const messages = prior ? [...prior] : [{ role: 'system', content: AGENT_SYSTEM }];
    for (const m of (Array.isArray(input.memories) ? input.memories : [])) {
        if (typeof m === 'string' && m.trim()) {
            messages.push({ role: 'system', content: `Relevant prior context: ${m}` });
        }
    }
    messages.push({ role: 'user', content: String(input.input || '') });

    // 'balanced' is NOT a real tier (valid: fast/standard/thinking/…), and
    // passed bare it was treated as a literal model id — "Model balanced not
    // found in any configured provider", 500 on every agent turn. Use the
    // real 'standard' tier and fall back to the org's global default model so a
    // stack that hasn't mapped that tier still answers.
    const modelId = await resolveModelWithGlobalFallback('tier:standard', {
        userOrgId: org.id, userId,
    });

    // The Privacy Shield's tool block lists ("Outside tools" / "Own server")
    // apply to this agent's tools as to every other tool loop (BFSF-354); a
    // failed lookup leaves them unapplied, as a missing shield does elsewhere.
    const toolPiiGate = require('../core/privacy/toolPiiGate');
    const shieldGate = toolPiiGate.toolLoopGate({
        shield: await toolPiiGate.resolveToolShield(
            () => require('../core/privacy/orgShield').resolveShieldFor({ orgId: org?.id || null, userId }), 'NC TaskProcessing'),
        tag: 'NC Assistant',
        audit: (fields) => require('../stores/guardrailEventStore').logGuardrailEvent({
            organization_id: org?.id || null, user_id: userId, ...fields, source: 'nextcloud_assistant', model: modelId,
        }),
    });

    const sources = [];
    let answer = '';
    for (let step = 0; step < AGENT_MAX_STEPS; step++) {
        // Capped: each step of this loop is a full prompt evaluation on the
        // provider, and a tool-calling round never needs more than this.
        const completion = await llmClient.chat(modelId, messages, { stream: false, tools, maxTokens: 4096 });
        const calls = completion?.toolCalls || completion?.tool_calls || [];
        const text = typeof completion === 'string'
            ? completion
            : (completion?.content || completion?.text || '');

        if (!calls.length) { answer = text; break; }

        messages.push({ role: 'assistant', content: text || '', tool_calls: calls });
        for (const call of calls) {
            const name = call?.function?.name || call?.name;
            let args = call?.function?.arguments ?? call?.arguments ?? {};
            if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
            // Belt and braces: the list was filtered, but a model can invent a
            // name, and this classifier is the one that fails closed.
            if (!name || isSideEffect(name)) {
                messages.push({
                    role: 'tool', tool_call_id: call?.id, name: name || 'unknown',
                    content: 'That action changes data and is not available to the assistant yet.',
                });
                continue;
            }
            try {
                const refusal = await shieldGate.refuse(name, args);
                if (refusal) {
                    messages.push({ role: 'tool', tool_call_id: call?.id, name, content: JSON.stringify({ error: refusal.modelError }) });
                    continue;
                }
                const result = await executeTool(name, args, {
                    userId,
                    session: null,
                    // The Nextcloud Assistant's agent turn: the dispatcher's
                    // chokepoint writes the egress row with these ids.
                    egress: {
                        source: 'nextcloud_assistant',
                        model: modelId,
                        ids: { organization_id: org?.id || null, user_id: userId },
                    },
                });
                sources.push(name);
                messages.push({
                    role: 'tool', tool_call_id: call?.id, name,
                    // What the model reads, with the categories this tool's
                    // class forbids stripped out.
                    content: await shieldGate.forModel(typeof result === 'string' ? result : JSON.stringify(result ?? null), name),
                });
            } catch (err) {
                messages.push({
                    role: 'tool', tool_call_id: call?.id, name,
                    content: `Error: ${err.message}`,
                });
            }
        }
    }

    const token = (!foreign && suppliedToken) || crypto.randomUUID();
    threadPut(token, messages, owner);
    return {
        output: answer || 'I could not find an answer to that.',
        // Always empty until the confirmation gate exists — see above. Nextcloud
        // treats an empty string as "nothing to confirm".
        actions: '',
        conversation_token: token,
        sources: [...new Set(sources)],
    };
}

// ── Request schema (see the header) ─────────────────────────────────

/** A string whose every refusal, including "you left it out", is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const TASK_TYPE_TEXT = 'taskType names the Nextcloud task type, like core:text2text:summary.';
const TEXT_INPUT_TEXT = 'A text task needs input.input: the text to work on.';
const ExecuteBody = z.object({
    taskType: worded(TASK_TYPE_TEXT).trim().min(1, TASK_TYPE_TEXT).max(200, TASK_TYPE_TEXT),
    input: z.preprocess(
        // PHP encodes an empty input as [], and the connector sends {} for none.
        (v) => (v === undefined || v === null || (Array.isArray(v) && v.length === 0) ? {} : v),
        z.record(z.string(), z.unknown(), { invalid_type_error: 'input is the task input object Nextcloud sent.' }),
    ),
    ncUid: worded('ncUid is the Nextcloud user id.').max(256, 'ncUid is at most 256 characters.').nullish(),
    customId: worded('customId is text.').max(512, 'customId is at most 512 characters.').nullish(),
    appId: worded('appId is text.').max(256, 'appId is at most 256 characters.').nullish(),
}).superRefine((body, ctx) => {
    if (!Object.prototype.hasOwnProperty.call(HANDLERS, body.taskType)) return;
    const text = body.input.input;
    if (typeof text !== 'string' || !text.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['input', 'input'], message: TEXT_INPUT_TEXT });
    }
});

/** The signature comes before the schema: an unsigned caller learns nothing about the shape. */
async function requireConnectorSig(req, res, next) {
    const org = await verifyConnectorSig(req);
    if (!org) return res.status(401).json({ error: 'Invalid or missing signature' });
    req.connectorOrg = org;
    return next();
}

router.post('/execute', captureRaw, requireConnectorSig, validate({ body: ExecuteBody }), async (req, res) => {
    const org = req.connectorOrg;
    const { taskType, input, ncUid } = req.body;

    const userStoreEarly = require('../stores/userStore');
    if (taskType === AGENT_TASK_TYPE) {
        const agentUser = ncUid
            ? await userStoreEarly.getUserByNcUid(org.id, ncUid).catch(() => null)
            : null;
        const out = await runAgentTurn({ input, org, user: agentUser, ncUid });
        return res.json({ output: out });
    }

    // Only text-shaped types are handled beyond that. The connector
    // deliberately does not register anything else (see its TASK_TYPES), so
    // an unsupported type here means a stale provider registration rather
    // than normal traffic — worth an explicit error instead of a silent
    // empty answer.
    const build = HANDLERS[taskType];
    if (!build) {
        return res.status(400).json({ error: `Unsupported task type: ${taskType}` });
    }
    const prompt = build(input);

    const userStore = require('../stores/userStore');
    const user = ncUid
        ? await userStore.getUserByNcUid(org.id, ncUid).catch(() => null)
        : null;

    const messages = [];
    if (prompt.system) messages.push({ role: 'system', content: prompt.system });
    for (const entry of (prompt.history || [])) {
        // Nextcloud's chat history is a list of JSON strings.
        try {
            const parsed = typeof entry === 'string' ? JSON.parse(entry) : entry;
            const role = parsed.role === 'human' ? 'user' : (parsed.role || 'user');
            if (parsed.content) messages.push({ role, content: String(parsed.content) });
        } catch (_) {
            if (typeof entry === 'string' && entry) messages.push({ role: 'user', content: entry });
        }
    }
    messages.push({ role: 'user', content: prompt.user });

    // Resolve through the org's own tier configuration rather than pinning
    // a model here: an EU-only organisation must not be silently routed to
    // a non-EU provider just because the request arrived from Nextcloud.
    // 'standard' is the sensible default for summary/rewrite work — 'fast'
    // is noticeably weaker at it, and these are background tasks. (Was
    // 'balanced', which is not a real tier and resolved to a literal,
    // unknown model id — so every text task 500'd.)
    const { resolveModelWithGlobalFallback } = require('../core/llm/modelResolver');
    const modelId = await resolveModelWithGlobalFallback('tier:standard', {
        userOrgId: org.id,
        userId: user?.id || null,
    });

    const llmClient = require('../core/llm/llmClient');
    const completion = await llmClient.chat(modelId, messages, {
        // Task Processing is a background API — nothing is streaming this
        // to a browser, and Nextcloud wants the whole answer in one reply.
        stream: false,
        // Bounded so one runaway generation cannot hold a self-hosted slot.
        maxTokens: 8192,
    });

    const text = typeof completion === 'string'
        ? completion
        : (completion?.content || completion?.text || '');
    if (!text) return res.status(502).json({ error: 'The model returned no output' });

    return res.json({ output: { output: text } });
});

module.exports = router;
module.exports.HANDLERS = HANDLERS;
module.exports.AGENT_TASK_TYPE = AGENT_TASK_TYPE;
module.exports.runAgentTurn = runAgentTurn;
module.exports.LANGUAGE_RULE = LANGUAGE_RULE;
