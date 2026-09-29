/**
 * Automation Builder — the code step's AI assistant.
 *
 *   POST /api/automation/builder/code/assist   (mounted at /api/automation/builder)
 *
 * Body: { messages: [{ role: 'user'|'assistant', content }]   last = the new message
 *         code, allowedTools?, allowedHosts?,
 *         upstreamFields?: [{ path, label?, type? }]          names and types, never values
 *         automationId?, stepId?, modelTier? }
 *
 * SSE events, in order: `delta` { text } and `edit` { op, summary, startLine,
 * endLine } while the model works, `code` { code, analysis, changed,
 * repairRounds } exactly once, then `done` { usage }. A failed model call
 * sends `error` { message, messageKey } and still ends with `code` + `done`.
 * The turn itself (edits, the check, repair rounds) is codeAssistTurn.js.
 *
 * The server edits the code the request carried, in memory, and saves
 * nothing: the client shows the change with Keep/Undo and its own autosave
 * writes the step. So the access check is about who may ASK: a person who
 * may build routines, and, when the request names a routine, one who may
 * edit it (automation/access.js). Refusals before the stream opens are plain
 * JSON, like the rest of this router.
 *
 * Privacy Shield: the same handling as the webpage chat (routes/ai/webpageChat.js).
 * The person's text goes to the model as typed; the edit tools pass the
 * shield's tool gate ("tools that stay on your own server"), resolved on the
 * first tool call. There are no outside tools, no attachments and no
 * knowledge-base passages on this surface.
 *
 * Model: the `fast` tier unless the request names one the person may use
 * (core/entitlements/tierAccess, the builder's list); `standard` reads as
 * `fast`, the project's tier convention.
 *
 * Every outside dependency comes through makeCodeAssistRouter(deps), so the
 * route test runs without a database, a provider or the analyser.
 */

'use strict';

const express = require('express');
const log = require('../../../telemetry/log');
const { validate } = require('../../../core/http/validate');
const { z, worded, bodyOf, closedObject, choice } = require('../../../core/http/schemaParts');
const { perUserRateLimit } = require('../../../utils/perUserRateLimit');
const { startSseHeartbeat } = require('../../../core/http/sseHelpers');
const { streamWithRetry } = require('../builderShared');
const { runCodeAssistTurn } = require('./codeAssistTurn');
const { MAX_CODE_CHARS } = require('./codeAssistTools');

// One assistant turn is a short tool loop on the fast tier, repairs
// included. 15/min/user is more than a person typing and reading answers
// can use, and starves a script using it as a free LLM proxy. Defined here,
// not in rateLimits.js, so this surface's budget is spent only by it.
const codeAssistRateLimit = perUserRateLimit({ windowMs: 60_000, max: 15 });

const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_UPSTREAM_FIELDS = 500;

// ── What a turn may send ────────────────────────────────────────────
const text = (message, max) => worded(message).max(max, message);
const stringList = (message, maxItems, maxChars) => z.array(text(message, maxChars), { invalid_type_error: message }).max(maxItems, message);

const CodeAssistBody = bodyOf({
    messages: z.array(closedObject({
        role: choice(['user', 'assistant'], 'A message role is "user" or "assistant".'),
        content: text(`A message is text of at most ${MAX_MESSAGE_CHARS.toLocaleString('en')} characters.`, MAX_MESSAGE_CHARS),
    }, 'A message'), { required_error: 'messages is the conversation, ending with the new message.', invalid_type_error: 'messages is the conversation, ending with the new message.' })
        .min(1, 'messages is the conversation, ending with the new message.')
        .max(MAX_MESSAGES, `At most ${MAX_MESSAGES} messages; start a new conversation.`),
    code: text(`code is the step's code, at most ${MAX_CODE_CHARS.toLocaleString('en')} characters.`, MAX_CODE_CHARS).nullish(),
    allowedTools: stringList('allowedTools is a list of tool names.', 200, 200).nullish(),
    allowedHosts: stringList('allowedHosts is a list of host names.', 200, 253).nullish(),
    // Not closed: the field picker may carry display keys this route does
    // not read; only path, label and type are kept.
    upstreamFields: z.array(z.object({
        path: text('An upstream field has a path.', 500),
        label: z.string({ invalid_type_error: 'An upstream field label is text.' }).max(300).nullish(),
        type: z.string({ invalid_type_error: 'An upstream field type is text.' }).max(60).nullish(),
    }), { invalid_type_error: 'upstreamFields is a list of { path, label, type }.' }).max(MAX_UPSTREAM_FIELDS).nullish(),
    automationId: text('automationId is the id of the routine.', 200).nullish(),
    stepId: text('stepId is the id of the code step.', 200).nullish(),
    modelTier: text('modelTier is the name of a model tier.', 100).nullish(),
}, 'A code assistant turn');

// ── Defaults for the dependencies ───────────────────────────────────

