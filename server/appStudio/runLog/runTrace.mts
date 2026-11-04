/**
 * The AI calls of ONE step, collected while it runs (AsyncLocalStorage, so no executor
 * signature changes). The run log wraps a step in `captureStep`; aiRuntime's usage hook calls
 * `noteAiCall` for every model call, which is a no-op outside a frame. Only counts, model ids,
 * tiers and the estimated cost travel here: never a prompt or an answer. Imports nothing local
 * (it sits under the executor and the runners alike).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type AiCall = {
    model: string | null; tier: string | null; promptTokens: number; completionTokens: number;
    cost: number | null; currency: string | null;
};

export type AiSummary = {
    calls: number; promptTokens: number; completionTokens: number; model: string | null; tier: string | null;
    cost: number | null; currency: string | null;
};

/** Calls kept per step frame (a tool loop of a chat makes many). Beyond it they are still counted. */
export const MAX_CALLS_PER_FRAME = 200;

type Frame = { calls: AiCall[]; extra: number; extraPrompt: number; extraCompletion: number };

const storage = new AsyncLocalStorage<Frame>();

/** Run `fn` with a fresh frame; its AI calls come back beside its value. */
export async function captureStep<T>(fn: () => Promise<T> | T): Promise<{ value: T; ai: AiSummary | null }> {
    const frame: Frame = { calls: [], extra: 0, extraPrompt: 0, extraCompletion: 0 };
    const value = await storage.run(frame, fn);
    return { value, ai: summarizeAi(frame) };
}

/** True inside a captureStep frame (a caller can skip rating a call nobody records). */
export function inFrame(): boolean {
    return storage.getStore() !== undefined;
}

/** One model call; no-op outside a captureStep frame. Past MAX_CALLS_PER_FRAME only its tokens count. */
export function noteAiCall(call: AiCall): void {
    const frame = storage.getStore();
    if (!frame) return;
    if (frame.calls.length < MAX_CALLS_PER_FRAME) { frame.calls.push(call); return; }
    frame.extra += 1;
    frame.extraPrompt += call.promptTokens || 0;
    frame.extraCompletion += call.completionTokens || 0;
}

/**
 * The calls of a frame as one line: summed tokens, the last model and tier (a step uses one),
 * the cost of the calls in the first currency seen (prices of one step share a currency).
 */
export function summarizeAi(frame: Partial<Frame> & { calls: AiCall[] }): AiSummary | null {
    const extra = frame.extra ?? 0;
    if (!frame.calls.length && !extra) return null;
    let promptTokens = frame.extraPrompt ?? 0; let completionTokens = frame.extraCompletion ?? 0;
    let cost: number | null = null; let currency: string | null = null;
    let model: string | null = null; let tier: string | null = null;
    for (const c of frame.calls) {
        promptTokens += c.promptTokens || 0;
        completionTokens += c.completionTokens || 0;
        if (c.model) model = c.model;
        if (c.tier) tier = c.tier;
        if (c.cost === null || !Number.isFinite(c.cost) || !c.currency) continue;
        if (currency === null) currency = c.currency;
        if (c.currency === currency) cost = (cost ?? 0) + c.cost;
    }
    return {
        calls: frame.calls.length + extra, promptTokens, completionTokens, model, tier,
        cost: cost === null ? null : Math.round(cost * 1e6) / 1e6, currency,
    };
}
