/**
 * Answering a DLP question: the question goes once the server has the
 * answer, stays for a refusal worth retrying, and goes as "expired" when the
 * server no longer knows it (its 404), instead of trapping the review.
 */

import { ApiError } from '@/core/api/client';
import type { DlpDecision } from '@/shared/stream';

import { DlpQuestionExpired, dlpResolverFor } from './dlpResolver';
import { postDlpDecision } from '../api/endpoints';

jest.mock('../api/endpoints', () => ({ postDlpDecision: jest.fn() }));

const QUESTION: DlpDecision = { decisionId: 'd1', summary: '1 email address', kind: 'chat_text', findings: [] };

function streamWith(question: DlpDecision | null) {
    const turn = { dlpDecision: question };
    return {
        turn,
        current: () => turn,
        update: (change: (t: typeof turn) => void) => change(turn),
    };
}

beforeEach(() => (postDlpDecision as jest.Mock).mockReset());

it('posts the answer, then takes the question down', async () => {
    (postDlpDecision as jest.Mock).mockResolvedValue(undefined);
    const stream = streamWith(QUESTION);
    await dlpResolverFor(stream)('redact', true, [{ offset: 1, length: 2 }]);
    expect(postDlpDecision).toHaveBeenCalledWith('d1', 'redact', true, [{ offset: 1, length: 2 }]);
    expect(stream.turn.dlpDecision).toBeNull();
});

it('takes an expired question down and says it expired, instead of the server’s sentence', async () => {
    (postDlpDecision as jest.Mock).mockRejectedValue(
        new ApiError('Decision not found, expired, or not owned by this user.', { status: 404 }),
    );
    const stream = streamWith(QUESTION);
    const answer = dlpResolverFor(stream)('allow');
    await expect(answer).rejects.toBeInstanceOf(DlpQuestionExpired);
    await expect(answer).rejects.toThrow('This privacy check had already expired, so nothing was sent.');
    expect(stream.turn.dlpDecision).toBeNull();
});

it('keeps the question up for a refusal that another try can get past', async () => {
    const offline = new ApiError('HTTP 503', { status: 503 });
    (postDlpDecision as jest.Mock).mockRejectedValue(offline);
    const stream = streamWith(QUESTION);
    await expect(dlpResolverFor(stream)('block')).rejects.toBe(offline);
    expect(stream.turn.dlpDecision).toBe(QUESTION);
});

it('leaves a newer question alone when an older answer comes back', async () => {
    const newer: DlpDecision = { ...QUESTION, decisionId: 'd2' };
    const stream = streamWith(QUESTION);
    (postDlpDecision as jest.Mock).mockImplementation(async () => {
        stream.turn.dlpDecision = newer;
    });
    await dlpResolverFor(stream)('allow');
    expect(stream.turn.dlpDecision).toBe(newer);
});

it('does nothing when there is no question', async () => {
    await dlpResolverFor(streamWith(null))('allow');
    expect(postDlpDecision).not.toHaveBeenCalled();
});