// The same analyser the editor, the validator and the runner use.
function loadAnalyser() {
    return require('../../../automation/codeSafety').analyzeCode;
}

/**
 * The model a turn runs on, or a refusal. `fast` unless the person asked for
 * a tier they may use; `standard` is read as `fast`.
 */
async function resolveAssistModel({ userId, session, modelTier }) {
    const { tierAccessFor, tierRefusal } = require('../../../core/entitlements/tierAccess');
    const { getUserTierMap } = require('../../../core/llm/modelResolver');
    const { getAIConfig, getProviderForModel } = require('../../../core/aiAgent');
    const { getAdapter } = require('../../../core/providers');

    let asked = typeof modelTier === 'string' && modelTier.trim() ? modelTier.trim() : null;
    if (asked === 'standard') asked = 'fast';
    const access = await tierAccessFor({ userId, session, taskType: 'automation' });
    const tierName = access.choose(asked);
    if (!tierName) {
        const r = tierRefusal(asked || 'fast');
        return { refusal: { status: r.status, body: { error: r.error, code: r.code } } };
    }
    const tiers = await getUserTierMap({ userOrgId: session?.user?.organizationId || null, userId });
    const tier = tiers[tierName] || {};
    const modelId = tier.modelId || (await getAIConfig())?.model || null;
    if (!modelId) {
        return {
            refusal: {
                status: 503,
                body: {
                    error: 'No AI model is set up for the code assistant. Ask an administrator to set up the fast model tier.',
                    code: 'no_model',
                    messageKey: 'code_step.assist.error.no_model',
                },
            },
        };
    }
    const cfg = await getProviderForModel(modelId);
    const adapter = getAdapter(cfg.providerType, cfg.url);
    return { tierName, tier, modelId, cfg, adapter };
}

/** The Privacy Shield tool gate for this turn, resolved on its first use. */
function makeShieldGate({ userId, orgId, automationId, modelId }) {
    const toolPiiGate = require('../../../core/privacy/toolPiiGate');
    let lookup = null;
    return toolPiiGate.toolLoopGate({
        shield: () => (lookup ??= toolPiiGate.resolveToolShield(
            () => require('../../../core/privacy/orgShield').resolveShieldFor({ orgId, userId }), 'CodeAssist')),
        audit: (fields) => require('../../../stores/guardrailEventStore').logGuardrailEvent({
            organization_id: orgId || null, user_id: userId, conversation_id: automationId || null,
            ...fields, source: 'code_assist', model: modelId || null,
        }),
        tag: 'CodeAssist',
    });
}

/**
 * What ctx.integrations.<tool>(args) takes and returns, for the tools the
 * step may call: the registry's own input schema and output shape, so the
 * model writes the call with the real argument names instead of guessing.
 */
function lookupToolDocs(names) {
    const wanted = new Set((names || []).filter(n => typeof n === 'string' && n));
    if (!wanted.size) return [];
    const { TOOL_REGISTRY, loadTools } = require('../../../automation/toolRegistry');
    const { getOutputSchema } = require('../../../automation/outputSchemas');
    const out = [];
    for (const entry of TOOL_REGISTRY) {
        for (const t of loadTools(entry)) {
            const name = t && t.function && t.function.name;
            if (!name || !wanted.has(name)) continue;
            out.push({ name, description: t.function.description || '', parameters: t.function.parameters || null, output: getOutputSchema(name) });
            wanted.delete(name);
        }
        if (!wanted.size) break;
    }
    return out;
}

function defaultDeps() {
    const { makeAutomationAccess } = require('../../../automation/access');
    let access = null;
    return {
        requireAuth: (req, res, next) => require('../../../auth/permissions').requireAuth(req, res, next),
        rateLimit: codeAssistRateLimit,
        hasAutomationsBeta: (userId, session) => require('../../../core/entitlements/betaFeatures').userHasBetaFeature(userId, 'automations', session),
        getAutomation: (id) => require('../../../stores/automationStore').getAutomation(id),
        guardEdit: (req, res, automation) => (access ??= makeAutomationAccess()).guard(req, res, automation, 'edit'),
        resolveModel: resolveAssistModel,
        loadAnalyser,
        makeGate: makeShieldGate,
        lookupToolDocs,
        streamWithRetry,
    };
}

// The route never shows reasoning: the panel has text and edits only.
const NO_THINKING = { start() {}, delta() {}, stop() {} };

function refuse(res, status, error, code, messageKey) {
    return res.status(status).json({ error, code, ...(messageKey ? { messageKey } : {}) });
}

// ── The route ───────────────────────────────────────────────────────

