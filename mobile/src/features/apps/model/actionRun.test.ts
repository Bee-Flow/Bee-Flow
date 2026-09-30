/**
 * An app action's run: which answer the button shows and when it stops
 * spinning. The statuses it polls through are the web runner's, read out of
 * useActionRunner.js.
 */

import fs from 'node:fs';
import path from 'node:path';

import { GOING_STATUSES, keepPolling, pollRunId, runView } from './actionRun';
import type { AppActionResult } from './types';

const pending: AppActionResult = { runId: 'r1', status: 'pending' };

describe('pollRunId', () => {
    it('polls a 202, and nothing that has already ended or has no run id', () => {
        expect(pollRunId(pending)).toBe('r1');
        expect(pollRunId({ runId: 'r1', status: 'running' })).toBe('r1');
        expect(pollRunId({ runId: 'r1', status: 'success', output: 1 })).toBeNull();
        expect(pollRunId({ runId: 'r1', status: 'awaiting_approval', approvalId: 'a1' })).toBeNull();
        expect(pollRunId({ runId: null, status: 'pending' })).toBeNull();
        expect(pollRunId({ status: 'skipped', message: 'Busy' })).toBeNull();
        expect(pollRunId(null)).toBeNull();
    });
});

describe('keepPolling', () => {
    it('goes on until an answer says the run stopped, or the poll failed', () => {
        expect(keepPolling(undefined, false)).toBe(true);
        expect(keepPolling({ runId: 'r1', status: 'running' }, false)).toBe(true);
        expect(keepPolling({ runId: 'r1', status: 'queued' }, false)).toBe(true);
        expect(keepPolling({ runId: 'r1', status: 'success' }, false)).toBe(false);
        expect(keepPolling({ runId: 'r1', status: 'error', error: 'Boom' }, false)).toBe(false);
        expect(keepPolling({ runId: 'r1', status: 'awaiting_approval' }, false)).toBe(false);
        expect(keepPolling(null, false)).toBe(false);
        expect(keepPolling({ runId: 'r1', status: 'running' }, true)).toBe(false);
        expect(keepPolling(undefined, true)).toBe(false);
    });
});

describe('runView', () => {
    it('shows a direct answer as it came, without spinning', () => {
        const done: AppActionResult = { runId: 'r1', status: 'success', output: 'ok' };
        expect(runView(done, { data: undefined, failed: false })).toEqual({ shown: done, going: false });
        expect(runView(null, { data: undefined, failed: false })).toEqual({ shown: null, going: false });
    });

    it('spins on a 202 until the poll answers that the run finished or failed', () => {
        expect(runView(pending, { data: undefined, failed: false })).toEqual({ shown: pending, going: true });
        const still: AppActionResult = { runId: 'r1', status: 'running' };
        expect(runView(pending, { data: still, failed: false })).toEqual({ shown: still, going: true });
        const done: AppActionResult = { runId: 'r1', status: 'success', output: 42 };
        expect(runView(pending, { data: done, failed: false })).toEqual({ shown: done, going: false });
        const failed: AppActionResult = { runId: 'r1', status: 'error', error: 'Boom' };
        expect(runView(pending, { data: failed, failed: false })).toEqual({ shown: failed, going: false });
    });

    it('stops spinning when the poll itself fails, keeping the last answer', () => {
        const still: AppActionResult = { runId: 'r1', status: 'running' };
        expect(runView(pending, { data: still, failed: true })).toEqual({ shown: still, going: false });
        expect(runView(pending, { data: undefined, failed: true })).toEqual({ shown: pending, going: false });
    });
});

it('polls through the statuses the web runner polls through', () => {
    const src = fs.readFileSync(
        path.resolve(__dirname, '../../../../../agent-hub/src/components/admin/Studio/AppStudio/runtime/useActionRunner.js'),
        'utf8',
    );
    const list = /if \(status && !\[([^\]]+)\]\.includes\(status\)\) return body;/.exec(src)?.[1];
    expect(list?.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...GOING_STATUSES]);
});
