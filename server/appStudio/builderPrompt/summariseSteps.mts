/**
 * The compact one-line summary of a sequence's step tree the builder prompt shows
 * per action: `steps[3]{confirm → create_record(tbl_x)↻2!onError → toast}`.
 * `↻n` = the step is retried up to n times, `!onError` = it has an error handler,
 * `transaction{n}` = n record writes saved all or none.
 */

type Step = Record<string, unknown>;

function base(s: Step): string {
    if (s.kind === 'create_record' || s.kind === 'update_record' || s.kind === 'delete_record') {
        return `${String(s.kind)}(${String(s.tableId || '?')})`;
    }
    if (s.kind === 'navigate') return `navigate→${String(s.screenId)}`;
    if (s.kind === 'run_automation') return `run_automation(${String(s.automationId ?? 'null')})`;
    if (s.kind === 'call_action') return `call_action→${String(s.actionId)}`;
    if (s.kind === 'condition' || s.kind === 'loop' || s.kind === 'switch') return `${s.kind}{…}`;
    if (s.kind === 'transaction') return `transaction{${Array.isArray(s.steps) ? s.steps.length : 0}}`;
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