function makeCodeAssistRouter(overrides = {}) {
    const deps = { ...defaultDeps(), ...overrides };
    const router = express.Router();

    // Ahead of the schema, so a person without the feature gets a 403 and
    // not a lecture about the body (the sibling routes' order).
    async function requireAutomationsBeta(req, res, next) {
        if (!await deps.hasAutomationsBeta(req.session.user.id, req.session)) {
            return refuse(res, 403, 'The Automations beta is not enabled for your organisation.', 'automations_beta_off', 'code_step.assist.error.beta_off');
        }
        return next();
    }

    router.post('/code/assist', deps.requireAuth, deps.rateLimit, requireAutomationsBeta, validate({ body: CodeAssistBody }), async (req, res) => {
        const userId = req.session.user.id;
        const body = req.body;
        const messages = body.messages;
        const last = messages[messages.length - 1];
        if (last.role !== 'user' || !last.content.trim()) {
            return refuse(res, 400, 'The last message must be the new message from the person.', 'invalid_request');
        }

        const automationId = body.automationId || null;
        if (automationId) {
            const automation = await Promise.resolve(deps.getAutomation(automationId)).catch(() => null);
            if (!automation) return refuse(res, 404, 'Routine not found.', 'automation_not_found');
            if (!await deps.guardEdit(req, res, automation)) return;
        }

        const model = await deps.resolveModel({ userId, session: req.session, modelTier: body.modelTier });
        if (model.refusal) return res.status(model.refusal.status).json(model.refusal.body);

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        const stopHeartbeat = startSseHeartbeat(res);
        const send = (event, data) => {
            if (res.writableEnded || res.destroyed) return;
            try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { /* socket gone */ }
        };
        // The panel's stop button closes the stream: stop the model call in
        // flight too, so a single-slot local model is free for the next ask.
        const clientAbort = new AbortController();
        let gone = false;
        res.on('close', () => {
            if (res.writableEnded) return;
            gone = true;
            try { clientAbort.abort(); } catch (_) { /* already aborted */ }
        });

        const code = typeof body.code === 'string' ? body.code : '';
        const allowedTools = body.allowedTools || [];
        const allowedHosts = body.allowedHosts || [];
        const orgId = req.session?.user?.organizationId || null;
        let turn = null;
        try {
            let toolDocs = [];
            try { toolDocs = deps.lookupToolDocs(allowedTools); }
            catch (e) { log.warn(`[CodeAssist] tool schemas unavailable: ${e.message}`); }
            const surfacesRawReasoning = typeof model.adapter?.surfacesRawReasoning === 'function' && model.adapter.surfacesRawReasoning() === true;
            turn = await runCodeAssistTurn({
                messages,
                code,
                allowedTools,
                allowedHosts,
                upstreamFields: (body.upstreamFields || []).map(f => ({ path: f.path, label: f.label || '', type: f.type || '' })),
                toolDocs,
                analyse: deps.loadAnalyser(),
                gate: deps.makeGate({ userId, orgId, automationId, modelId: model.modelId }),
                send,
                isGone: () => gone,
                surfacesRawReasoning,
                streamRound: (msgs, { tools, onText }) => deps.streamWithRetry(model.adapter, model.cfg, model.modelId, msgs, {
                    // A whole-code write is one tool call; 8192 leaves room
                    // for a long step plus its JSDoc.
                    maxTokens: 8192,
                    temperature: 0.2,
                    tools,
                    ...(model.tier?.reasoningEffort ? { reasoningEffort: model.tier.reasoningEffort } : {}),
                    userId: String(userId),
                }, {
                    send: (event, data) => { if (event === 'message' && data && data.content) onText(data.content); },
                    emitThinking: NO_THINKING,
                    signal: clientAbort.signal,
                    logPrefix: '[CodeAssist]',
                }),
            });
        } catch (e) {
            log.error('[CodeAssist] turn failed:', e.message);
            send('error', { message: 'Something went wrong in the code assistant. Your code is unchanged.', messageKey: 'code_step.assist.error.internal' });
            send('code', { code, analysis: null, changed: false, repairRounds: 0 });
        }
        const usage = turn ? turn.usage : { prompt: 0, completion: 0, cached: 0, cacheCreation: 0, rounds: 0 };
        if (usage.rounds > 0) {
            log.info(`[CodeAssist] usage automation=${automationId || '-'} step=${body.stepId || '-'} model=${model.modelId} rounds=${usage.rounds} in=${usage.prompt} cached=${usage.cached} out=${usage.completion} repairs=${turn ? turn.repairRounds : 0} changed=${turn ? turn.changed : false}`);
        }
        send('done', { usage });
        stopHeartbeat();
        if (!res.writableEnded) res.end();
    });

    return router;
}

module.exports = makeCodeAssistRouter();
module.exports.makeCodeAssistRouter = makeCodeAssistRouter;
module.exports.CodeAssistBody = CodeAssistBody;
module.exports.codeAssistRateLimit = codeAssistRateLimit;
module.exports.resolveAssistModel = resolveAssistModel;
module.exports.lookupToolDocs = lookupToolDocs;
