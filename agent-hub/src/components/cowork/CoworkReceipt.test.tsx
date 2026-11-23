// Run receipts on screen: a quiet line in an opened run, nothing while a run has none yet, and under Settings whether
// the chain holds, with what is wrong when it does not. The network is the seam (a recording fetch), no module is mocked.
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch } from '@/test/recordingFetch';
import { ReceiptChain, RunReceiptLine } from './CoworkReceipt';

afterEach(() => { vi.unstubAllGlobals(); });

const chain = (verdict: object, missingRuns = 0) => ({ verdict: { ok: true, count: 3, problem: null, unsigned: 0, ...verdict }, missingRuns, keyId: 'k1', receipts: [] });

describe('RunReceiptLine', () => {
    it('shows the receipt of a finished run, signed or not', async () => {
        stubRecordingFetch(() => jsonResponse({ seq: 41, runId: 'r1', at: null, status: 'success', kind: 'plan', signed: true, payload: {} }));
        renderWithClient(<RunReceiptLine coworkId="w1" runId="r1" finished />);
        expect(await screen.findByTestId('cowork-run-receipt')).toHaveTextContent('Receipt 41 · signed');
    });

    it('asks nothing for a run that is still going, and shows nothing for a run without a receipt yet', async () => {
        const calls = stubRecordingFetch(() => jsonResponse({ error: 'This run has no receipt yet.' }, 404));
        const { unmount } = renderWithClient(<RunReceiptLine coworkId="w1" runId="r1" finished={false} />);
        expect(calls).toHaveLength(0);
        unmount();
        renderWithClient(<RunReceiptLine coworkId="w1" runId="r2" finished />);
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        expect(screen.queryByTestId('cowork-run-receipt')).toBeNull();
    });
});

describe('ReceiptChain', () => {
    it('says the chain holds, and offers it as a download', async () => {
        stubRecordingFetch(() => jsonResponse(chain({})));
        renderWithClient(<ReceiptChain coworkId="w1" />);
        expect(await screen.findByText('Every run has a receipt, and the chain of 3 holds.')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Download the receipts' })).toHaveAttribute('href', expect.stringMatching(/\/api\/cowork\/w1\/receipts$/));
    });

    it('names a receipt that was removed or changed, and runs without one', async () => {
        stubRecordingFetch(() => jsonResponse(chain({ ok: false, problem: { seq: 2, kind: 'gap' } })));
        const { unmount } = renderWithClient(<ReceiptChain coworkId="w1" />);
        expect(await screen.findByText('Receipt 2 is missing from the chain.')).toBeInTheDocument();
        unmount();
        stubRecordingFetch(() => jsonResponse(chain({}, 2)));
        renderWithClient(<ReceiptChain coworkId="w2" />);
        expect(await screen.findByText('2 finished runs have no receipt.')).toBeInTheDocument();
    });
});
