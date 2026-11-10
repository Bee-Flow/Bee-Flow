/**
 * The formula forms of the client steps (schema version 3): a toast or confirm whose text is a formula
 * (`messageExpr`, `titleExpr`, ...), a navigate whose screen is a formula (`screenExpr`) and an open_url
 * whose address is a formula (`urlExpr`). A step without any of those fields goes through untouched, so a
 * literal step behaves exactly as before.
 *
 * A formula can only be trusted for what it says, never for where it points: a screen must be one of the
 * app's own, an address must be https on a host the person listed in `allowedLinkHosts`. Anything else
 * throws, which ends the sequence with the usual failure toast. Nothing here ever builds a route or a
 * link out of free text.
 */
import { tryEvaluate } from '@shared/expr/engine.mjs';
import type { RunStep, Translate } from './core';

/** formula field → the literal field it stands in for, and the longest text the literal field allows. */
const TEXT_FIELDS: Array<{ expr: string; literal: string; max: number }> = [
    { expr: 'messageExpr', literal: 'message', max: 500 },
    { expr: 'titleExpr', literal: 'title', max: 120 },
    { expr: 'confirmLabelExpr', literal: 'confirmLabel', max: 80 },
    { expr: 'cancelLabelExpr', literal: 'cancelLabel', max: 80 },
];

/** What a formula result reads as in a message: text and numbers, nothing for the rest. */
function asText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
}

function clip(text: string, max: number): string {
    const chars = Array.from(text);
    return chars.length > max ? chars.slice(0, max).join('') : text;
}

/**
 * The step with its text formulas worked out, for toast and confirm. A formula that gives nothing leaves the
 * literal field in place. Returns the same object when the step has no formula field.
 */
export function withResolvedText(step: RunStep, scope: unknown): RunStep {
    if (!TEXT_FIELDS.some((f) => typeof step[f.expr] === 'string' && step[f.expr])) return step;
    const out: RunStep = { ...step };
    for (const f of TEXT_FIELDS) {
        const src = step[f.expr];
        if (typeof src !== 'string' || !src) continue;
        const text = asText(tryEvaluate(src, scope).value).trim();
        if (text) out[f.literal] = clip(text, f.max);
    }
    return out;
}

/** The screen a navigate step opens, or throws. A step with a literal screenId and no formula returns it as is. */
export function resolveScreenId(step: RunStep, scope: unknown, screens: unknown, tr: Translate): string {
    const expr = step.screenExpr;
    if (typeof expr !== 'string' || !expr) return step.screenId as string;
    const got = asText(tryEvaluate(expr, scope).value).trim();
    const id = got || (typeof step.screenId === 'string' ? step.screenId : '');
    if (!id) throw new Error(tr('studio_apps_dynamic_text.screen_empty', 'The formula for the screen to open gave no screen.'));
    const known = Array.isArray(screens) && screens.some((sc) => sc && typeof sc === 'object' && (sc as { id?: unknown }).id === id);
    if (!known) throw new Error(tr('studio_apps_dynamic_text.screen_unknown', 'This step opens the screen “{screen}”, which is not part of this app.', { screen: clip(id, 80) }));
    return id;
}

/** The address an open_url step opens, or throws. '' means the literal `url` field applies (no formula on the step). */
export function resolveOpenUrl(step: RunStep, scope: unknown, allowedHosts: unknown, tr: Translate): string {
    const expr = step.urlExpr;
    if (typeof expr !== 'string' || !expr) return '';
    const raw = asText(tryEvaluate(expr, scope).value).trim();
    if (!raw) {
        if (typeof step.url === 'string' && step.url) return '';
        throw new Error(tr('studio_apps_dynamic_text.url_empty', 'The formula for the address to open gave no address.'));
    }
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error(tr('studio_apps_dynamic_text.url_invalid', 'The formula for the address to open did not give a web address.')); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
        throw new Error(tr('studio_apps_dynamic_text.url_not_https', 'Only plain https addresses can be opened from an app.'));
    }
    const hosts = Array.isArray(allowedHosts) ? allowedHosts : [];
    if (!hosts.includes(url.hostname.toLowerCase())) {
        throw new Error(tr('studio_apps_dynamic_text.url_host_not_allowed', 'The address was not opened: its host “{host}” is not on the app’s list of allowed hosts.', { host: clip(url.hostname, 80) }));
    }
    return url.href;
}
