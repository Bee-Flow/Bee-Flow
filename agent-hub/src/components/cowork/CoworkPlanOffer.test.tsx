// Cheaper with age on the Plan tab: a quiet line with the proof behind it, and after approval "Made fixed on … · Undo".
// Nothing shows without an offer. The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkPlanOffer from './CoworkPlanOffer';
import type { CoworkProposal } from '@/api/coworkProposals';

const t = (_k: string | undefined, en?: unknown, vars: Record<string, unknown> = {}) => String(en ?? '').replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ''));
const OFFER: CoworkProposal = {
    id: 'pr-9', kind: 'fixed_step', reasonCode: 'stable_ai_step', stepId: 'sum', stepTitle: 'Count the late orders', status: 'open',
    fingerprint: 'e'.repeat(64), createdAt: '2026-11-24T08:00:00.000Z', decidedAt: null,
    changes: [{ id: 'sum', title: 'Count the late orders', kind: 'fixed', change: 'changed' }], widens: [],
    replay: { done: true, total: 20, same: 20, differs: 0, partial: 0, notReplayable: 0 }, undoVersion: null,
};

let calls: RecordedCall[];
const serve = (proposals: CoworkProposal[]) => { calls = stubRecordingFetch(({ method }) => jsonResponse(method === 'GET' ? { proposals } : { proposals: [] })); };
afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkPlanOffer', () => {
    it('one quiet line, the proof behind it, and Make it a fixed step sends the fingerprint', async () => {
        serve([OFFER]);
        renderWithClient(<CoworkPlanOffer coworkId="w1" t={t as never} />);
        expect(await screen.findByTestId('cowork-plan-offer')).toHaveTextContent('One step can run without AI: the same in 20 of 20. See the proof');
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'See the proof' }));
        expect(screen.getByText("'Count the late orders' becomes a fixed step. It hands on what the AI handed on, without asking a model.")).toBeInTheDocument();
        expect(screen.getByTestId('cowork-proposal-replay')).toHaveTextContent('Replayed on 20 past runs: 20 the same, 0 different.');
        expect(screen.getByText('Nothing it could not do before.')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Make it a fixed step' }));
        await waitFor(() => expect(calls.find((c) => c.url.endsWith('/proposals/pr-9/approve'))?.body).toEqual({ fingerprint: OFFER.fingerprint }));
    });

    it('after approval: made fixed on its day, and Undo restores the version before', async () => {
        serve([{ ...OFFER, status: 'approved', decidedAt: '2026-12-03T09:00:00.000Z', undoVersion: 4 }]);
        renderWithClient(<CoworkPlanOffer coworkId="w1" t={t as never} />);
        expect(await screen.findByTestId('cowork-plan-made-fixed')).toHaveTextContent('Made fixed on 3 Dec 2026 · Undo');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Undo' }));
        await waitFor(() => expect(calls.find((c) => c.url.endsWith('/api/cowork/w1/plan/restore'))?.body).toEqual({ version: 4 }));
    });

    it('says nothing without an offer, and nothing for one that was put aside', async () => {
        serve([{ ...OFFER, status: 'dismissed' }, { ...OFFER, id: 'pr-8', kind: 'repair' }]);
        const { container } = renderWithClient(<CoworkPlanOffer coworkId="w1" t={t as never} />);
        await waitFor(() => expect(calls.length).toBeGreaterThan(0));
        expect(container).toBeEmptyDOMElement();
    });
});
