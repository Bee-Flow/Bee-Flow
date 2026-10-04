/**
 * The task and reminder payloads, read through the allow-list. Tasks are
 * Cowork schedules.
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
    it('reads the task list from Cowork with its cap, defaulting the cap and an unknown interval', async () => {
        get.mockResolvedValueOnce({
            schedules: [{ id: 't1', userId: 'u1', title: 'Digest', prompt: 'p', repeatInterval: 'fortnightly', isActive: true }],
            maxSchedules: '7',
        });
        const list = await listTasks();
        expect(get).toHaveBeenCalledWith('/api/cowork', expect.anything());
        expect(list.maxTasks).toBe(7);
        expect(list.tasks[0]).toMatchObject({ id: 't1', repeatInterval: null, runCount: null, daysOfWeek: null });

        get.mockResolvedValueOnce({ schedules: 'none' });
        expect(await listTasks()).toEqual({ tasks: [], maxTasks: 10 });
    });

    it('lists an item that runs as an agent like any other: the scheduled agent runs moved into Cowork', async () => {
        get.mockResolvedValueOnce({
            schedules: [
                { id: 'plain', title: 'Digest', agentId: null, isActive: true },
                { id: 'as-agent', title: 'Weekly report', agentId: 'agent1', isActive: false },
            ],
        });
        expect((await listTasks()).tasks.map((t) => t.id)).toEqual(['plain', 'as-agent']);
    });

    it('reads the toggle answer, or null when the server did not say', async () => {
        post.mockResolvedValueOnce({ success: true, isActive: false });
        expect(await toggleTask('t1')).toBe(false);
        expect(post).toHaveBeenCalledWith('/api/cowork/t1/toggle', {}, { retry: false });
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
