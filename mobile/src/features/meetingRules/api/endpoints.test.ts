import { api } from '@/core/api/client';

import { createMeetingRule, getRunFacets, listMeetingRules } from './endpoints';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { get: jest.fn(), post: jest.fn() } };
});

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('the rules calls', () => {
    it('lists the reader’s meeting-notes routines, dropping id-less rows', async () => {
        get.mockResolvedValue({ automations: [{ id: 'r1', title: 'A', isActive: 1, definition: 'x' }, { title: 'no id' }] });
        const rules = await listMeetingRules();
        expect(rules).toEqual([{ id: 'r1', title: 'A', userId: null, isActive: null, isDraft: null, definition: {} }]);
    });

    it('asks for live runs over a day and takes the window the server counted', async () => {
        get.mockResolvedValue({ facets: { automationId: {} }, rangeHours: 12 });
        expect(await getRunFacets()).toEqual({ facets: { automationId: {} }, hours: 12 });
        expect(get).toHaveBeenCalledWith('/api/automation/_runs/facets', {
            signal: undefined,
            query: { range: 24, mode: 'live' },
        });
        get.mockResolvedValue({});
        expect(await getRunFacets()).toEqual({ facets: null, hours: 24 });
    });

    it('creates a draft and reads its id in either shape', async () => {
        post.mockResolvedValueOnce({ automation: { id: 'a1' } });
        expect(await createMeetingRule('T', 'D')).toBe('a1');
        post.mockResolvedValueOnce({ id: 'a2' });
        expect(await createMeetingRule('T', 'D')).toBe('a2');
        post.mockResolvedValueOnce({});
        expect(await createMeetingRule('T', 'D')).toBeNull();
        expect(post.mock.calls[0][2]).toEqual({ retry: false });
    });
});
