/**
 * The compact one-line summary of a sequence's step tree the builder prompt shows
 * per action: `steps[3]{confirm → create_record(tbl_x)↻2!onError → toast}`.
 * `↻n` = the step is retried up to n times, `!onError` = it has an error handler,
 * `transaction{n}` = n record writes saved all or none.
 *
 * How a kind reads is its `summary` in the step catalogue (componentSpecs/stepMeta.js, or the
 * kind's own registry file); a kind without one reads as its name.
 */

import { createRequire } from 'node:module';

type Step = Record<string, unknown>;

const { stepMetaOf } = createRequire(import.meta.url)('../componentSpecs/stepRegistry.js') as {
    stepMetaOf: (kind: unknown) => { summary?: (step: Step) => string } | null;
};

function base(s: Step): string {
    const summary = stepMetaOf(s.kind)?.summary;
    if (summary) return summary(s);
    return typeof s.kind === 'string' && s.kind ? s.kind : '?';
}

function label(s: unknown): string {
    if (!s || typeof s !== 'object') return '?';
    const step = s as Step;
    const retry = step.retry && typeof step.retry === 'object' ? (step.retry as { times?: unknown }).times : null;
    const retried = typeof retry === 'number' && retry > 0 ? `↻${retry}` : '';
    const handled = step.onError && typeof step.onError === 'object' ? '!onError' : '';
    return `${base(step)}${retried}${handled}`;
}

export function summariseSteps(steps: unknown): string {
    if (!Array.isArray(steps) || !steps.length) return 'steps[0]';
    const shown = steps.slice(0, 6).map(label);
    if (steps.length > 6) shown.push('…');
    return `steps[${steps.length}]{${shown.join(' → ')}}`;
}
