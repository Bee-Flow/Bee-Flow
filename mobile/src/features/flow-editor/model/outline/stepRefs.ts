/**
 * Which steps a step reads — every `steps.<id>.output` written anywhere in
 * its settings, the way the server's reference check reads them
 * (validate/stepRules/referenceScoping.js). Its id, position and label are
 * not settings; a pinned output is data, not a reference.
 */

const STEP_REF = /steps\.([A-Za-z0-9_-]+)\.output/g;

export function stepsReadBy(step: unknown): Set<string> {
    const out = new Set<string>();
    if (!step || typeof step !== 'object') return out;
    const rest: Record<string, unknown> = { ...(step as Record<string, unknown>) };
    for (const key of ['id', 'position', 'label', 'pinnedOutput']) delete rest[key];
    let text = '';
    try {
        text = JSON.stringify(rest) || '';
    } catch {
        return out;
    }
    for (const m of text.matchAll(STEP_REF)) out.add(m[1] as string);
    return out;
}
