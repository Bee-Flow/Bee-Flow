// "To review" in a Cowork item: the runs whose agent asked its owner to decide, each with the reason, the question
// and the mail it was about; the owner answers (the agent continues) or closes it. The network is the seam
// (a recording fetch), no module is mocked.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkReviewQueue from './CoworkReviewQueue';
import type { CoworkRun } from '@/api/cowork.types';

const waiting = (over: Partial<CoworkRun> = {}): CoworkRun => ({
    id: 'r1', status: 'needs_review', startedAt: new Date().toISOString(), mailSubject: 'Offer Q3',
    review: { reason: 'The discount is not in the price list.', question: 'Which discount applies?', summary: 'I read the mail.', resolution: null, resolvedBy: null, resolvedAt: null },
    ...over,
});

let calls: RecordedCall[];

function serve(runs: CoworkRun[], postStatus = 200) {
    calls = stubRecordingFetch(({ method }) => (method === 'POST'
        ? (postStatus < 400 ? jsonResponse({ run: null, followUpRunId: 'f1' }) : jsonResponse({ error: 'This run is not waiting for a review.' }, postStatus))
        : jsonResponse({ runs, total: runs.length })));
}

const posts = () => calls.filter((c) => c.method === 'POST');

afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkReviewQueue', () => {
    it('shows a waiting run with its reason, question, summary and the mail it was about', async () => {
        serve([waiting(), waiting({ id: 'r2', status: 'success', review: null })]);
        renderWithClient(<CoworkReviewQueue coworkId="w1" reloadKey={0} />);
        const items = await screen.findAllByTestId('cowork-review-item');
        expect(items).toHaveLength(1);
        const item = within(items[0]);
        expect(item.getByText('The discount is not in the price list.')).toBeInTheDocument();
        expect(item.getByText('Which discount applies?')).toBeInTheDocument();
        expect(item.getByText('I read the mail.')).toBeInTheDocument();
        expect(item.getByText(/E-mail: Offer Q3/)).toBeInTheDocument();
    });

    it('says nothing when no run waits (a handled review is history, not a task)', async () => {
        const handled = waiting();
        handled.review = { ...handled.review!, resolution: 'not_needed' };
        serve([handled]);
        renderWithClient(<CoworkReviewQueue coworkId="w1" reloadKey={0} />);
        await waitFor(() => expect(calls.length).toBeGreaterThan(0));
        expect(screen.queryByTestId('cowork-review-queue')).toBeNull();
    });

    it('an answer needs text, then goes to the run and the page reads again', async () => {
        serve([waiting()]);
        const onReviewed = vi.fn();
        renderWithClient(<CoworkReviewQueue coworkId="w1" reloadKey={0} onReviewed={onReviewed} />);
        const send = await screen.findByRole('button', { name: 'Send and let the agent continue' });
        expect(send).toBeDisabled();
        const user = userEvent.setup();
        await user.type(screen.getByLabelText('Your answer or instruction'), 'Make the draft, 5% as agreed.');
        await user.click(send);
        await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1));
        expect(posts()).toHaveLength(1);
        expect(posts()[0].url).toMatch(/\/api\/cowork\/w1\/runs\/r1\/review$/);
        expect(posts()[0].body).toEqual({ action: 'answer', answer: 'Make the draft, 5% as agreed.' });
    });

    it('closing without a follow-up: "I did it myself" and "Not needed"', async () => {
        serve([waiting()]);
        renderWithClient(<CoworkReviewQueue coworkId="w1" reloadKey={0} />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'I did it myself' }));
        await user.click(screen.getByRole('button', { name: 'Not needed' }));
        await waitFor(() => expect(posts()).toHaveLength(2));
        expect(posts().map((p) => p.body)).toEqual([{ action: 'done_myself' }, { action: 'not_needed' }]);
    });

    it('a refusal is said in the card', async () => {
        serve([waiting()], 409);
        renderWithClient(<CoworkReviewQueue coworkId="w1" reloadKey={0} />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Not needed' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('This run is not waiting for a review.');
    });
});
