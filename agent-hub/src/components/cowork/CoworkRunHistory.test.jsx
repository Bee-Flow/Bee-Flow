import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import CoworkRunHistory from './CoworkRunHistory';

/**
 * The run history: one card, one row per run.
 *
 * What CW-13 moved, and what these tests hold in place:
 *
 *   - a row now SAYS what came out of the run, on its closed summary line. It
 *     used to say "Finished · 13 Aug, 11:29 · run by you · 5.2s" — four facts
 *     about the run and none about the work, so a run that produced a digest
 *     and one that produced nothing were the same line.
 *   - "it finished with nothing to report" and "it broke and left no reason"
 *     were word-for-word identical when opened. They are different facts and
 *     the reader gets to tell them apart.
 *   - `producedOutput` is three-valued. `null` is a row from before the
 *     column existed and must never be read as "produced nothing".
 *
 * The security tests at the bottom (run output renders as content, never as a
 * live component) are unchanged and unrelated to the layout.
 */

const api = vi.hoisted(() => ({
    listCoworkRuns: vi.fn(),
    listCoworkAgents: vi.fn(),
}));
vi.mock('./coworkApi', () => api);

// Runs are dated RELATIVE to the day the suite runs. A fixed calendar date
// would drift through "Today" → a weekday → a date as the weeks passed, and
// the wording is exactly what these tests are about.
const todayAt = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
const STARTED = todayAt(10, 0);

