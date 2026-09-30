/**
 * The approval payloads, read through the allow-list, with the decision
 * verdicts read fail-closed.
 *
 * The ways a server answer goes wrong without an error — a field renamed
 * away, a count arriving as a string, a row with no id — each has to become a
 * stated default or the shape the screen expects, never `undefined` in a prop.
 */

import { api } from '@/core/api/client';

import { getApproval, listApprovals } from './endpoints';

jest.mock('@/core/api/client', () => ({
    api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const get = api.get as jest.Mock;

beforeEach(() => {
    get.mockReset();
});

describe('approvals', () => {
    it('unwraps the approvals and nulls a context that is not an object', async () => {
        get.mockResolvedValueOnce({
            approvals: [{ id: 'ap1', automationTitle: 'Refund', status: 'pending', context: 'x', createdAt: 'now' }],
        });
        const [approval] = await listApprovals();
        expect(approval).toMatchObject({ id: 'ap1', automationTitle: 'Refund', context: null, source: 'run' });
    });

    it('asks for my queue, my record, or the organisation’s', async () => {
        get.mockResolvedValue({ approvals: [] });
        await listApprovals('pending');
        await listApprovals('all');
        await listApprovals('org');
        expect(get.mock.calls.map(([, options]) => options.query)).toEqual([
            { scope: 'mine', status: 'pending' },
            { scope: 'mine' },
            { scope: 'org' },
        ]);
    });

    it('reads the decision verdicts fail-closed', async () => {
        get.mockResolvedValueOnce({ approval: { id: 'ap1', createdAt: 'now' }, canDecide: 'yes' });
        const detail = await getApproval('ap1');
        expect(detail?.approval.id).toBe('ap1');
        expect(detail?.canDecide).toBe(false);
        expect(detail?.canWithdraw).toBe(false);
    });
});
