/** How a failed agent turn reads: revoked access as its own outcome, everything else as on any stream. */

import { ApiError } from '@/core/api/client';
import { emptyAgentTurn } from '@/shared/stream';

import { agentFailure } from './useAgentChatStream';

// Pulled in through the chat feature's index; ESM jest cannot load.
jest.mock('@/shared/markdown/Markdown', () => ({ Markdown: () => null }));

function failWith(err: unknown) {
    const turn = emptyAgentTurn();
    agentFailure(turn, err);
    return turn;
}

it('marks revoked access rather than showing an error', () => {
    expect(failWith(new ApiError('Forbidden', { status: 403 }))).toMatchObject({ accessDenied: true, error: null });
});

it('words a server fault and a dropped socket the way every stream does', () => {
    expect(failWith(new ApiError('HTTP 502', { status: 502 })).error).toBe('This is not something you did. Try again in a moment.');
    expect(failWith(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })).error).toBe(
        'The connection to the server was lost.',
    );
});
