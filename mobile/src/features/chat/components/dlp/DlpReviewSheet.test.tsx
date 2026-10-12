/**
 * The DLP review: findings highlighted, a tapped word marked, and the marks
 * sent with a redaction; Back answers Block, and a question the server no
 * longer holds closes with a toast rather than a raw server sentence.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { ApiError } from '@/core/api/client';
import { postDlpDecisionTouch } from '@/features/chat/api/endpoints';
import { DlpQuestionExpired } from '@/features/chat/hooks/dlpResolver';
import type { DlpDecision } from '@/features/chat/model/types';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { DlpReviewSheet } from './DlpReviewSheet';

jest.mock('@/features/chat/api/endpoints', () => ({
    postDlpDecisionTouch: jest.fn().mockResolvedValue(undefined),
}));

const DECISION: DlpDecision = {
    decisionId: 'd1',
    summary: '1 email address',
    kind: 'chat_text',
    reviewText: 'Mail anna@example.nl about Jansen',
    findings: [{ id: 'f1', category: 'Email', source: 'pii', offset: 5, length: 15 }],
    provider: { displayName: 'Mistral', isExternal: true },
};

it('says where the prompt goes and what was found', async () => {
    await renderScreen(<DlpReviewSheet decision={DECISION} onChoose={jest.fn()} />);
    expect(screen.getByText('Check this before it goes to the AI')).toBeTruthy();
    expect(screen.getByText('Mistral')).toBeTruthy();
    expect(screen.getByText('1 detected')).toBeTruthy();
    expect(screen.getByText('anna@example.nl')).toBeTruthy();
});

it('sends a tapped word as a mark with the redaction', async () => {
    const onChoose = jest.fn().mockResolvedValue(undefined);
    await renderScreen(<DlpReviewSheet decision={DECISION} onChoose={onChoose} />);
    await fireEvent.press(screen.getByText('Jansen'));
    expect(screen.getByText('1 detected · 1 added by you')).toBeTruthy();
    await fireEvent.press(screen.getByText('Redact and send'));
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith('redact', false, [{ offset: 27, length: 6 }]));
});

it('keeps the review up with the reason when the server refuses', async () => {
    const onChoose = jest.fn().mockRejectedValue(new Error('This decision has expired.'));
    await renderScreen(<DlpReviewSheet decision={DECISION} onChoose={onChoose} />);
    await fireEvent.press(screen.getByText('Send anyway'));
    await waitFor(() => expect(screen.getByText('This decision has expired.')).toBeTruthy());
    expect(onChoose).toHaveBeenCalledWith('allow', false, []);
});

it('words a refusal the way every other request is worded', async () => {
    const onChoose = jest.fn().mockRejectedValue(new ApiError('HTTP 502', { status: 502 }));
    await renderScreen(<DlpReviewSheet decision={DECISION} onChoose={onChoose} />);
    await fireEvent.press(screen.getByText('Send anyway'));
    expect(await screen.findByText('This is not something you did. Try again in a moment.')).toBeTruthy();
    expect(screen.queryByText('HTTP 502')).toBeNull();
});

it('says an expired question expired, in a toast that outlives the review', async () => {
    const onChoose = jest.fn().mockRejectedValue(new DlpQuestionExpired());
    await renderScreen(<DlpReviewSheet decision={DECISION} onChoose={onChoose} />);
    await fireEvent.press(screen.getByText('Block'));
    expect(await screen.findByText(/This privacy check had already expired, so nothing was sent\./)).toBeTruthy();
});

it('heartbeats the question while the review is open, so it cannot expire mid-edit', async () => {
    await renderScreen(<DlpReviewSheet decision={DECISION} onChoose={jest.fn()} />);
    expect(postDlpDecisionTouch).toHaveBeenCalledWith('d1');
});

it("answers Android's Back with Block, as the web's cancel does", async () => {
    const onChoose = jest.fn().mockResolvedValue(undefined);
    await renderScreen(<DlpReviewSheet decision={DECISION} onChoose={onChoose} />);
    await fireEvent.press(screen.getByText('Jansen'));
    await fireEvent(screen.getByTestId('dlp-review'), 'requestClose');
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith('block', false, []));
});

it('ignores Back while an answer is on its way', async () => {
    const onChoose = jest.fn(() => new Promise<void>(() => {}));
    await renderScreen(<DlpReviewSheet decision={DECISION} onChoose={onChoose} />);
    await fireEvent.press(screen.getByText('Send anyway'));
    await fireEvent(screen.getByTestId('dlp-review'), 'requestClose');
    expect(onChoose).toHaveBeenCalledTimes(1);
});
