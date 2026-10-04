import { describe, expect, it } from 'vitest';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { RunRowData } from '../../../../api/queries/automation/runs';
import {
    formatSeconds, formatWaited, groupRunsByDay, howStartedText, runMeta, runSentence, runSubject, runTone, stepBars, stepsText,
} from './runOutcome';
import { humanKey, ioFields, mainList, stepResult } from './runIo';

// English fallback with {param} interpolation, like the app's t().
const t: TranslateFn = (_key, fallback, params) => {
    const text = typeof fallback === 'string' ? fallback : _key;
    const p = (typeof fallback === 'object' ? fallback : params) || {};
    return text.replace(/\{(\w+)\}/g, (_, k) => String((p as Record<string, unknown>)[k] ?? ''));
};

const run = (over: Partial<RunRowData>): RunRowData => ({ id: 'r1', ...over });

describe('runSentence', () => {
    it('phrases a success from its kind and params', () => {
        const ok = (params: Record<string, unknown>) => runSentence(t, run({ status: 'success', outcome: { code: 'success', params } }));
        expect(ok({ step: 'List files', kind: 'list', count: 23, noun: 'files', where: '/' })).toBe('23 files found in the main folder');
        expect(ok({ step: 'List files', kind: 'list', count: 1, noun: 'emails', where: null })).toBe('1 email found');
        expect(ok({ step: 'Read invoice', kind: 'file', name: 'Invoice-2026-001.pdf' })).toBe('Read invoice: Invoice-2026-001.pdf');
        expect(ok({ step: 'Read invoice', kind: 'record', fields: ['Acme BV', '1452'] })).toBe('Read invoice: Acme BV · 1452');
        expect(ok({ step: 'Send reply', kind: 'text' })).toBe('Finished with "Send reply"');
        expect(ok({ kind: 'none', handled: 2 })).toBe('Finished (2 step errors handled)');
    });
    it('names the step and the reason for a stop', () => {
        const stop = (params: Record<string, unknown>) => runSentence(t, run({ status: 'error', outcome: { code: 'stopped_at', params } }));
        expect(stop({ step: 'Read invoice', reasonCode: 'no_access', reason: 'no access to /Invoices', where: '/Invoices' }))
            .toBe('Stopped at "Read invoice": no access to /Invoices');
        expect(stop({ step: null, reasonCode: 'run_timeout', reason: 'the run took longer than its time limit' }))
            .toBe('Stopped: the run took longer than its time limit');
        // A step's own error title is shown as the server sent it.
        expect(stop({ step: 'Post', reasonCode: 'quota_full', reason: 'the mailbox is full' })).toBe('Stopped at "Post": the mailbox is full');
    });
    it('says why a run was skipped', () => {
        expect(runSentence(t, run({ status: 'cancelled', outcome: { code: 'cancelled', params: { reasonCode: 'already_running' } } })))
            .toBe('Skipped because the automation was already running');
    });
    it('names who a waiting run waits on', () => {
        expect(runSentence(t, run({ status: 'awaiting_approval', outcome: { code: 'waiting_approval', params: { who: 'S. de Boer' } } })))
            .toBe('Waiting for approval from S. de Boer');
        expect(runSentence(t, run({ status: 'awaiting_form', outcome: { code: 'waiting_form', params: {} } })))
            .toBe('Waiting for the next form page to be filled in');
    });
    it('uses the server sentence for a code it does not know', () => {
        expect(runSentence(t, run({ status: 'success', outcome: { code: 'new_code', text: 'Something new' } }))).toBe('Something new');
    });
    it('phrases legacy rows from their status', () => {
        expect(runSentence(t, run({ status: 'error', error: 'Folder missing' }))).toBe('Stopped: Folder missing');
        expect(runSentence(t, run({ status: 'success', summary: 'Done it' }))).toBe('Done it');
        expect(runSentence(t, run({ status: 'running' }))).toBe('Still running');
        expect(runSentence(t, run({ status: 'cancelled' }))).toBe('Stopped before it finished');
    });
});

