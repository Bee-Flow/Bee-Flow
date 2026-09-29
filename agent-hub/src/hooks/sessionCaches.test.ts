import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

import { queryClient } from '../api/queryClient';
import { queryWrapper } from '../test/queryWrapper';
import { clearSessionCaches } from './sessionCaches';
import { useTrainingGates } from './useTrainingGates';
import { fetchAllowedModelsByAgentType } from '../utils/modelMeta';

// The app's own client: the invalidators act on that singleton.
const wrapper = queryWrapper(queryClient);

/**
 * Logout does not reload the page, so a module-level cache outlives it and the
 * next person to sign in on that browser reads it. These two were found after
 * the list in sessionCaches.ts was written; each case signs A in, logs out,
 * signs B in, and asks whether B sees B's answer — and never A's, not even for
 * the first paint.
 */

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    clearSessionCaches();
});

describe('clearSessionCaches', () => {
    it("drops A's training gates, with A's lesson progress, before B signs in", async () => {
        const gate = (courseTitle: string, lessonsDone: number) => ({
            areas: { agents: { enforced: true, satisfied: false, courseId: 'c1', courseTitle, lessonsDone, lessonsTotal: 7 } },
        });
        fetchMock.mockImplementation(async () => ok(gate('A-only course', 4)));
        const a = renderHook(() => useTrainingGates({ enabled: true }), { wrapper });
        await waitFor(() => expect(a.result.current.lockFor('agents')?.courseTitle).toBe('A-only course'));

        // Logout renders the login screen in the same context: A's tree goes,
        // the module scope and the query client stay.
        a.unmount();
        clearSessionCaches();

        fetchMock.mockImplementation(async () => ok(gate('B course', 1)));
        const b = renderHook(() => useTrainingGates({ enabled: true }), { wrapper });
        expect(b.result.current.lockFor('agents'), "B's first paint must not be A's lock").toBeNull();
        await waitFor(() => expect(b.result.current.lockFor('agents')).toMatchObject({ courseTitle: 'B course', lessonsDone: 1 }));
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("drops A's per-agent-type model allow-list before B signs in", async () => {
        fetchMock.mockImplementation(async () => ok({ allowedModelsByAgentType: { chat: ['a-org-model'] } }));
        expect(await fetchAllowedModelsByAgentType()).toEqual({ chat: ['a-org-model'] });

        clearSessionCaches();

        fetchMock.mockImplementation(async () => ok({ allowedModelsByAgentType: { chat: ['b-org-model'] } }));
        expect(await fetchAllowedModelsByAgentType()).toEqual({ chat: ['b-org-model'] });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('still remembers within one session: the caches are per session, not per call', async () => {
        fetchMock.mockImplementation(async () => ok({ allowedModelsByAgentType: { chat: ['m'] } }));
        await fetchAllowedModelsByAgentType();
        await fetchAllowedModelsByAgentType();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
