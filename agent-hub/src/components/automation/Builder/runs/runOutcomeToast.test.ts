// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { TranslateFn } from '@/hooks/useTranslation';
import EN_DEFAULTS from '@/i18n/en-defaults';
import type { FlowDefinition } from '../flow/types';
import { runOutcomeToast, runToastFor, toastStepLabel, type ToastRun } from './runOutcomeToast';

const used = new Map<string, string>();
// English fallback with {param} interpolation, like the app's t(); records every key it was asked for.
const t: TranslateFn = (key, fallback, params) => {
    const text = typeof fallback === 'string' ? fallback : String(key);
    if (key && typeof fallback === 'string') used.set(key, fallback);
    const p = (typeof fallback === 'object' ? fallback : params) || {};
    return text.replace(/\{(\w+)\}/g, (_, k) => String((p as Record<string, unknown>)[k] ?? ''));
};

const sink = () => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() });

function shown(run: ToastRun | null, stepLabel?: string) {
    const s = sink();
    const out = runOutcomeToast(t, run, { stepLabel }, s);
    const calls = (['success', 'info', 'error'] as const).filter(k => s[k].mock.calls.length);
    expect(calls).toEqual([out.tone]);
    expect(s[out.tone]).toHaveBeenCalledWith(out.message);
    return out;
}

describe('runOutcomeToast', () => {
    it('done: a success that says which kind of run finished', () => {
        expect(shown({ status: 'success', mode: 'dry_run' })).toEqual({ tone: 'success', message: 'Dry run finished. Open a step to see its output.' });
        expect(shown({ status: 'success', mode: 'live', isTest: true })).toEqual({ tone: 'success', message: 'Test run finished. Open a step to see its output.' });
        expect(shown({ status: 'success', mode: 'live' })).toEqual({ tone: 'success', message: 'Run finished. Open a step to see its output.' });
        expect(shown({ status: 'success', profile: { kind: 'dry' } }).message).toMatch(/^Dry run finished/);
    });

    it('paused_approval: an info naming the step, never "complete"', () => {
        expect(shown({ status: 'awaiting_approval', isTest: true }, 'Manager approves')).toEqual({ tone: 'info', message: 'Waiting for a decision on "Manager approves"' });
        expect(shown({ status: 'awaiting_approval' })).toEqual({ tone: 'info', message: 'Waiting for approval' });
        // The legacy first-run hold keeps the Runs tab's sentence.
        expect(shown({ status: 'awaiting_confirm' }, 'Ignored')).toEqual({ tone: 'info', message: 'Waiting for someone to confirm the first run' });
    });

    it('paused_form: an info naming the step', () => {
        expect(shown({ status: 'awaiting_form' }, 'Page 2')).toEqual({ tone: 'info', message: 'Waiting for the form on "Page 2"' });
        expect(shown({ status: 'awaiting_form' })).toEqual({ tone: 'info', message: 'Waiting for the next form page to be filled in' });
    });

    it('failed: an error naming the failed step', () => {
        expect(shown({ status: 'error', mode: 'dry_run', error: 'HTTP 500' }, 'Post to channel')).toEqual({ tone: 'error', message: 'Stopped at "Post to channel": HTTP 500' });
        expect(shown({ status: 'error' }, 'Post to channel')).toEqual({ tone: 'error', message: 'Stopped at "Post to channel"' });
        expect(shown({ status: 'error', error: 'boom' })).toEqual({ tone: 'error', message: 'Stopped: boom' });
        // The server's outcome already names the step and the reason.
        expect(shown({ status: 'error', outcome: { code: 'stopped_at', params: { step: 'Read file', reasonCode: 'not_found' } } }, 'Read file'))
            .toEqual({ tone: 'error', message: 'Stopped at "Read file": the file, board or room was not found' });
    });

    it('cancelled: an info that says it stopped', () => {
        expect(shown({ status: 'cancelled' })).toEqual({ tone: 'info', message: 'Stopped before it finished' });
        expect(shown({ status: 'cancelled', outcome: { code: 'cancelled', params: { reasonCode: 'already_running' } } }))
            .toEqual({ tone: 'info', message: 'Skipped because the automation was already running' });
    });

    it('a run that is still going, or no run at all, never reads as finished', () => {
        expect(shown({ status: 'running' })).toEqual({ tone: 'info', message: 'Still running' });
        expect(shown(null)).toEqual({ tone: 'info', message: 'Still running' });
    });

    it('uses only keys the dictionary has, with the same English', () => {
        used.clear();
        for (const status of ['success', 'awaiting_approval', 'awaiting_form', 'error', 'cancelled', 'running']) {
            for (const extra of [{ mode: 'dry_run' }, { isTest: true }, {}]) runToastFor(t, { status, ...extra }, { stepLabel: 'S' });
        }
        expect(used.size).toBeGreaterThan(5);
        for (const [key, english] of used) expect((EN_DEFAULTS as Record<string, string>)[key]).toBe(english);
    });
});

describe('toastStepLabel', () => {
    const def: FlowDefinition = {
        trigger: { id: 't1', label: 'Form' },
        steps: [{ id: 'a1', label: 'Manager approves' }, { id: 's1', tool: 'slack.post_message' }],
    };

    it('names the step a paused run waits on', () => {
        expect(toastStepLabel(def, { status: 'awaiting_approval', awaitingStepId: 'a1' }, [])).toBe('Manager approves');
        expect(toastStepLabel(def, { status: 'awaiting_approval' }, [{ stepId: 't1', status: 'success' }, { stepId: 'a1', status: 'awaiting_approval' }])).toBe('Manager approves');
    });

    it('names the last top-level step that failed', () => {
        const steps = [{ stepId: 't1', status: 'success' }, { stepId: 's1', status: 'error' }, { stepId: 'x/in', status: 'error', parentStepId: 'x' }];
        expect(toastStepLabel(def, { status: 'error' }, steps)).toBe('slack.post_message');
    });

    it('says nothing for a finished run, an unknown step or no steps', () => {
        expect(toastStepLabel(def, { status: 'success' }, [{ stepId: 's1', status: 'error' }])).toBe('');
        expect(toastStepLabel(def, { status: 'awaiting_form', awaitingStepId: 'gone' }, [])).toBe('');
        expect(toastStepLabel(null, { status: 'error' }, undefined)).toBe('');
    });
});
