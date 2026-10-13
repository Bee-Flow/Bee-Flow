/**
 * extractFormState for the steps that act: the AI step, an app action, code,
 * a notification and an HTTP request.
 */
import { readAgentPermissions, readSkillIds } from '../aiStepAgent';
import { schemaToFields } from '../outputSchema';
import { normalizeAskOnce, normalizeCacheInto } from '../stepOptions';
import type { TypeExtractor } from '../types';

export const actionExtractors: Record<string, TypeExtractor> = {
    ai_step: (step, base) => {
        return {
            ...base,
            prompt: step.prompt || '',
            systemPrompt: step.systemPrompt || '',
            modelTier: step.modelTier || 'auto',
            allowTools: !!step.allowTools,
            // Explicit per-tool allowlist (function names). `null` = not set:
            // combined with allowTools it means the legacy "all permitted tools".
            tools: Array.isArray(step.tools) ? step.tools : null,
            inputs: step.inputs || {},
            outputFields: schemaToFields(step.outputSchema),
            // Knowledge Base grounding (BFSF-410) — always an array, never null:
            // unlike `tools` there is no legacy "unset vs empty" distinction to
            // preserve here, so the draft mirrors the persisted shape exactly.
            knowledgeBaseIds: Array.isArray(step.knowledgeBaseIds) ? step.knowledgeBaseIds : [],
            // R2 — who does the thinking, and what they may do here. Like
            // knowledgeBaseIds and unlike `tools`, all three are ALWAYS a
            // concrete value: there is no legacy "unset means everything" to
            // preserve, so an absent field reads as "no agent, no skills, no
            // permissions" and reads that way in every direction.
            agentId: typeof step.agentId === 'string' && step.agentId.trim() ? step.agentId.trim() : null,
            skillIds: readSkillIds(step.skillIds),
            // The agent's own skills switched off for THIS step (handoff 5).
            disabledAgentSkillIds: readSkillIds(step.disabledAgentSkillIds),
            agentPermissions: readAgentPermissions(step.agentPermissions),
            // "Run once per item" — the inspector rendered the tick, but the
            // round-trip dropped it in BOTH directions for ai_step (C12).
            forEach: step.forEach || null,
        };
    },
    integration_action: (step, base) => {
        return {
            ...base,
            tool: step.tool || '',
            appId: step.appId || null,
            sideEffect: step.sideEffect ?? null,
            inputs: step.inputs || {},
            forEach: step.forEach || null,
            // "Ask this app only once per run" — the toggle shipped, the
            // round-trip did not: without this key the draft and the baseline
            // both lacked it, so flushNow's buildPatch comparison found them
            // equal and returned without calling onPatch at all. The tick
            // showed, nothing reached the server, reopening the node showed it
            // off again.
            askOnce: normalizeAskOnce(step.askOnce),
        };
    },
    // `inputs` rides along because the RUNNER has always read it
    // (execOutbound execCode resolves them before the isolate exists) and the
    // validator even tells the author to use them — "pass the value in through
    // `inputs`" is the hint on code.secret_keys_unsupported — while no screen
    // could set one. codeFields.jsx has shipped the table for exactly this,
    // gated on a probe that asks whether the round trip carries `inputs`
    // rather than assuming it; the probe is what turns it on.
    code: (step, base) => ({ ...base, code: step.code || '', inputs: step.inputs || {}, allowedHosts: Array.isArray(step.allowedHosts) ? step.allowedHosts : [], forEach: step.forEach || null }),
    // `channels` rides along now that the form can edit it (BFSF-350) — it was
    // runner-honoured but form-invisible, so a step's delivery target could
    // only be set through the JSON tab.
    notification: (step, base) => ({ ...base, title: step.title || '', body: step.body || '', channels: Array.isArray(step.channels) ? step.channels : null, forEach: step.forEach || null }),
    http_request: (step, base) => ({
        ...base,
        url: step.url || '',
        method: step.method || 'GET',
        headers: step.headers && typeof step.headers === 'object' ? step.headers : {},
        body: step.body || '',
        // Structured query parameters; null = the section is off.
        query: step.query && typeof step.query === 'object' ? step.query : null,
        timeoutMs: typeof step.timeoutMs === 'number' ? step.timeoutMs : 10_000,
        blockPrivateTargets: step.blockPrivateTargets !== false,
        parseResponse: step.parseResponse || 'auto',
        forEach: step.forEach || null,
        // Saved HTTP credential reference — only the opaque connectionId lives
        // in the definition; the secret stays in the org vault.
        auth: (step.auth && typeof step.auth === 'object' && step.auth.connectionId)
            ? { connectionId: step.auth.connectionId }
            : null,
        // Carried even though no editor writes it yet: a hand-edited or
        // imported definition can already hold one, and a form that extracts
        // nothing here would strip it on the next unrelated save.
        askOnce: normalizeAskOnce(step.askOnce),
        // "Remember answers in a table" — the VISIBLE tier, an independent tick
        // from askOnce. Same round-trip rule: a definition that already carries
        // one must survive an unrelated save.
        cacheInto: normalizeCacheInto(step.cacheInto),
    }),
};
