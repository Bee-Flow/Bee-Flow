/** The "Describe it" call: what it sends, how it asks, and what it hands back. */

import { api, ApiError } from '@/core/api/client';

import { routeDescription } from './endpoints';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const post = api.post as jest.Mock;

beforeEach(() => post.mockReset());

describe('routeDescription', () => {
    it('sends the text and nothing else, never retried, with the caller\'s signal', async () => {
        post.mockResolvedValue({ kind: 'automation', name: 'Invoices', seed: 'Chase unpaid invoices', companions: [], available: ['automation'], undecided: [] });
        const signal = new AbortController().signal;
        const answer = await routeDescription('chase unpaid invoices', signal);
        expect(post).toHaveBeenCalledWith(
            '/api/studio/ai/route',
            { text: 'chase unpaid invoices' },
            expect.objectContaining({ signal, retry: false }),
        );
        expect(answer).toMatchObject({ kind: 'automation', name: 'Invoices', seed: 'Chase unpaid invoices' });
    });

    it('hands back null for a body that is not an answer', async () => {
        post.mockResolvedValue(null);
        await expect(routeDescription('x')).resolves.toBeNull();
    });

    it('lets a refusal through as the ApiError it is', async () => {
        post.mockRejectedValue(new ApiError('Too many', { status: 429 }));
        await expect(routeDescription('x')).rejects.toMatchObject({ status: 429 });
    });
});