describe('meta line', () => {
    it('says how and by whom it started', () => {
        expect(howStartedText(t, run({ howStarted: 'manual', startedBy: { name: 'admin' } }))).toBe('manually by admin');
        expect(howStartedText(t, run({ howStarted: 'file', startedBy: { name: 'm.jansen' } }))).toBe('new file from m.jansen');
        expect(howStartedText(t, run({ triggerKind: 'cron' }))).toBe('on a schedule');
    });
    it('formats durations and waits', () => {
        expect(formatSeconds(t, 8900)).toBe('8.9 s');
        expect(formatSeconds(t, 72_000)).toBe('1 m 12 s');
        const now = Date.parse('2026-09-28T12:00:00Z');
        expect(formatWaited(t, '2026-09-28T10:17:00Z', now)).toBe('1 h 43 m');
    });
    it('counts steps and draws bars', () => {
        const done = run({ status: 'success', stepsTotal: 2, stepsDone: 2 });
        expect(stepsText(t, done)).toBe('2 of 2 steps');
        expect(stepBars(done)).toEqual(['success', 'success']);
        const waiting = run({ status: 'awaiting_approval', stepsTotal: 4, stepsDone: 2 });
        expect(stepsText(t, waiting)).toBe('step 3 of 4');
        expect(stepBars(waiting)).toEqual(['success', 'success', 'waiting', 'pending']);
        expect(stepBars(run({ stepStatuses: ['success', 'error'] }))).toEqual(['success', 'error']);
    });
    it('builds the detail meta', () => {
        const now = new Date('2026-09-28T12:00:00');
        const meta = runMeta(t, run({
            startedAt: new Date('2026-09-28T10:55:00').toISOString(), durationMs: 8900, howStarted: 'manual',
            startedBy: { name: 'admin' }, version: 5, isTest: true,
        }), 'en-GB', now);
        expect(meta).toBe('Today 10:55 · 8.9 s · manually by admin · version 5 · test run');
    });
    it('finds a file name in the trigger payload', () => {
        expect(runSubject(run({ triggerPayload: { file: { path: '/Invoices/Invoice-2026-001.pdf' } } }))).toBe('Invoice-2026-001.pdf');
        expect(runSubject(run({ triggerPayload: { fileName: 'a.pdf' } }))).toBe('a.pdf');
        expect(runSubject(run({}))).toBe('');
    });
    it('maps statuses to tones', () => {
        expect(runTone(run({ status: 'awaiting_confirm' }))).toBe('waiting');
        expect(runTone(run({ status: 'queued' }))).toBe('running');
        expect(runTone(run({ status: 'weird' }))).toBe('neutral');
    });
});

describe('groupRunsByDay', () => {
    it('groups newest first under Today, Yesterday and a dated heading', () => {
        const now = new Date('2026-09-28T12:00:00');
        const groups = groupRunsByDay(t, [
            run({ id: 'a', startedAt: new Date('2026-09-26T08:54:00').toISOString() }),
            run({ id: 'b', startedAt: new Date('2026-09-28T10:55:00').toISOString() }),
            run({ id: 'c', startedAt: new Date('2026-09-28T09:12:00').toISOString() }),
            run({ id: 'd', startedAt: new Date('2026-09-27T09:12:00').toISOString() }),
        ], 'en-GB', now);
        expect(groups.map(g => g.label)).toEqual(['Today', 'Yesterday', 'Saturday 26 September']);
        expect(groups[0].runs.map(r => r.id)).toEqual(['b', 'c']);
    });
});

describe('runIo', () => {
    it('reads keys as words and ranks lists first', () => {
        expect(humanKey('fileName')).toBe('File name');
        const fields = ioFields(t, { note: 'hi', count: 23, files: [1, 2, 3] });
        expect(fields.map(f => f.label)).toEqual(['Files', 'Count', 'Note']);
        expect(fields[0].preview).toBe('table · 3 rows');
    });
    it('picks the longest list for the table and the result line', () => {
        expect(mainList({ a: [1], b: [1, 2] })?.key).toBe('b');
        expect(stepResult(t, { stepId: 's', output: { files: [1, 2] } })).toBe('2 files');
        expect(stepResult(t, { stepId: 's', error: 'No access' })).toBe('No access');
    });
    it('never takes a code step\'s console lines for its list', () => {
        const out = { result: { total: 2 }, logs: ['a', 'b', 'c'], httpCalls: 0 };
        expect(mainList(out)).toBeNull();
        expect(mainList(out, 'code')).toBeNull();
        expect(stepResult(t, { stepId: 's', stepType: 'code', output: out })).toBe('1 fields');
    });
    it('reads the list inside what a code step returned', () => {
        expect(mainList({ result: [1, 2], logs: ['a', 'b', 'c'] }, 'code')).toEqual({ key: '', rows: [1, 2] });
        expect(mainList({ result: { lines: [1, 2] }, logs: ['a', 'b', 'c'] }, 'code')).toEqual({ key: 'lines', rows: [1, 2] });
        expect(stepResult(t, { stepId: 's', stepType: 'code', output: { result: [1, 2, 3], logs: [] } })).toBe('3 items');
        expect(stepResult(t, { stepId: 's', stepType: 'code', output: { result: 'ok', logs: ['x'] } })).toBe('ok');
    });
});
