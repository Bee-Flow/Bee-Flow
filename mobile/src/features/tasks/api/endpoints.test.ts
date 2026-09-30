/**
 * The task and reminder payloads, read through the allow-list, and the
 * Cowork twins the task list leaves out.
 *
 * The ways a server answer goes wrong without an error — a field renamed
 * away, a count arriving as a string, a row with no id — each has to become a
 * stated default or the shape the screen expects, never `undefined` in a prop.
 */

import { api } from '@/core/api/client';

import { listReminders, listTasks, toggleTask } from './endpoints';

jest.mock('@/core/api/client', () => ({
    api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

beforeEach(() => {
    get.mockReset();
    post.mockReset();
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

    describe('the copies left behind by the move to Cowork', () => {
        // server/migrations/prompt-tasks-to-cowork-2026-08: every plain task
        // was copied into cowork_schedules under the SAME id, and the original
        // left here, paused.
        const TASKS = {
            tasks: [
                { id: 'moved', title: 'Digest', agentId: null, isActive: false },
                { id: 'routine', title: 'Agent routine', agentId: 'agent1', isActive: true },
                { id: 'made-since', title: 'Made on the phone', agentId: null, isActive: true },
                { id: 'paused-since', title: 'Paused on the phone', agentId: null, isActive: false },
            ],
        };

        function serve(cowork: () => unknown) {
            get.mockImplementation((path: string) =>
                path === '/api/cowork' ? cowork() : Promise.resolve(TASKS),
            );
        }

        afterEach(() => get.mockReset());

        it('drops a plain task whose twin now lives in Cowork, and keeps everything else', async () => {
            serve(() => Promise.resolve([{ id: 'moved', title: 'Digest' }, { id: 'other', title: 'x' }]));
            const { tasks } = await listTasks();
            // Not the web's `agentId`-only filter: the phone still creates
            // plain tasks, and one made after the migration has no twin.
            expect(tasks.map((t) => t.id)).toEqual(['routine', 'made-since', 'paused-since']);
        });

        it('keeps a twin that was switched back on, so it can be paused again', async () => {
            // An active rollback copy runs next to its Cowork twin; hiding it
            // would leave the duplicate running with nothing on the phone to stop it.
            get.mockImplementation((path: string) =>
                path === '/api/cowork'
                    ? Promise.resolve([{ id: 'moved', title: 'Digest' }])
                    : Promise.resolve({ tasks: [{ id: 'moved', title: 'Digest', agentId: null, isActive: true }] }),
            );
            expect((await listTasks()).tasks.map((t) => t.id)).toEqual(['moved']);
        });

        it('never drops an agent routine, even one sharing an id with a schedule', async () => {
            serve(() => Promise.resolve({ schedules: [{ id: 'routine' }] }));
            expect((await listTasks()).tasks.map((t) => t.id)).toContain('routine');
        });

        it('drops nothing when Cowork cannot be read', async () => {
            // A licence can withhold Cowork; the task list must still load.
            serve(() => Promise.reject(new Error('403')));
            expect((await listTasks()).tasks).toHaveLength(4);
        });
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
