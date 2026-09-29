/**
 * Rating an answer.
 *
 * The two assertions that matter here are about what is NOT in the payload.
 * `conversationSnapshot` is the verbatim text of a conversation, stored
 * unencrypted in `message_feedback`; the web client offers to attach it and
 * this one must never send it. The rest of the file pins the optimistic
 * behaviour, because a thumbs-up that silently fails to reach the server is
 * indistinguishable, from the user's side, from one that worked.
 */

import { _resetRatings, rateMessage } from './feedback';
import { setServerUrl } from '../../api/server';

const mockExpoFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockExpoFetch(...args) }));

const TARGET = { conversationId: 'conv-1', messageId: 'msg-7', source: 'direct' as const };

function okOnce() {
    mockExpoFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true, id: 'conv-1_msg-7_u' }),
    });
}

function lastBody(): Record<string, unknown> {
    const call = mockExpoFetch.mock.calls.at(-1) as [string, { body: string }];
    return JSON.parse(call[1].body) as Record<string, unknown>;
}

beforeEach(async () => {
    mockExpoFetch.mockReset();
    _resetRatings();
    await setServerUrl('https://example.test');
});

describe('rateMessage', () => {
    it('never sends the conversation', async () => {
        okOnce();
        await rateMessage(TARGET, 'down');
        const body = lastBody();
        expect(body).not.toHaveProperty('conversationSnapshot');
        expect(Object.keys(body)).toEqual(
            expect.not.arrayContaining(['conversationSnapshot', 'comment', 'history']),
        );
    });

    it('sends the identifiers the dashboard groups on', async () => {
        okOnce();
        await rateMessage(
            { ...TARGET, agentId: 'agent-3', agentName: 'Inkoop', source: 'agent' },
            'up',
        );
        expect(lastBody()).toMatchObject({
            conversationId: 'conv-1',
            messageId: 'msg-7',
            agentId: 'agent-3',
            agentName: 'Inkoop',
            rating: 'up',
            source: 'agent',
        });
    });

    it('does not re-post the rating already recorded', async () => {
        okOnce();
        await rateMessage(TARGET, 'up');
        await rateMessage(TARGET, 'up');
        expect(mockExpoFetch).toHaveBeenCalledTimes(1);
    });

    it('does post when the rating changes, because the server upserts', async () => {
        okOnce();
        await rateMessage(TARGET, 'up');
        okOnce();
        await rateMessage(TARGET, 'down');
        expect(mockExpoFetch).toHaveBeenCalledTimes(2);
        expect(lastBody()).toMatchObject({ rating: 'down' });
    });

    it('throws when the post fails, so the caller can undo the optimistic fill', async () => {
        mockExpoFetch.mockResolvedValue({
            ok: false,
            status: 403,
            headers: { get: () => 'application/json' },
            json: async () => ({ error: 'nope' }),
        });
        await expect(rateMessage(TARGET, 'up')).rejects.toThrow();

        // And the rating did not stick — a second attempt must be allowed to
        // reach the network rather than be swallowed as "already rated".
        mockExpoFetch.mockReset();
        okOnce();
        await rateMessage(TARGET, 'up');
        expect(mockExpoFetch).toHaveBeenCalledTimes(1);
    });
});
