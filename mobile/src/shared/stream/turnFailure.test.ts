/** A turn that failed outside the stream, in words — never the transport's or a bare status. */

import { ApiError, OfflineError } from '@/core/api/client';

import { describeTurnFailure } from './turnFailure';

describe('describeTurnFailure', () => {
    it('words a server fault as one, whatever the proxy or the body said', () => {
        const fault = 'This is not something you did. Try again in a moment.';
        expect(describeTurnFailure(new ApiError('HTTP 502', { status: 502 }))).toBe(fault);
        expect(describeTurnFailure(new ApiError('Internal server error', { status: 500 }))).toBe(fault);
    });

    it("keeps the server's own sentence for a refusal that has one", () => {
        const quota = new ApiError('Monthly message limit reached.', { status: 402, body: { error: 'Monthly message limit reached.' } });
        expect(describeTurnFailure(quota)).toBe('Monthly message limit reached.');
    });

    it('falls back to the heading when the refusal carried only a status', () => {
        expect(describeTurnFailure(new ApiError('HTTP 400', { status: 400 }))).toBe('That did not work');
        expect(describeTurnFailure(new ApiError('HTTP 402', { status: 402 }))).toBe(
            'Your organisation has used its allowance for this period.',
        );
    });

    it('says the device is offline when it is', () => {
        expect(describeTurnFailure(new OfflineError())).toBe(
            'Bee Flow will pick up where you left off once you are back on a network.',
        );
    });

    it('reads anything the transport threw as a lost connection', () => {
        const lost = 'The connection to the server was lost.';
        expect(describeTurnFailure(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))).toBe(lost);
        expect(describeTurnFailure(new Error('fetch failed: Connection reset'))).toBe(lost);
        expect(describeTurnFailure(undefined)).toBe(lost);
    });
});
