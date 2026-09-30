/**
 * The automation and run payloads, read through the allow-list.
 *
 * The ways a server answer goes wrong without an error — a field renamed
 * away, a count arriving as a string, a row with no id — each has to become a
 * stated default or the shape the screen expects, never `undefined` in a prop.
 *
 * And the three legitimately different bodies one run request can answer.
 */

import { api } from '@/core/api/client';

import {
    getAutomation,
    getAutomationCounts,
    getRunSteps,
    listAutomations,
    listRuns,
    previewSchedule,
    runAutomation,
} from './endpoints';

jest.mock('@/core/api/client', () => ({
    api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

const AUTOMATION = {
    id: 'auto1',
    userId: 'u1',
    projectId: null,
    folderId: null,
    kind: 'automation',
    title: 'Weekly digest',
    description: 'Every Monday',
    definition: { trigger: { kind: 'schedule', schedule: { cron: '0 9 * * 1', tz: 'Europe/Amsterdam' } }, steps: [] },
    version: 4,
    isActive: true,
    isDraft: false,
    needsFirstRunConfirm: false,
    triggerType: 'schedule',
    scheduleCron: '0 9 * * 1',
    scheduleTz: 'Europe/Amsterdam',
    nextRunAt: '2026-09-28T07:00:00Z',
    lastRunAt: null,
    lastStatus: null,
    runningInstanceId: null,
    runningStartedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
};

const RUN = {
    id: 'run1',
    automationId: 'auto1',
    version: 4,
    userId: 'u1',
    triggerKind: 'manual',
    triggerPayload: { message: { subject: 'hello' } },
    mode: 'live',
    status: 'awaiting_form',
    startedAt: '2026-09-21T10:00:00Z',
    finishedAt: null,
    durationMs: '1250',
    error: null,
    summary: null,
    parentRunId: null,
    rootRunId: 'run1',
    cancelRequested: false,
    awaitingStepId: 'form-1',
    awaitingStepExpiresAt: null,
    errorClass: null,
    handledErrorCount: 0,
};

beforeEach(() => {
    get.mockReset();
    post.mockReset();
});

describe('automations', () => {
    it('unwraps the list, leaves out Steps and id-less rows, and defaults the rest', async () => {
        get.mockResolvedValueOnce({
            automations: [
                AUTOMATION,
                { ...AUTOMATION, id: 'block1', kind: 'block' },
                { ...AUTOMATION, id: 'bare', title: undefined, definition: 'oops', version: '2' },
                { title: 'no id' },
            ],
        });
        const rows = await listAutomations();
        expect(rows.map((a) => a.id)).toEqual(['auto1', 'bare']);
        expect(rows[1]).toMatchObject({ title: 'Untitled automation', definition: {}, version: 2 });
        expect(rows[0]?.definition).toEqual(AUTOMATION.definition);
    });

    it('reads nothing from a bare array, which this route never answers', async () => {
        get.mockResolvedValueOnce([AUTOMATION]);
        expect(await listAutomations()).toEqual([]);
    });

    it('answers the automation with its summary, or null without one', async () => {
        get.mockResolvedValueOnce({ automation: AUTOMATION, summary: 'Runs weekly' });
        expect(await getAutomation('auto1')).toMatchObject({
            automation: { id: 'auto1', scheduleTz: 'Europe/Amsterdam' },
            summary: 'Runs weekly',
        });
        get.mockResolvedValueOnce({ summary: 'no automation' });
        expect(await getAutomation('auto1')).toBeNull();
    });
});

describe('the live split (handoff 5)', () => {
    it('reads the live columns, keeping absent apart from null', async () => {
        get.mockResolvedValueOnce({ automation: { ...AUTOMATION, liveVersion: 3, liveAt: '2026-09-20T10:00:00Z', neverLive: false, pendingChanges: '2' } });
        expect((await getAutomation('auto1'))?.automation).toMatchObject({ liveVersion: 3, liveAt: '2026-09-20T10:00:00Z', neverLive: false, pendingChanges: 2 });
        get.mockResolvedValueOnce({ automation: { ...AUTOMATION, liveVersion: null, liveAt: null, neverLive: true, pendingChanges: 0 } });
        expect((await getAutomation('auto1'))?.automation).toMatchObject({ liveVersion: null, liveAt: null, neverLive: true, pendingChanges: 0 });
        // A server from before the split, and a save's answer, which leaves the count out.
        get.mockResolvedValueOnce({ automation: AUTOMATION });
        const old = (await getAutomation('auto1'))?.automation;
        expect(old?.liveVersion).toBeUndefined();
        expect(old?.neverLive).toBeUndefined();
        expect(old?.pendingChanges).toBeUndefined();
    });

    it('reads the pending count off GET /:id/counts, null when there is none', async () => {
        get.mockResolvedValueOnce({ runs7d: 4, runsFailed7d: 0, versions: 7, pendingChanges: 2 });
        expect(await getAutomationCounts('a 1')).toEqual({ pendingChanges: 2 });
        expect(get).toHaveBeenLastCalledWith('/api/automation/a%201/counts', { signal: undefined });
        get.mockResolvedValueOnce({ error: 'Forbidden' });
        expect(await getAutomationCounts('a1')).toEqual({ pendingChanges: null });
    });
});

describe('runs', () => {
    it('keeps the payload untouched, reads a numeric string, and keeps an unknown status', async () => {
        get.mockResolvedValueOnce({ runs: [{ ...RUN, status: 'paused_breakpoint' }] });
        const [run] = await listRuns('auto1');
        expect(run).toMatchObject({
            triggerPayload: { message: { subject: 'hello' } },
            durationMs: 1250,
            status: 'paused_breakpoint',
            cancelRequested: false,
        });
        expect(run?.journeyRunId).toBeUndefined();
    });

    it('answers the three bodies of a run request', async () => {
        post.mockResolvedValueOnce({ accepted: true, run: RUN, steps: [{ runId: 'run1', stepId: 's1', status: 'success' }] });
        const finished = await runAutomation('auto1');
        expect(finished?.run?.id).toBe('run1');
        expect(finished?.steps?.[0]).toMatchObject({ stepId: 's1', status: 'success', attempts: null });

        post.mockResolvedValueOnce({ accepted: true, pending: true });
        const pending = await runAutomation('auto1');
        expect(pending).toMatchObject({ accepted: true, pending: true });
        expect(pending?.run).toBeUndefined();

        post.mockResolvedValueOnce({ accepted: true, skipped: true, message: 'nothing to test' });
        expect(await runAutomation('auto1')).toMatchObject({ skipped: true, message: 'nothing to test' });
        expect(post).toHaveBeenLastCalledWith('/api/automation/auto1/run', {}, expect.anything());
    });

    it('enters through the trigger it is told to, with that trigger’s sample', async () => {
        post.mockResolvedValueOnce({ accepted: true, pending: true });
        await runAutomation('auto1', { triggerStepId: 'trg_2', triggerPayload: { subject: 'Hi' } });
        expect(post).toHaveBeenLastCalledWith('/api/automation/auto1/run', { triggerPayload: { subject: 'Hi' }, triggerStepId: 'trg_2' }, expect.anything());
    });

    it('reads the steps with the definition as it was, or null when there is none', async () => {
        get.mockResolvedValueOnce({ steps: [{ runId: 'run1', stepId: 's1', input: [1, 2], output: 'x' }], definition: 'gone', version: '3' });
        const result = await getRunSteps('run1');
        expect(result.steps[0]).toMatchObject({ stepId: 's1', input: [1, 2], output: 'x', status: 'queued' });
        expect(result.definition).toBeNull();
        expect(result.version).toBe(3);
    });

    it('reads both shapes of a schedule preview', async () => {
        post.mockResolvedValueOnce({ valid: true, cron: '0 9 * * 1', tz: 'UTC', next: ['2026-09-28T09:00:00Z', 7] });
        expect(await previewSchedule('0 9 * * 1', 'UTC')).toEqual({
            valid: true,
            cron: '0 9 * * 1',
            tz: 'UTC',
            next: ['2026-09-28T09:00:00Z'],
        });
        post.mockResolvedValueOnce({ valid: false, error: 'bad cron' });
        expect(await previewSchedule('nope', 'UTC')).toEqual({ valid: false, error: 'bad cron' });
    });
});
