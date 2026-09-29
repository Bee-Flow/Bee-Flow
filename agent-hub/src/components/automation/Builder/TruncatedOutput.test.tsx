import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TruncatedOutput from './TruncatedOutput';
import { fetchRunFullOutput } from '../../../api/queries/runFullOutput';

/**
 * The truncation notice and its full copy (BFSF-402).
 *
 * Pinned: the copy is fetched only when asked for; while it loads the button
 * says so; a failure is said in words and can be retried; the short version
 * is one click back; a copy loaded for one row is never shown under another;
 * and a sentinel with no copy offers nothing to load.
 * OutputView.test.jsx covers the same notice from the panel's side.
 */

// Only the network call is replaced; fullOutputRefOf stays the real reader.
vi.mock('../../../api/queries/runFullOutput', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../api/queries/runFullOutput')>()),
    fetchRunFullOutput: vi.fn(),
}));

const REF = { runId: 'run-1', stepId: 'http1', attempts: 1 };
const KEPT = { __truncated__: true, originalBytes: 2_411_724, headSample: '{"items":[', fullOutputRef: REF };
// Another row of the same run, also truncated, also with a copy kept.
const OTHER = { __truncated__: true, originalBytes: 1_900_000, headSample: '{"rows":[', fullOutputRef: { ...REF, stepId: 'edit1' } };
const renderFull = (value: unknown) => <div data-testid="full">{JSON.stringify(value)}</div>;

beforeEach(() => {
    cleanup();
    vi.mocked(fetchRunFullOutput).mockReset();
});

describe('TruncatedOutput', () => {
    it('fetches nothing until asked, then hands the whole output to renderFull', async () => {
        vi.mocked(fetchRunFullOutput).mockResolvedValue({ items: ['a', 'b'] });
        const user = userEvent.setup();
        render(<TruncatedOutput sentinel={KEPT} renderFull={renderFull} />);

        expect(fetchRunFullOutput).not.toHaveBeenCalled();
        expect(screen.getByText(/The full output was kept beside the run history/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Show the full output' }));

        expect(fetchRunFullOutput).toHaveBeenCalledWith(REF);
        expect((await screen.findByTestId('full')).textContent).toBe('{"items":["a","b"]}');
        expect(screen.getByText('Showing the full output (2.3 MB).')).toBeTruthy();
    });

    it('says it is loading, and cannot be clicked twice meanwhile', async () => {
        let resolve: (v: unknown) => void = () => {};
        vi.mocked(fetchRunFullOutput).mockReturnValue(new Promise((r) => { resolve = r; }));
        const user = userEvent.setup();
        render(<TruncatedOutput sentinel={KEPT} renderFull={renderFull} />);

        await user.click(screen.getByRole('button', { name: 'Show the full output' }));
        const busy = screen.getByRole('button', { name: /Loading the full output/ }) as HTMLButtonElement;
        expect(busy.disabled).toBe(true);
        resolve({ ok: true });
        expect(await screen.findByTestId('full')).toBeTruthy();
    });

    it('goes back to the short version on request', async () => {
        vi.mocked(fetchRunFullOutput).mockResolvedValue({ items: [] });
        const user = userEvent.setup();
        render(<TruncatedOutput sentinel={KEPT} renderFull={renderFull} />);
        await user.click(screen.getByRole('button', { name: 'Show the full output' }));
        await user.click(await screen.findByRole('button', { name: 'Show the short version' }));

        expect(screen.queryByTestId('full')).toBeNull();
        expect(screen.getByText('{"items":[')).toBeTruthy();
    });

    it('says so when the copy cannot be loaded, and lets the person try again', async () => {
        vi.mocked(fetchRunFullOutput).mockRejectedValueOnce(new Error('HTTP 404')).mockResolvedValueOnce({ items: [] });
        const user = userEvent.setup();
        render(<TruncatedOutput sentinel={KEPT} renderFull={renderFull} />);

        await user.click(screen.getByRole('button', { name: 'Show the full output' }));
        expect((await screen.findByRole('status')).textContent).toMatch(/could not be loaded/);
        await user.click(screen.getByRole('button', { name: 'Show the full output' }));
        expect(await screen.findByTestId('full')).toBeTruthy();
    });

    // The run view and the node panel keep one instance while the person picks
    // another step or attempt. Two truncated steps in one run is the ordinary
    // case (a big web response, then the step that edits it).
    it('never shows one row\'s full output under another row the panel moved on to', async () => {
        vi.mocked(fetchRunFullOutput).mockResolvedValue({ items: ['from-http1'] });
        const user = userEvent.setup();
        const { rerender } = render(<TruncatedOutput sentinel={KEPT} renderFull={renderFull} />);
        await user.click(screen.getByRole('button', { name: 'Show the full output' }));
        expect(await screen.findByTestId('full')).toBeTruthy();

        rerender(<TruncatedOutput sentinel={OTHER} renderFull={renderFull} />);
        expect(screen.queryByTestId('full')).toBeNull();
        expect(screen.getByText('{"rows":[')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Show the full output' })).toBeTruthy();
    });

    it('drops a copy that arrives after the panel moved on to another row', async () => {
        let resolve: (v: unknown) => void = () => {};
        vi.mocked(fetchRunFullOutput).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
        const user = userEvent.setup();
        const { rerender } = render(<TruncatedOutput sentinel={KEPT} renderFull={renderFull} />);
        await user.click(screen.getByRole('button', { name: 'Show the full output' }));

        rerender(<TruncatedOutput sentinel={OTHER} renderFull={renderFull} />);
        await act(async () => { resolve({ items: ['from-http1'] }); });
        expect(screen.queryByTestId('full')).toBeNull();
        expect(screen.getByRole('button', { name: 'Show the full output' })).toBeTruthy();
    });

    it('offers nothing to load when no copy was kept, and says why the sample is all there is', () => {
        const { __truncated__, originalBytes, headSample } = KEPT;
        render(<TruncatedOutput sentinel={{ __truncated__, originalBytes, headSample }} renderFull={renderFull} />);

        expect(screen.queryByRole('button', { name: 'Show the full output' })).toBeNull();
        expect(screen.getByText(/No full copy of this output was kept/)).toBeTruthy();
        expect(screen.getByText(/Output was 2\.3 MB/)).toBeTruthy();
    });
});
