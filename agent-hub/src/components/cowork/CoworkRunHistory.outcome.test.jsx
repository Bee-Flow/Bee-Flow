import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import CoworkRunHistory from './CoworkRunHistory';

/**
 * CW-13 — the line a closed row says about what came OUT of the run, and the
 * card the rows sit in.
 *
 * Split out of CoworkRunHistory.test.jsx (which pins fetching, the row's
 * mechanics and the run-output security rules) because this is one property
 * with a lot of cases: a run that produced a digest, one that finished with
 * nothing to report, one that broke without a reason, and one from before
 * `produced_output` existed all have to read differently.
 */

const api = vi.hoisted(() => ({
    listCoworkRuns: vi.fn(),
    listCoworkAgents: vi.fn(),
}));
vi.mock('./coworkApi', () => api);

const todayAt = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };

const run = (over = {}) => ({
    id: 'r1',
    status: 'success',
    triggerKind: 'manual',
    startedAt: todayAt(10, 0).toISOString(),
    durationMs: 5200,
    result: 'All good.',
    error: null,
    ...over,
});

function deferred() {
    let resolve; let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function renderHistory(runs = [], total = null, props = {}) {
    api.listCoworkRuns.mockResolvedValue({ runs, total: total == null ? runs.length : total });
    const utils = render(<CoworkRunHistory coworkId="w1" reloadKey={0} {...props} />);
    await waitFor(() => expect(screen.queryByText(/Loading history/)).not.toBeInTheDocument());
    return utils;
}

/** Open a collapsed row. The disclosure is the row's only collapsed button. */
function expand(row) {
    fireEvent.click(within(row).getByRole('button', { expanded: false }));
}

/** The body a row reveals when opened — everything after the summary button. */
function body(row) {
    return row.lastElementChild;
}

beforeEach(() => {
    api.listCoworkRuns.mockReset();
});

describe('CoworkRunHistory — what came out of the run (CW-13)', () => {
    it('says "Nothing to report" when the server recorded an empty run', async () => {
        // The runner writes its own marker when the model returned no text.
        // That marker is plumbing, not a result, and never reaches the reader.
        await renderHistory([run({ producedOutput: false, result: '_(no text result)_' })]);
        const row = screen.getByTestId('cowork-run');
        expect(within(row).getByRole('button')).toHaveTextContent('Nothing to report');
        expect(row).not.toHaveTextContent('no text result');
    });

    it('tells "finished with nothing to report" apart from "broke and left no reason"', async () => {
        await renderHistory([
            run({ id: 'ok', status: 'success', producedOutput: false, result: null, error: null }),
            run({ id: 'bad', status: 'failed', result: null, error: null }),
        ]);
        const [ok, bad] = screen.getAllByTestId('cowork-run');
        expand(ok);
        expand(bad);
        expect(body(ok)).toHaveTextContent('This run finished and had nothing to report.');
        expect(body(bad)).toHaveTextContent('This run failed without recording a reason.');
        expect(body(ok).textContent).not.toBe(body(bad).textContent);
    });

    it('reads a row from before the column as UNKNOWN, never as empty', async () => {
        // producedOutput is three-valued. A null is a row nobody measured
        // this about, and it falls through to whatever text it does have.
        await renderHistory([
            run({ id: 'old', producedOutput: null, result: '3 quotes checked' }),
            run({ id: 'oldEmpty', producedOutput: null, result: null, error: null, status: 'success' }),
        ]);
        const [withText, without] = screen.getAllByTestId('cowork-run');
        expect(withText).toHaveTextContent('3 quotes checked');
        expect(withText).not.toHaveTextContent('Nothing to report');

        expect(within(without).getByRole('button')).toHaveTextContent('No output recorded');
        expand(without);
        expect(body(without)).toHaveTextContent('No output was recorded for this run.');
        expect(body(without)).not.toHaveTextContent('nothing to report');
    });

    it('gives a run that produced a digest a different summary from one that produced nothing', async () => {
        // This is the hole CW-13 was written for: both rows used to read
        // identically and you had to open both to find out which was which.
        await renderHistory([
            run({ id: 'full', result: '# A whole digest\n\nThree quotes checked.' }),
            run({ id: 'empty', result: null, producedOutput: false }),
        ]);
        const [full, empty] = screen.getAllByTestId('cowork-run');
        const summary = (r) => within(r).getByRole('button').textContent;
        expect(summary(full)).not.toBe(summary(empty));
        expect(summary(full)).toContain('A whole digest');
        expect(summary(empty)).toContain('Nothing to report');
    });

});

describe('CoworkRunHistory — how the outcome line is worded', () => {
    it('shows the first line of the result with its Markdown marks taken off', async () => {
        await renderHistory([run({ result: '## **3 quotes** seen\n\n- one discount of 22%' })]);
        const summary = within(screen.getByTestId('cowork-run')).getByRole('button').textContent;
        expect(summary).toContain('3 quotes seen');
        expect(summary).not.toContain('#');
        expect(summary).not.toContain('**');
    });

    it('skips blank and marker-only lines to find something worth showing', async () => {
        await renderHistory([run({ result: '\n\n---\n\nThe report is ready.' })]);
        expect(screen.getByTestId('cowork-run')).toHaveTextContent('The report is ready.');
    });

    it('summarises a failure with its first line, not its whole stack', async () => {
        await renderHistory([run({
            status: 'failed',
            result: null,
            error: 'Rate limited (429)\n  at fetchQuotes (quotes.js:31)\n  at run',
        })]);
        const summary = within(screen.getByTestId('cowork-run')).getByRole('button').textContent;
        expect(summary).toContain('Rate limited (429)');
        expect(summary).not.toContain('quotes.js:31');
        // The whole thing is still there once you open it.
        expand(screen.getByTestId('cowork-run'));
        expect(body(screen.getByTestId('cowork-run'))).toHaveTextContent('quotes.js:31');
    });

    it('says a run is still going instead of guessing at its outcome', async () => {
        await renderHistory([run({ status: 'running', result: null, error: null, durationMs: null })]);
        expect(screen.getByTestId('cowork-run')).toHaveTextContent('Still running…');
    });

    it('an empty or whitespace-only result reads as "no output" on the row', async () => {
        // The old row said nothing at all here, and the whitespace one opened
        // onto a blank panel with no explanation.
        await renderHistory([
            run({ id: 'a', result: '' }),
            run({ id: 'b', result: '   \n  ' }),
        ]);
        const [emptyStr, blanks] = screen.getAllByTestId('cowork-run');
        expect(within(emptyStr).getByRole('button')).toHaveTextContent('No output recorded');
        expect(within(blanks).getByRole('button')).toHaveTextContent('No output recorded');
    });

    it('wrat: an empty-string error falls through to the result branch', async () => {
        await renderHistory([run({ status: 'failed', error: '', result: '# It says it worked' })]);
        const row = screen.getByTestId('cowork-run');
        expand(row);
        expect(within(row).getByRole('heading', { name: 'It says it worked' })).toBeInTheDocument();
    });

    it('wrat: a run with BOTH an error and a result shows only the error', async () => {
        // A partially-succeeded run — one that wrote a digest and then failed
        // to deliver it — still hides the work it did do.
        await renderHistory([run({ status: 'failed', result: '# The digest it did produce', error: 'Delivery failed' })]);
        const row = screen.getByTestId('cowork-run');
        expand(row);
        expect(row).toHaveTextContent('Delivery failed');
        expect(row).not.toHaveTextContent('The digest it did produce');
    });
});

describe('CoworkRunHistory — the card around it', () => {
    it('is one card with the heading inside it, not a heading above loose rows', async () => {
        await renderHistory([run()]);
        const card = screen.getByTestId('cowork-history');
        expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent('What happened');
        expect(within(card).getByTestId('cowork-run-list')).toBeInTheDocument();
    });

    it('keeps the card, heading and all, while it is loading and when it is empty', async () => {
        const d = deferred();
        api.listCoworkRuns.mockReturnValue(d.promise);
        render(<CoworkRunHistory coworkId="w1" reloadKey={0} />);
        expect(within(screen.getByTestId('cowork-history')).getByRole('heading', { level: 3 })).toBeInTheDocument();

        await act(async () => { d.resolve({ runs: [], total: 0 }); });
        const card = screen.getByTestId('cowork-history');
        expect(within(card).getByRole('heading', { level: 3 })).toBeInTheDocument();
        expect(within(card).getByTestId('cowork-no-runs')).toBeInTheDocument();
    });
});


describe('CoworkRunHistory — a failure as the server actually records it', () => {
    // Every fixture below sets producedOutput, because the server does:
    // coworkStore.markError writes produced_output = false on EVERY failed
    // run. A suite whose failure rows leave that field undefined is testing a
    // row shape the product never produces, and the ordering inside
    // outcomeLine — error first, "nothing to report" after — is then free to
    // flip without anything going red.

    it('says WHY it failed, not that there was nothing to report', async () => {
        await renderHistory([run({
            status: 'error',
            error: 'Rate limited (429)',
            result: null,
            producedOutput: false,
        })]);
        const row = screen.getByTestId('cowork-run');
        expect(row).toHaveTextContent('Rate limited (429)');
        expect(row).not.toHaveTextContent('Nothing to report');
    });

    it('keeps the reason when the row is opened, too', async () => {
        await renderHistory([run({
            status: 'error',
            error: 'Rate limited (429)',
            result: null,
            producedOutput: false,
        })]);
        const row = screen.getByTestId('cowork-run');
        expand(row);
        expect(body(row)).toHaveTextContent('Rate limited (429)');
        expect(body(row)).not.toHaveTextContent('nothing to report');
    });

    it('calls a reasonless failure a failure, closed and open', async () => {
        // A failed row with no message and no result used to read "No output
        // recorded" — the same words as a successful empty run, in the list
        // you scan to find what broke.
        await renderHistory([run({ status: 'error', error: null, result: null, producedOutput: false })]);
        const row = screen.getByTestId('cowork-run');
        expect(row).toHaveTextContent('It failed without saying why');
        expect(row).not.toHaveTextContent('No output recorded');

        expand(row);
        expect(body(row)).toHaveTextContent('This run failed without recording a reason.');
        expect(body(row)).not.toHaveTextContent('nothing to report');
    });

    it('does not let a failed run borrow the words of a successful empty one', async () => {
        // The two rows side by side: same emptiness, different fact.
        await renderHistory([
            run({ id: 'r1', status: 'error', error: null, result: null, producedOutput: false }),
            run({ id: 'r2', status: 'success', error: null, result: '', producedOutput: false }),
        ]);
        const [failed, empty] = screen.getAllByTestId('cowork-run');
        expect(failed.textContent).not.toBe(empty.textContent);
        expect(empty).toHaveTextContent('Nothing to report');
    });
});

describe('CoworkRunHistory — a run that stopped on an expired sign-in', () => {
    // automationAuth switches the schedule off with last_status 'needs_reauth'
    // and markError records the same word on the run row. The shared token
    // table has no such row, so this used to fall through to the neutral
    // `idle` one: the grey dot and the word "Idle" on the screen whose job is
    // to show that unattended work has stopped. /stats counts it as failed.

    it('does not call it idle', async () => {
        await renderHistory([run({
            status: 'needs_reauth',
            error: 'needs_reauth: Google sign-in expired',
            result: null,
            producedOutput: false,
        })]);
        const row = screen.getByTestId('cowork-run');
        const word = row.querySelector('[data-status-key]');
        expect(word.getAttribute('data-status-key')).not.toBe('run_status.idle');
        expect(word.textContent).not.toBe('Idle');
        expect(word.textContent).toBe('Needs sign-in');
    });

    it('paints it like something that needs attention, not like nothing', async () => {
        await renderHistory([run({ id: 'r1', status: 'needs_reauth', error: 'needs_reauth: expired' })]);
        const attention = screen.getByTestId('cowork-run').querySelector('[aria-hidden="true"]');
        const reauthTone = attention.style.background;
        expect(reauthTone).not.toBe('var(--text-tertiary)');
        expect(reauthTone).toBe('var(--error)');
    });
});