const run = (over = {}) => ({
    id: 'r1',
    status: 'success',
    triggerKind: 'manual',
    startedAt: STARTED.toISOString(),
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

/**
 * Every URL the browser would fetch or navigate to on the row's behalf.
 * Text that merely *reads* like a URL is not one of these — the distinction
 * the run-output tests below turn on.
 */
function liveUrls(row) {
    return [...row.querySelectorAll('[src], [href], [data]')]
        .map(el => el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('data'));
}

beforeEach(() => {
    api.listCoworkRuns.mockReset();
});

describe('CoworkRunHistory — fetching', () => {
    it('shows a loading line until the first response lands, then replaces it', async () => {
        const d = deferred();
        api.listCoworkRuns.mockReturnValue(d.promise);
        render(<CoworkRunHistory coworkId="w1" reloadKey={0} />);

        expect(screen.getByText('Loading history…')).toBeInTheDocument();
        expect(screen.queryByTestId('cowork-run-list')).not.toBeInTheDocument();

        await act(async () => { d.resolve({ runs: [run()], total: 1 }); });
        expect(screen.queryByText('Loading history…')).not.toBeInTheDocument();
        expect(screen.getByTestId('cowork-run-list')).toBeInTheDocument();
    });

    it('asks for the item by id and passes no paging arguments at all', async () => {
        // Pinned because it is the other half of the "Showing the N most
        // recent of M" line below: the component never asks for page two, so
        // the server's default page size is the whole history a user can see.
        await renderHistory([run()]);
        expect(api.listCoworkRuns).toHaveBeenCalledTimes(1);
        expect(api.listCoworkRuns).toHaveBeenCalledWith('w1');
        expect(api.listCoworkRuns.mock.calls[0]).toHaveLength(1);
    });

    it('wrat: with no coworkId it never fetches and sits on "Loading history…" for ever', async () => {
        render(<CoworkRunHistory coworkId={null} reloadKey={0} />);
        await act(async () => {});
        expect(api.listCoworkRuns).not.toHaveBeenCalled();
        expect(screen.getByText('Loading history…')).toBeInTheDocument();
    });

    it('refetches on a reloadKey bump — and swaps the rows for the loading line meanwhile', async () => {
        const { rerender } = await renderHistory([run({ durationMs: 5200 })]);
        expect(screen.getByTestId('cowork-run')).toHaveTextContent('0m 05s');

        const d = deferred();
        api.listCoworkRuns.mockReturnValue(d.promise);
        rerender(<CoworkRunHistory coworkId="w1" reloadKey={1} />);

        // The list it already had is gone while the refetch is in flight.
        expect(screen.queryByTestId('cowork-run')).not.toBeInTheDocument();
        expect(screen.getByText('Loading history…')).toBeInTheDocument();

        await act(async () => { d.resolve({ runs: [run({ durationMs: 1200 })], total: 1 }); });
        expect(screen.getByTestId('cowork-run')).toHaveTextContent('0m 01s');
        expect(api.listCoworkRuns).toHaveBeenCalledTimes(2);
    });

    it('ignores a response for an item the user has already navigated away from', async () => {
        const first = deferred();
        api.listCoworkRuns.mockReturnValueOnce(first.promise);
        api.listCoworkRuns.mockResolvedValue({ runs: [run({ id: 'r2', durationMs: 5200 })], total: 1 });

        const { rerender } = render(<CoworkRunHistory coworkId="w1" reloadKey={0} />);
        rerender(<CoworkRunHistory coworkId="w2" reloadKey={0} />);
        await act(async () => { first.resolve({ runs: [run({ id: 'r1', durationMs: 1200 })], total: 1 }); });

        expect(api.listCoworkRuns).toHaveBeenLastCalledWith('w2');
        const rows = screen.getAllByTestId('cowork-run');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toHaveTextContent('0m 05s');
        expect(rows[0]).not.toHaveTextContent('0m 01s');
    });
});

describe('CoworkRunHistory — the failure path', () => {
    it('shows the API error verbatim, as an alert', async () => {
        api.listCoworkRuns.mockRejectedValue(new Error('Could not load the run history'));
        render(<CoworkRunHistory coworkId="w1" reloadKey={0} />);
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Could not load the run history');
    });

    it('wrat: the error wipes the rows it had, and offers nothing to retry with', async () => {
        const { rerender } = await renderHistory([run()]);
        expect(screen.getByTestId('cowork-run')).toBeInTheDocument();

        api.listCoworkRuns.mockRejectedValue(new Error('Network is down'));
        rerender(<CoworkRunHistory coworkId="w1" reloadKey={1} />);
        await screen.findByRole('alert');

        expect(screen.queryByTestId('cowork-run')).not.toBeInTheDocument();
        expect(screen.queryByTestId('cowork-run-list')).not.toBeInTheDocument();
        // No "Try again": the only way back is a reloadKey bump from the parent.
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
});

describe('CoworkRunHistory — nothing has run yet', () => {
    it('says so in words, under its own testid', async () => {
        await renderHistory([]);
        const empty = screen.getByTestId('cowork-no-runs');
        expect(empty).toHaveTextContent('This hasn’t run yet. The history fills in after the first run.');
        expect(screen.queryByTestId('cowork-run-list')).not.toBeInTheDocument();
    });
});

describe('CoworkRunHistory — what one row says while it is closed', () => {
    it('states the status, the day in words, the duration and what came out of it', async () => {
        await renderHistory([run()]);
        const row = screen.getByTestId('cowork-run');

        const badge = row.querySelector('[data-status-key]');
        expect(badge.getAttribute('data-status-key')).toBe('run_status.success');
        expect(badge).toHaveTextContent('Finished');
        // A relative day, not a date to decode, and not "3h ago" either — the
        // history answers "when", the list column answers "how long ago".
        expect(row).toHaveTextContent('Today 10:00');
        expect(row).not.toHaveTextContent('ago');
        expect(row).toHaveTextContent('0m 05s');
        // The outcome line: the thing the old row could not say at all.
        expect(row).toHaveTextContent('All good.');
    });

    it('keeps the status as a WORD even though only a dot is painted', async () => {
        // The row's visible status is a 7px coloured dot. A colour is not a
        // word: a screen reader and a colour-blind reader both get nothing
        // from it, so the word stays in the row, hidden from sight only.
        await renderHistory([run()]);
        const badge = screen.getByTestId('cowork-run').querySelector('[data-status-key]');
        expect(badge.className).toContain('sr-only');
        expect(badge).toHaveTextContent('Finished');
    });

    it('one row per run, in exactly the order the server sent them', async () => {
        await renderHistory([
            run({ id: 'a', result: 'First run' }),
            run({ id: 'b', result: 'Second run' }),
            run({ id: 'c', result: 'Third run' }),
        ]);
        const rows = screen.getAllByTestId('cowork-run');
        expect(rows).toHaveLength(3);
        expect(rows.map(r => r.textContent.match(/(First|Second|Third) run/)[0]))
            .toEqual(['First run', 'Second run', 'Third run']);
    });

    it('keeps who started it OUT of the summary line and inside the opened row', async () => {
        // Four columns of run-mechanics was what pushed the outcome off the
        // row in the first place. Who pressed the button is a fact about the
        // run, not about the work, so it lives one click down.
        await renderHistory([run({ triggerKind: 'manual' })]);
        const row = screen.getByTestId('cowork-run');
        expect(within(row).getByRole('button').textContent).not.toMatch(/started/i);
        expand(row);
        expect(body(row)).toHaveTextContent('Started by you');
    });

    it('wrat: anything that is not literally "manual" reads as "on schedule"', async () => {
        await renderHistory([
            run({ id: 'a', triggerKind: 'schedule' }),
            run({ id: 'b', triggerKind: undefined }),
            run({ id: 'c', triggerKind: 'api' }),
            run({ id: 'd', triggerKind: 'MANUAL' }),
        ]);
        const rows = screen.getAllByTestId('cowork-run');
        for (const row of rows) expand(row);
        // An API-triggered run and an upper-cased "MANUAL" both claim the
        // scheduler started them. Nobody did.
        for (const row of rows) expect(body(row)).toHaveTextContent('Started on schedule');
    });

    it('leaves the duration column blank when there is none, and prints a zero one', async () => {
        await renderHistory([
            run({ id: 'a', durationMs: null }),
            run({ id: 'b', durationMs: 0 }),
        ]);
        const rows = screen.getAllByTestId('cowork-run');
        // "Nobody timed this" and "it took no measurable time" stay apart.
        expect(rows[0].textContent).not.toMatch(/\dm \d\ds/);
        expect(rows[1]).toHaveTextContent('0m 00s');
    });

});

describe('CoworkRunHistory — the status on a row', () => {
    it('translates the server spelling "failed" into the "Failed" badge', async () => {
        await renderHistory([run({ status: 'failed', result: null, error: 'boom' })]);
        const badge = screen.getByTestId('cowork-run').querySelector('[data-status-key]');
        expect(badge.getAttribute('data-status-key')).toBe('run_status.error');
        expect(badge).toHaveTextContent('Failed');
    });

    it('wrat: a status the token table does not know renders as "Idle"', async () => {
        // A run that timed out server-side arrives as `timeout`; the row then
        // claims the state of a schedule that has never done anything.
        await renderHistory([run({ status: 'timeout' })]);
        const badge = screen.getByTestId('cowork-run').querySelector('[data-status-key]');
        expect(badge.getAttribute('data-status-key')).toBe('run_status.idle');
        expect(badge).toHaveTextContent('Idle');
    });

    it('leaves the moment blank rather than printing "Invalid Date" at the reader', async () => {
        await renderHistory([
            run({ id: 'a', startedAt: null }),
            run({ id: 'b', startedAt: 'yesterday-ish' }),
        ]);
        const rows = screen.getAllByTestId('cowork-run');
        for (const row of rows) {
            expect(row).not.toHaveTextContent('Invalid Date');
            expect(row).not.toHaveTextContent('yesterday-ish');
            // The rest of the row still reads: a missing timestamp costs the
            // column, not the run.
            expect(row).toHaveTextContent('All good.');
        }
    });
});

describe('CoworkRunHistory — opening a row', () => {
    it('starts closed, opens on click and closes again', async () => {
        // A body line the summary does NOT show, so "is it open?" is a real
        // question: the summary now carries the result's first line.
        await renderHistory([run({ result: 'All good.\n\nEvery quote checked out.' })]);
        const row = screen.getByTestId('cowork-run');
        const toggle = within(row).getByRole('button');

        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(row).not.toHaveTextContent('Every quote checked out.');

        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(row).toHaveTextContent('Every quote checked out.');

        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(row).not.toHaveTextContent('Every quote checked out.');
    });

    it('opens rows independently of each other', async () => {
        await renderHistory([
            run({ id: 'a', result: 'First\n\nFirst body' }),
            run({ id: 'b', result: 'Second\n\nSecond body' }),
        ]);
        const rows = screen.getAllByTestId('cowork-run');
        expand(rows[0]);
        expect(rows[0]).toHaveTextContent('First body');
        expect(rows[1]).not.toHaveTextContent('Second body');
    });

    it('renders a result as Markdown', async () => {
        await renderHistory([run({ result: '## Today\n\n- **Drink water**\n- Pick one thing' })]);
        const row = screen.getByTestId('cowork-run');
        expand(row);
        expect(within(row).getByRole('heading', { name: 'Today' })).toBeInTheDocument();
        expect(within(row).getByText('Drink water').tagName).toBe('STRONG');
        expect(row.textContent).not.toContain('**');
    });

    it('leaves a failure as monospaced plain text — asterisks and all', async () => {
        await renderHistory([run({ status: 'failed', result: null, error: 'Rate limited (429): retry in 60s *now*' })]);
        const row = screen.getByTestId('cowork-run');
        expand(row);
        const pre = body(row).querySelector('.font-mono');
        expect(pre).not.toBeNull();
        expect(pre).toHaveTextContent('Rate limited (429): retry in 60s *now*');
        expect(within(row).queryByRole('heading')).not.toBeInTheDocument();
    });

    it('wrat: a run that has BOTH an error and a result shows only the error', async () => {
        // A partially-succeeded run — one that wrote a digest and then failed
        // to deliver it — hides the work it did do.
        await renderHistory([run({ status: 'failed', result: '# The digest it did produce', error: 'Delivery failed' })]);
        const row = screen.getByTestId('cowork-run');
        expand(row);
        expect(row).toHaveTextContent('Delivery failed');
        expect(row).not.toHaveTextContent('The digest it did produce');
    });
});

describe('CoworkRunHistory — the truncation note', () => {
    it('states how many of how many are on screen once the server has more', async () => {
        await renderHistory([run({ id: 'a' }), run({ id: 'b' })], 40);
        expect(screen.getByTestId('cowork-run-list'))
            .toHaveTextContent('Showing the 2 most recent of 40 runs.');
    });

    it('wrat: it names the other 38 runs but offers no way to reach them', async () => {
        await renderHistory([run({ id: 'a' }), run({ id: 'b' })], 40);
        const list = screen.getByTestId('cowork-run-list');
        // Two disclosure buttons, one per row. No "Load more", no paging.
        expect(within(list).getAllByRole('button')).toHaveLength(2);
    });

    it('stays quiet when the list IS the whole history', async () => {
        await renderHistory([run({ id: 'a' }), run({ id: 'b' })], 2);
        expect(screen.getByTestId('cowork-run-list')).not.toHaveTextContent('most recent of');
    });

    it('wrat: a total smaller than the page it returned is silently believed', async () => {
        await renderHistory([run({ id: 'a' }), run({ id: 'b' })], 0);
        expect(screen.getAllByTestId('cowork-run')).toHaveLength(2);
        expect(screen.getByTestId('cowork-run-list')).not.toHaveTextContent('most recent of');
    });
});

describe('CoworkRunHistory — what a run result is allowed to render', () => {
    // A cowork run is unattended and reads whatever it was pointed at — mail,
    // web pages, documents. Its output lands in this panel, so a run result is
    // untrusted text by construction: a mail footer can talk the model into
    // writing anything at all here. The shared Markdown renderer maps a few
    // fence languages onto live components rather than onto text, which turns
    // that into an embed and tracking path in the owner's browser. These tests
    // pin the property that run output renders as CONTENT, never as an active
    // component — whichever fence language a future renderer claims.

    it('does not turn a map-embed block into a live iframe', async () => {
        const injected = [
            '```map-embed',
            '{"embedUrl":"https://attacker.example/track?u=1","title":"Head office"}',
            '```',
        ].join('\n');
        await renderHistory([run({ result: injected })]);
        const row = screen.getByTestId('cowork-run');
        expand(row);

        expect(row.querySelector('iframe')).toBeNull();
        expect(liveUrls(row).join(' ')).not.toContain('attacker.example');
    });

    it('shows the neutralised block as text instead of swallowing it', async () => {
        // Dropping model output silently would be its own bug: the reader has
        // to be able to see what the run actually wrote.
        const injected = ['```map-embed', '{"embedUrl":"https://attacker.example/x"}', '```'].join('\n');
        await renderHistory([run({ result: injected })]);
        const row = screen.getByTestId('cowork-run');
        expand(row);

        expect(row.textContent).toContain('embedUrl');
        expect(row.querySelector('iframe')).toBeNull();
    });

    it('neutralises every fence language the shared renderer makes active', async () => {
        // vega-lite, mermaid and page all render as components in chat.
        // None of them may do so from unattended, injectable run output.
        for (const language of ['map', 'maps', 'vega-lite', 'mermaid', 'json-page']) {
            const { unmount } = await renderHistory([
                run({ result: ['```' + language, '{"embedUrl":"https://attacker.example/x"}', '```'].join('\n') }),
            ]);
            const row = screen.getByTestId('cowork-run');
            expand(row);
            expect(row.querySelector('iframe'), language).toBeNull();
            expect(liveUrls(row).join(' '), language).not.toContain('attacker.example');
            unmount();
        }
    });

    it('does not let a quoted fence walk round the allow-list', async () => {
        // "> ```map-embed" is still a fenced block with an info string to
        // CommonMark, and quoted text is exactly the shape injected material
        // arrives in — a mail footer the run read back to itself.
        const injected = [
            '> ```map-embed',
            '> {"embedUrl":"https://attacker.example/track?u=1"}',
            '> ```',
        ].join('\n');
        await renderHistory([run({ result: injected })]);
        const row = screen.getByTestId('cowork-run');
        expand(row);

        expect(row.querySelector('iframe')).toBeNull();
        expect(liveUrls(row).join(' ')).not.toContain('attacker.example');
        expect(row.textContent).toContain('embedUrl');
    });

    it('never fetches an image the run output picked', async () => {
        // A Markdown image is a beacon: the browser fetches it the moment the
        // row is opened, handing the chosen host the owner's IP, user-agent
        // and referrer. No click, no fence, no warning.
        await renderHistory([run({ result: 'Report\n\n![](https://attacker.example/pixel.gif?who=owner)\n' })]);
        const row = screen.getByTestId('cowork-run');
        expand(row);

        expect(row.querySelector('img')).toBeNull();
        expect(liveUrls(row).join(' ')).not.toContain('attacker.example');
    });

    it('says an image was there instead of swallowing it', async () => {
        // Not fetching it is not the same as pretending it never existed: the
        // reader gets the alt text and the address, as text.
        await renderHistory([run({
            result: '![Quarterly chart](https://attacker.example/pixel.gif?who=owner)',
        })]);
        const row = screen.getByTestId('cowork-run');
        expand(row);

        const note = within(row).getByTestId('cowork-inert-image');
        expect(note.textContent).toContain('Quarterly chart');
        expect(note.textContent).toContain('https://attacker.example/pixel.gif?who=owner');
        expect(note.tagName).not.toBe('IMG');
        expect(note.getAttribute('src')).toBeNull();
    });

    it('still renders ordinary Markdown and ordinary code fences', async () => {
        // The fix must not cost the panel its actual job.
        const output = ['## Digest', '', 'Ran `build`:', '', '```js', 'const total = 41 + 1;', '```'].join('\n');
        await renderHistory([run({ result: output })]);
        const row = screen.getByTestId('cowork-run');
        expand(row);

        expect(within(row).getByRole('heading', { name: 'Digest' })).toBeInTheDocument();
        expect(row.textContent).toContain('const total = 41 + 1;');
        expect(row.querySelector('code.language-js')).not.toBeNull();
    });
});
