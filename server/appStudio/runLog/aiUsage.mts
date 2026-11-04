/**
 * One model call of an App Studio step as the run log keeps it (runTrace.noteAiCall): model id,
 * tier, prompt/completion tokens and the estimated cost, rated with the same price cards the
 * usage ledger uses (modelCosts.rateUsage) in the price's own currency. An estimate for insight;
 * billing (usageStore.logUsage) is untouched. Never throws.
 */

import { createRequire } from 'node:module';
// Required, not imported: agent-hub's typecheck follows aiRuntime.js here, without the option a
// '.mts' import path needs (the reason mailboxNewRecordHook.mts requires its local modules too).
import type { AiCall } from './runTrace.mts';

const nodeRequire = createRequire(import.meta.url);

type Usage = Record<string, unknown>;

const count = (v: unknown): number => {
    const n = Math.floor(Number(v) || 0);
    return n > 0 ? Math.min(n, 2_000_000_000) : 0;
};

/** `fields` are usageNormalizer.usageLogFields(usage) (prompt_tokens, completion_tokens, cache counts). */
export function aiCallFrom(modelId: unknown, tier: unknown, fields: Usage | null | undefined): AiCall {
    const f = fields ?? {};
    const call: AiCall = {
        model: typeof modelId === 'string' && modelId ? modelId.slice(0, 200) : null,
        tier: typeof tier === 'string' && tier ? tier.slice(0, 60) : null,
        promptTokens: count(f.prompt_tokens), completionTokens: count(f.completion_tokens),
        cost: null, currency: null,
    };
    if (!call.model) return call;
    try {
        const { rateUsage } = nodeRequire('../../core/llm/modelCosts') as { rateUsage: (e: Usage) => { cost?: unknown; currency?: unknown } };
        const rated = rateUsage({ ...f, model: call.model, timestamp: Date.now() });
        const cost = Number(rated?.cost);
        if (Number.isFinite(cost) && cost >= 0) {
            call.cost = Math.round(cost * 1e6) / 1e6;
            call.currency = typeof rated?.currency === 'string' && /^[A-Z]{3}$/.test(rated.currency) ? rated.currency : 'USD';
        }
    } catch { /* no price: tokens only */ }
    return call;
}

/** aiRuntime's hook: the call into the current step's frame (a no-op, and no rating, outside one). */
export function noteStepAiCall(model: { modelId?: unknown; tierName?: unknown } | null | undefined, fields: Usage): void {
    const trace = nodeRequire('./runTrace.mts') as typeof import('./runTrace.mts');
    if (!trace.inFrame() || !model) return;
    trace.noteAiCall(aiCallFrom(model.modelId, model.tierName, fields));
}
