import type { TranslateFn } from '../../hooks/useTranslation';

/**
 * A plan refusal from the routine routes, as a sentence someone can act on.
 *
 * Activating, publishing or test-running a routine with a step the plan does
 * not include (server/automation/licensedSteps.js: a new Privacy Shield step,
 * an approval) answers 403 with a sentence in `error`, the licence code in
 * `code` (`feature_locked` / `feature_disabled`) and one record per step in
 * `details`. The builder's fetch helpers join `error` and the details into one
 * message; this prefers the step sentences themselves when they travelled.
 * A licence gate that writes no sentence (requireCapability, such as the
 * `automations` gate on the whole mount) sends the code itself in `error`,
 * which is how "feature_locked" reached the screen: that word is stripped,
 * and with nothing left a plain line stands in.
 */

interface RefusalLike {
    status?: number;
    code?: string | null;
    message?: string;
    details?: unknown;
}

const PLAN_CODES = new Set(['feature_locked', 'feature_disabled']);
const PLAN_WORD_RX = /^feature_(?:locked|disabled)\b:?\s*/;

/** True for a licence refusal (feature_locked / feature_disabled). */
export function isPlanRefusal(e: unknown): boolean {
    if (!e || typeof e !== 'object') return false;
    const { code, message } = e as RefusalLike;
    if (typeof code === 'string' && PLAN_CODES.has(code)) return true;
    return typeof message === 'string' && PLAN_WORD_RX.test(message);
}

function detailLine(d: unknown): string {
    if (typeof d === 'string') return d;
    if (!d || typeof d !== 'object') return '';
    const { message, hint } = d as { message?: unknown; hint?: unknown };
    return [message, hint].filter((x): x is string => typeof x === 'string' && !!x.trim()).join(' ');
}

/** The refusal in words, or null when `e` is not a plan refusal. */
export function planRefusalText(e: unknown, t?: TranslateFn | null): string | null {
    if (!isPlanRefusal(e)) return null;
    const err = e as RefusalLike;
    const lines = Array.isArray(err.details) ? err.details.map(detailLine).filter(Boolean) : [];
    if (lines.length) return lines.join(' ');
    const said = String(err.message || '').replace(PLAN_WORD_RX, '').trim();
    if (said) return said;
    const fallback = 'This is not part of your organisation\'s plan.';
    return t ? t('automation.plan.refused', fallback) : fallback;
}
