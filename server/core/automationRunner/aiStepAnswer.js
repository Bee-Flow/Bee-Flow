/** @typedef {import('../automationModel/bind').BindRunState} BindRunState */
// @typecheck
'use strict';
/**
 * How an ai_step gets its answer (split out of execAi.execAiStep): the model
 * call, the parse, the output guard, the restore, then the step's checks, one
 * repair round and the fallback.
 *
 * Two routes to the model:
 *   - STRUCTURED: the step has a schema and offers no tools. The schema goes to
 *     llmClient.chatForcedTool (native json_schema where the adapter can
 *     enforce it, else a forced tool call), so the answer conforms by
 *     construction instead of by the model's good intentions. The
 *     "Return JSON matching this schema" text stays in the prompt: it helps
 *     small models on both routes.
 *   - PROMPT: everything else (tools, no schema, a schema that cannot be a tool
 *     definition): chat + a tolerant parse of the reply, as before.
 *
 * With no `enumFrom`, `checks` or `fallback` on the step (`rel.active` false)
 * nothing below changes the answer. Otherwise the restored answer is checked
 * against RAW run data (aiStepChecks); a failing answer gets ONE repair round
 * (aiStepRepair) and then the fallback. An accepted answer may be reused
 * (aiStepCache) by a step with `askOnce`; it never is when it was cut off, was
 * a fallback, or came out of a tool loop that hit its cap.
 */

const safety = require('./safety');
const { createUsageAccumulator } = require('../providers/usageNormalizer');
const { parseAiStepOutput } = require('./aiStepOutputParse');
const { runAiStepChat } = require('./aiStepToolLoop');
const { logAiStepUsage } = require('./aiStepMessages');
const {
    toToolParameters, resolveLists, allowedValuesMessage, guardedListsOf, injectEnums,
} = require('./aiStepEnum');
const { evaluateAnswer } = require('./aiStepChecks');
const { buildRepairMessages, makeCheckReport, applyFallback } = require('./aiStepRepair');

const TOOL_NAME = 'step_answer';

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Before the input guard: the step's reliability settings, and the ONE extra
 * user message that carries the allowed values (so the guard tokenises it
 * together with the prompt). Appends to `messages`.
 */
function prepareAiAnswer({ step, runState, ctx, mode, messages }) {
    const { normalizeAiStepReliability } = require('../automationModel/aiStepReliability');
    const rel = normalizeAiStepReliability(step);
    const lists = rel.enumFrom.length ? resolveLists(rel.enumFrom, runState, { mode, ctx }) : [];
    const listsMessage = allowedValuesMessage(lists);
    if (listsMessage) messages.push(listsMessage);
    return { rel, lists, listsMessage };
}

/** The reuse plan (aiStepCache), or null when this step does not ask for reuse. */
async function planReuse(call, route, parameters, rel, cache) {
    const { step, ctx, mode, policy, messages, tools, model } = call;
    if (!step.askOnce || !cache) return null;
    const { limiterKeyFor } = require('../llm/providerLimiter');
    return cache.planAiReuse({
        step, ctx, mode, policy, modelId: model.modelId,
        providerKey: limiterKeyFor({ adapterName: model.adapter.name, url: model.cfg.url, apiKey: model.cfg.apiKey }),
        toolsOffered: !!(tools && tools.length),
        request: {
            route, messages, schema: parameters, temperature: rel.temperature,
            maxOutputTokens: model.maxOutputTokens, reasoningEffort: model.stepReasoningEffort ?? null,
        },
    });
}

/**
 * Get the step's answer.
 * @param {any} call { step, ctx, runState, mode, policy, auditBase, messages, tools, contract, prep, model, agentBinding }
 * @param {{ llmClient?: any, cache?: any }} [deps] injected in tests
 * @returns {Promise<{ output: any, categories: any[], checkReport?: any, reused?: 'run'|'stored' }>}
 */
