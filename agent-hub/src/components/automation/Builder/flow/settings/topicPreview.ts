/**
 * Counting "is about" rules against the editor's sample rows.
 *
 * An `isAbout(...)` rule has no answer in the browser: the topic classifier
 * gives it at run time. So the Suggest-outputs preview cannot count it the
 * way it counts `endsWith(...)`, and it must not pretend to ("0 of 12
 * matched" reads as a broken rule). Instead the author can ask for the sample
 * rows to be scored, and this module does what the runner's pre-pass does
 * (server/core/automationRunner/topicHost.js) on a small scale:
 *
 *   planTopicPreview — which texts to send, the full topic list, and which
 *                      rows the answer will cover (at most 25 distinct texts);
 *   hostFromPreview  — the classifier's answer as an expression host, so the
 *                      SAME engine that counts every other rule counts these.
 *
 * Pure, no React.
 */
import { parseExpr, evaluate } from '@shared/expr/engine.mjs';
import {
    TOPIC_HOST_SPEC, topicCallsOf, normalizeTopicText, makeTopicHost,
} from '@shared/expr/topics.mjs';

/** The preview endpoint's ceiling (server/routes/ai/automationBuilder/topicPreview.js). */
export const MAX_PREVIEW_TEXTS = 25;

export interface PreviewRule { name?: string; expr?: string }

export interface TopicPreviewPlan {
    labels: string[];
    texts: string[];
    /** The sample rows every text of which is in `texts`: what can be counted. */
    rows: unknown[];
}

function parseRules(rules: PreviewRule[]) {
    return (rules || []).map((r) => {
        if (typeof r?.expr !== 'string' || !r.expr.trim()) return null;
        try { return parseExpr(r.expr, { host: TOPIC_HOST_SPEC }); } catch { return null; }
    });
}

/** Does any of these rules ask "is about"? */
export function hasTopicRules(rules: PreviewRule[]): boolean {
    return topicCallsOf(parseRules(rules)).calls.length > 0;
}

/**
 * What to send for these rules over these rows, or null when there is nothing
 * to ask (no "is about" rule, or no sample rows).
 */
export function planTopicPreview(
    rules: PreviewRule[],
    rows: unknown[] | null,
    { root = null, itemVar = 'item' }: { root?: unknown; itemVar?: string } = {},
): TopicPreviewPlan | null {
    const { labels, calls } = topicCallsOf(parseRules(rules));
    if (!calls.length || !Array.isArray(rows) || !rows.length) return null;
    const base = root && typeof root === 'object' && !Array.isArray(root) ? root : null;
    const texts = new Set<string>();
    const kept: unknown[] = [];
    for (const row of rows) {
        const scope = { ...(base as object), [itemVar]: row };
        const own = new Set<string>();
        for (const call of calls) {
            try {
                const text = normalizeTopicText(evaluate(call.args[0], scope));
                if (text) own.add(text);
            } catch { /* the row's own problem; it counts as no match */ }
        }
        const added = [...own].filter((t) => !texts.has(t));
        if (texts.size + added.length > MAX_PREVIEW_TEXTS) break;
        added.forEach((t) => texts.add(t));
        kept.push(row);
    }
    return { labels, texts: [...texts], rows: kept };
}

export interface TopicPreviewResponse {
    texts?: string[];
    scores?: Array<Record<string, number>>;
    defaultThreshold?: number;
}

/** The endpoint's answer as a host for tryEvaluate, or null if it is not one. */
export function hostFromPreview(res: TopicPreviewResponse | null | undefined) {
    const list = res?.scores;
    if (!res || !Array.isArray(res.texts) || !Array.isArray(list) || res.texts.length !== list.length) return null;
    const scores = new Map(res.texts.map((t, i) => [t, list[i]]));
    const defaultThreshold = typeof res.defaultThreshold === 'number' ? res.defaultThreshold : 0.5;
    return makeTopicHost(scores, { defaultThreshold });
}
