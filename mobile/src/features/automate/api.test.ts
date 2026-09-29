/**
 * The Automate payloads, read through the allow-list.
 *
 * Every endpoint hands the reader whatever `res.json()` produced. The cases
 * here are the ways a server answer goes wrong without an error — a field
 * renamed away, a count arriving as a string, a section that is null on
 * purpose, a row with no id — and the three legitimately different bodies
 * one route can answer. Each has to become a stated default or the shape the
 * screen expects, never `undefined` in a prop.
 */

import {
    getAppRuntime,
    getApproval,
    getAutomation,
    getProject,
    getProjectResources,
    getRunSteps,
    listApprovals,
    listAutomations,
    listDirectory,
    listProjects,
    listReminders,
    listRuns,
    listTasks,
    previewSchedule,
    readablePlanRefusal,
    runAutomation,
    setAutomationActive,
    toggleTask,
} from './api';
import { api } from '../../api/client';

jest.mock('../../api/client', () => ({
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

describe('tasks and reminders', () => {
    it('reads the task list with its cap, defaulting the cap and an unknown interval', async () => {
        get.mockResolvedValueOnce({
            tasks: [{ id: 't1', userId: 'u1', title: 'Digest', prompt: 'p', repeatInterval: 'fortnightly', isActive: true }],
            maxTasks: '7',
        });
        const list = await listTasks();
        expect(list.maxTasks).toBe(7);
        expect(list.tasks[0]).toMatchObject({ id: 't1', repeatInterval: null, runCount: null, daysOfWeek: null });

        get.mockResolvedValueOnce({ tasks: 'none' });
        expect(await listTasks()).toEqual({ tasks: [], maxTasks: 10 });
    });

    it('reads the toggle answer, or null when the server did not say', async () => {
        post.mockResolvedValueOnce({ success: true, isActive: false });
        expect(await toggleTask('t1')).toBe(false);
        post.mockResolvedValueOnce({ success: true });
        expect(await toggleTask('t1')).toBeNull();
    });

    it('reads the bare reminder array', async () => {
        get.mockResolvedValueOnce([{ id: 'r1', userId: 'u1', title: 'Call back', remindAt: '2026-09-22T08:00:00Z' }, { id: 7 }]);
        const reminders = await listReminders();
        expect(reminders).toHaveLength(1);
        expect(reminders[0]).toMatchObject({ id: 'r1', title: 'Call back', isCompleted: false, message: null });
    });
});

describe('projects', () => {
    it('keeps a known permission and drops an unknown one', async () => {
        get.mockResolvedValueOnce([
            { id: 'p1', name: 'Sales', ownerId: 'u1', version: 1, permission: 'owner', knowledgeBaseIds: ['kb1', 3] },
            { id: 'p2', name: 'Ops', ownerId: 'u2', version: 1, permission: 'admin' },
        ]);
        const projects = await listProjects();
        expect(projects[0]).toMatchObject({ permission: 'owner', knowledgeBaseIds: ['kb1'] });
        expect(projects[1]?.permission).toBeUndefined();
    });

    it('reads the detail with its shares, defaulting an unknown role to viewer', async () => {
        get.mockResolvedValueOnce({
            id: 'p1',
            name: 'Sales',
            ownerId: 'u1',
            role: 'superuser',
            shares: [{ id: 's1', projectId: 'p1', sharedWithType: 'group', sharedWithId: 'g1', permission: 'editor' }],
        });
        const detail = await getProject('p1');
        expect(detail?.role).toBe('viewer');
        expect(detail?.shares).toEqual([
            { id: 's1', projectId: 'p1', sharedWithType: 'group', sharedWithId: 'g1', permission: 'editor', createdAt: null },
        ]);
    });

    it('tells a null section from an empty one', async () => {
        get.mockResolvedValueOnce({
            role: 'editor',
            notebooks: null,
            automations: [AUTOMATION],
            apps: [],
            webpages: 'unavailable',
            approvals: [{ id: 'ap1' }],
        });
        const resources = await getProjectResources('p1');
        expect(resources?.notebooks).toBeNull();
        expect(resources?.automations?.[0]?.id).toBe('auto1');
        expect(resources?.apps).toEqual([]);
        expect(resources?.webpages).toBeNull();
        expect(resources?.approvals).toEqual([{ id: 'ap1' }]);
    });
});

describe('apps and approvals', () => {
    it('passes the app definition and viewer through and defaults the rest', async () => {
        get.mockResolvedValueOnce({
            id: 'app1',
            name: 'Intake',
            definition: { screens: [{ id: 'home' }], actions: {} },
            viewer: { id: 'u1', isOwner: true },
            appVersion: null,
        });
        const runtime = await getAppRuntime('app1');
        expect(runtime).toMatchObject({
            id: 'app1',
            name: 'Intake',
            icon: null,
            definition: { screens: [{ id: 'home' }], actions: {} },
            viewer: { id: 'u1', isOwner: true },
            appVersion: null,
        });
        expect(runtime?.draft).toBeUndefined();
    });

    it('unwraps the approvals and nulls a context that is not an object', async () => {
        get.mockResolvedValueOnce({
            approvals: [{ id: 'ap1', automationTitle: 'Refund', status: 'pending', context: 'x', createdAt: 'now' }],
        });
        const [approval] = await listApprovals();
        expect(approval).toMatchObject({ id: 'ap1', automationTitle: 'Refund', context: null, source: 'run' });
    });

    it('reads the decision verdicts fail-closed', async () => {
        get.mockResolvedValueOnce({ approval: { id: 'ap1', createdAt: 'now' }, canDecide: 'yes' });
        const detail = await getApproval('ap1');
        expect(detail?.approval.id).toBe('ap1');
        expect(detail?.canDecide).toBe(false);
        expect(detail?.canWithdraw).toBe(false);
    });
});

describe('listDirectory', () => {
    it('answers empty lists when the caller may not see the directory', async () => {
        get.mockRejectedValueOnce(new Error('403')).mockRejectedValueOnce(new Error('403'));
        expect(await listDirectory()).toEqual({ users: [], groups: [] });
    });

    it('reads what an admin gets back', async () => {
        get.mockResolvedValueOnce([{ id: 'u1', displayName: 'Ada', email: 'ada@example.com' }, { displayName: 'no id' }])
            .mockResolvedValueOnce([{ id: 'g1', name: 'Finance' }]);
        expect(await listDirectory()).toEqual({
            users: [{ id: 'u1', username: undefined, displayName: 'Ada', email: 'ada@example.com' }],
            groups: [{ id: 'g1', name: 'Finance' }],
        });
    });
});

describe('plan refusals', () => {
    /** What src/api/client.ts throws for a 403: `error` as the message, the body beside it. */
    const refusal = (body: Record<string, unknown>) =>
        Object.assign(new Error(String(body.error)), { status: 403, body });
    const STEP = 'Step "Scan it" is a Privacy Shield step, and Privacy Shield steps in routines are part of the Enterprise plan.';
    const DETAILS = [{ code: 'licence.privacy_steps', message: STEP, hint: 'Remove the step, or upgrade to Enterprise.' }];

    it('an activation the plan refuses keeps the server\'s sentence and its details', async () => {
        const err0 = refusal({ error: "This routine cannot go live on your organisation's plan.", code: 'feature_locked', feature: 'automation_privacy_steps', details: DETAILS });
        post.mockRejectedValueOnce(err0);
        const err = await setAutomationActive('auto1', true).catch((e: unknown) => e) as Error & { status?: number; body?: { details?: unknown[] } };
        expect(err).toBe(err0);
        expect(err.message).toBe("This routine cannot go live on your organisation's plan.");
        expect(err.body?.details).toHaveLength(1);
    });

    it('a bare licence code becomes a sentence, never "feature_locked"', async () => {
        post.mockRejectedValueOnce(refusal({ error: 'feature_locked', feature: 'automations', required: 'enterprise' }));
        const err = await setAutomationActive('auto1', true).catch((e: unknown) => e) as Error & { status?: number };
        expect(err.message).not.toMatch(/feature_/);
        expect(err.message.length).toBeGreaterThan(20);
        expect(err.status).toBe(403);
        const disabled = readablePlanRefusal(refusal({ error: 'feature_disabled', feature: 'approvals' })) as Error;
        expect(disabled.message).not.toMatch(/feature_/);
    });

    it('a run refused with a bare code folds the step sentences in', async () => {
        post.mockRejectedValueOnce(refusal({ error: 'feature_locked', details: DETAILS }));
        const err = await runAutomation('auto1').catch((e: unknown) => e) as Error;
        expect(err.message).toContain('"Scan it" is a Privacy Shield step');
        expect(err.message).not.toMatch(/feature_/);
    });

    it('every other failure passes through untouched', async () => {
        const other = Object.assign(new Error('Invalid definition'), { status: 400, body: { error: 'Invalid definition' } });
        post.mockRejectedValueOnce(other);
        await expect(setAutomationActive('auto1', true)).rejects.toBe(other);
        expect(other.message).toBe('Invalid definition');
        const notMine = Object.assign(new Error('nope'), { status: 403, body: { error: 'Forbidden' } });
        expect(readablePlanRefusal(notMine)).toBe(notMine);
        expect(notMine.message).toBe('nope');
    });
});