async function answerAiStep(call, deps = {}) {
    const { step, ctx, runState, mode, policy, auditBase, messages, tools, contract, prep, model } = call;
    const { rel, lists, listsMessage } = prep;
    const { adapter, cfg, modelId, maxOutputTokens, stepReasoningEffort } = model;
    const signal = ctx.cancelSignal;
    const usageAcc = createUsageAccumulator();
    const accrueUsage = (resp) => usageAcc.add(resp && resp.usage ? resp.usage : null);
    const run = { calls: 0, hitIterationCap: false };
    const categories = [];
    const cache = deps.cache || (step.askOnce ? require('./aiStepCache') : null);

    // The structured route: the schema as tool parameters, allowed values from the GUARDED message.
    const parameters = !(tools && tools.length) && contract.effectiveSchema ? toToolParameters(contract.effectiveSchema) : null;
    if (parameters && listsMessage) {
        injectEnums(parameters, guardedListsOf(listsMessage), (lists || []).filter((l) => l.allowEmpty).map((l) => l.field));
    }
    const route = parameters ? 'structured' : 'prompt';
    const toolDef = parameters
        ? { type: 'function', function: { name: TOOL_NAME, description: 'Return the answer of this automation step.', parameters } }
        : null;
    const base = messages.slice(); // before a tool loop appends its rounds

    /** One model call; the answer as { content, structured, stopReason }. */
    const ask = async (msgs, isRepair) => {
        run.calls += 1;
        const effort = stepReasoningEffort !== undefined ? { reasoningEffort: stepReasoningEffort } : {};
        if (route === 'structured') {
            const llmClient = deps.llmClient || require('../llm/llmClient');
            const r = await llmClient.chatForcedTool(modelId, msgs, toolDef, {
                maxTokens: maxOutputTokens, temperature: rel.temperature, ...effort, rateLimit: { signal },
            });
            accrueUsage(r);
            return {
                content: typeof r?.content === 'string' ? r.content : null,
                structured: isPlain(r?.structured) ? r.structured : null,
                stopReason: r?.stopReason || null,
            };
        }
        const { response, hitIterationCap } = await runAiStepChat({
            adapter, cfg, modelId, messages: msgs, maxOutputTokens, stepReasoningEffort, temperature: rel.temperature,
            tools: isRepair ? null : tools, accrueUsage, step, ctx, mode, policy, auditBase, agentBinding: call.agentBinding,
        });
        if (hitIterationCap) run.hitIterationCap = true;
        return { content: response?.content || '', structured: null, stopReason: response?.stop_reason ?? response?.stopReason ?? null };
    };

    /** Parse -> output guard -> restore -> checks. `errors` stays empty when the step has no checks. */
    const attempt = async (answer) => {
        let output;
        try {
            output = answer.structured || parseAiStepOutput(answer.content || '', { step, ...contract });
        } catch (e) {
            if (!rel.active || e.errorClass !== 'ValidationError') throw e;
            const errors = [{ code: 'no_answer', path: '', message: 'the answer was not in the requested format', modelValue: '' }];
            return { answer, output: answer.content || '', restored: undefined, errors };
        }
        // Guard model output (agentOutput scope), then restore from the RUN VAULT so
        // downstream steps see real values (the model saw placeholders). The vault holds
        // every token this run has minted, so nothing survives as an unresolvable literal.
        const aiOut = await safety.guardAiOutput(output, policy, auditBase, mode, ctx);
        categories.push(...(aiOut.categories || []));
        const restoredRaw = safety.restoreForRunState(aiOut.content, ctx);
        if (!rel.active) return { answer, output, restored: restoredRaw, errors: [] };
        const restored = restoredRaw && typeof restoredRaw === 'object' ? structuredClone(restoredRaw) : restoredRaw;
        const errors = evaluateAnswer({
            restored, modelOutput: aiOut.content, rel, lists, runState, mode, ctx, schema: toToolParameters(contract.effectiveSchema),
        });
        return { answer, output, restored, errors };
    };

    try {
        const plan = await planReuse(call, route, parameters, rel, cache);
        let first = null;
        let reused = null;
        if (plan) {
            const r = await cache.readAiReuse(plan);
            if (r && r.hit) {
                try {
                    const cand = await attempt({ content: r.hit.content, structured: r.hit.structured, stopReason: null });
                    if (!cand.errors.length) { first = cand; reused = r.reused; }
                } catch (e) {
                    if (e.errorClass !== 'ValidationError') throw e; // a hit that no longer parses is a miss
                }
            }
        }
        if (!first) first = await attempt(await ask(messages, false));

        let final = first;
        let repaired = false;
        if (first.errors.length && rel.active) {
            const repairMsgs = await buildRepairMessages({
                base, prior: first.output, errors: first.errors, policy, auditBase, mode, ctx,
            });
            if (repairMsgs) {
                repaired = true;
                final = await attempt(await ask(repairMsgs, true));
            }
        }
        if (final.errors.length) {
            const output = applyFallback({ step, rel, runState, errors: final.errors });
            return {
                output, categories,
                checkReport: makeCheckReport({ passed: false, repaired, fallbackUsed: true, errors: final.errors }),
            };
        }
        // Accepted: passed first time or after the repair. Never store a cut-off
        // answer or one a tool loop gave up on.
        if (plan && !reused && final.answer.stopReason !== 'length' && !run.hitIterationCap) {
            cache.rememberAiAnswer(plan, {
                answer: { content: final.answer.content, structured: final.answer.structured }, userId: ctx.userId,
            });
        }
        return {
            output: final.restored, categories,
            ...(rel.active ? { checkReport: makeCheckReport({ passed: true, repaired, fallbackUsed: false, errors: [] }) } : {}),
            ...(reused ? { reused } : {}),
        };
    } finally {
        if (run.calls > 0) logAiStepUsage(ctx, modelId, usageAcc, run.hitIterationCap);
    }
}

module.exports = { answerAiStep, prepareAiAnswer, TOOL_NAME };
