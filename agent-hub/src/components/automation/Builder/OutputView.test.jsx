import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import OutputView from './OutputView';
import { fetchRunFullOutput } from '../../../api/queries/runFullOutput';

// Only the network call is replaced; fullOutputRefOf stays the real reader.
vi.mock('../../../api/queries/runFullOutput', async (importOriginal) => ({
    ...(await importOriginal()),
    fetchRunFullOutput: vi.fn(),
}));

// Shape that mirrors a forEach step's output: results[*].output.content.
const VALUE = {
    results: [
        { output: { content: 'INV-1', filename: 'a.pdf' } },
        { output: { content: 'INV-2', filename: 'b.pdf' } },
    ],
};
const BASE = 'steps.x.output';

function dndEvent() {
    return { setData: vi.fn(), effectAllowed: '' };
}

describe('OutputView — drag/click mapping', () => {
    beforeEach(() => cleanup());

    it('maps a table column to an absolute [*] path (not a relative segment)', () => {
        const onPick = vi.fn();
        const { container } = render(
            <OutputView value={VALUE} basePath={BASE} enableDrag onPickPath={onPick} />,
        );
        // The `output` column header maps every row's whole output object.
        const th = container.querySelector('[title*="steps.x.output.results[*].output)"]');
        expect(th).toBeTruthy();
        fireEvent.click(th);
        expect(onPick).toHaveBeenCalledWith('steps.x.output.results[*].output', { raw: false });
    });

    it('drills an object column so a single nested field (content) is mappable', () => {
        const onPick = vi.fn();
        const { container } = render(
            <OutputView value={VALUE} basePath={BASE} enableDrag onPickPath={onPick} />,
        );
        // Expand the `output` object column into its leaf sub-columns.
        const expandBtn = screen.getByLabelText('Show fields');
        fireEvent.click(expandBtn);
        // Now a `content` sub-column header maps every row's content only.
        const contentTh = container.querySelector('[title*="steps.x.output.results[*].output.content)"]');
        expect(contentTh).toBeTruthy();
        fireEvent.click(contentTh);
        expect(onPick).toHaveBeenCalledWith('steps.x.output.results[*].output.content', { raw: false });
    });

    it('sets an absolute binding path on dragStart', () => {
        const { container } = render(
            <OutputView value={VALUE} basePath={BASE} enableDrag onPickPath={vi.fn()} />,
        );
        const th = container.querySelector('[title*="steps.x.output.results[*].output)"]');
        const dataTransfer = dndEvent();
        fireEvent.dragStart(th, { dataTransfer });
        expect(dataTransfer.setData).toHaveBeenCalledWith('application/x-binding-path', 'steps.x.output.results[*].output');
    });

    it('a single cell maps the indexed path', () => {
        const onPick = vi.fn();
        const { container } = render(
            <OutputView value={VALUE} basePath={BASE} enableDrag onPickPath={onPick} />,
        );
        const cell = container.querySelector('td[title*="steps.x.output.results[0].output"]');
        expect(cell).toBeTruthy();
        fireEvent.click(cell);
        expect(onPick).toHaveBeenCalledWith('steps.x.output.results[0].output', { raw: false });
    });

    it('without enableDrag the table is not draggable (Output column unchanged)', () => {
        const { container } = render(<OutputView value={VALUE} basePath={BASE} />);
        // No expand affordance and no draggable headers when mapping is off.
        expect(screen.queryByLabelText('Show fields')).toBeNull();
        const th = container.querySelector('thead th');
        expect(th).toBeTruthy();
        expect(th.getAttribute('draggable')).toBeNull();
    });

    // Regression: an array of empty objects used to trigger an unbounded
    // RecordTable <-> FriendlyArray render loop (both find zero columns and
    // hand the same array back to each other), hanging/crashing the panel.
    it('renders an array of empty objects without hanging', () => {
        expect(() => render(<OutputView value={[{}]} basePath={BASE} />)).not.toThrow();
        cleanup();
        expect(() => render(<OutputView value={[{}, {}, {}]} basePath={BASE} />)).not.toThrow();
    });
});

describe('OutputView — long text is readable, not silently cut', () => {
    it('clamps a long string but offers the rest', () => {
        const long = 'a'.repeat(1200);
        render(<OutputView value={long} />);
        const toggle = screen.getByText('Show all 1200 characters');
        expect(document.body.textContent).not.toContain(long);
        fireEvent.click(toggle);
        expect(document.body.textContent).toContain(long);
        fireEvent.click(screen.getByText('Show less'));
        expect(document.body.textContent).not.toContain(long);
    });

    it('leaves short text alone', () => {
        render(<OutputView value="hello" />);
        expect(screen.getByText('hello')).toBeTruthy();
        expect(screen.queryByText(/Show all/)).toBeNull();
    });
});

describe('OutputView — array columns (the list-in-a-table complaint)', () => {
    beforeEach(() => cleanup());

    // A table whose column holds a LIST — the user's literal complaint.
    const MAIL = {
        results: [
            { subject: 'A', attachments: [{ filename: 'a1.pdf' }, { filename: 'a2.pdf' }] },
            { subject: 'B', attachments: [{ filename: 'b1.pdf' }] },
            { subject: 'C', attachments: [] },
        ],
    };

    it('an array-of-records cell reads as a labelled list, never as absent data', () => {
        render(<OutputView value={MAIL} basePath={BASE} enableDrag onPickPath={vi.fn()} />);
        // 2 + 1 records, one badge per non-empty cell…
        expect(screen.getByText('2 records')).toBeTruthy();
        expect(screen.getByText('1 record')).toBeTruthy();
        // …and an EMPTY list is a fact ("no attachments"), not the "—" marker.
        expect(screen.getByText('none')).toBeTruthy();
    });

    it('an array column expands into [*] children whose cells actually resolve', () => {
        const onPick = vi.fn();
        render(<OutputView value={MAIL} basePath={BASE} enableDrag onPickPath={onPick} />);
        fireEvent.click(screen.getByLabelText('Open the list in Attachments'));
        // The wildcard cells resolve through the runtime's [*] flatten —
        // a naive dotted walk would render `—` in every one of them.
        expect(screen.getAllByText('a1.pdf, a2.pdf').length).toBeGreaterThan(0);
        expect(screen.getAllByText('b1.pdf').length).toBeGreaterThan(0);
        // The expanded header maps the CHAINED wildcard column.
        const th = document.querySelector('[title*="results[*].attachments[*].filename"]');
        expect(th).toBeTruthy();
        fireEvent.click(th);
        expect(onPick).toHaveBeenCalledWith('steps.x.output.results[*].attachments[*].filename', { raw: false });
    });

    it('the per-column chooser button does not collide with "Show fields"', () => {
        const onPick = vi.fn();
        render(<OutputView value={MAIL} basePath={BASE} enableDrag onPickPath={onPick} />);
        // The chooser is its own affordance with its own name…
        fireEvent.click(screen.getByLabelText("Choose how to use every row's Subject"));
        expect(onPick).toHaveBeenCalledWith('steps.x.output.results[*].subject', { raw: false });
        // …and the expand chevron for the OBJECT column keeps its label.
        render(<OutputView value={VALUE} basePath={BASE} enableDrag onPickPath={vi.fn()} />);
        expect(screen.getByLabelText('Show fields')).toBeTruthy();
    });

    it('says how many columns the cap dropped, and hands them over on request', () => {
        const wide = [Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`col${i}`, i]))];
        render(<OutputView value={wide} basePath={BASE} />);
        const more = screen.getByText('+6 more columns');
        expect(more).toBeTruthy();
        // A dead label was the complaint: the cap has to be a way THROUGH.
        fireEvent.click(more);
        expect(screen.getByText('Col29')).toBeTruthy();
        expect(screen.getByText('Fewer columns')).toBeTruthy();
    });
});

describe('OutputView — reaching a nested list without a drag target (BFSF-402)', () => {
    beforeEach(() => cleanup());

    // What a "Call a web service" step returns: a list of tasks, each with a
    // nested result the user has to get into.
    const TASKS = {
        tasks: [
            { id: 1, result: { items: [{ name: 'a' }, { name: 'b' }] } },
            { id: 2, result: { items: [{ name: 'c' }] } },
        ],
    };

    it('drills a column open even where nothing is draggable', () => {
        const { container } = render(<OutputView value={TASKS} basePath={BASE} allowExpand />);
        // Reading, not mapping: the chevron is there, the drag handles are not.
        expect(container.querySelector('thead th').getAttribute('draggable')).toBeNull();
        fireEvent.click(screen.getByLabelText('Show fields'));
        expect(screen.getByText('Items')).toBeTruthy();
    });

    it('leaves a caller that asked for neither exactly as it was', () => {
        // DryRunPanel passes neither prop; its inline preview cards must not
        // sprout chevrons.
        render(<OutputView value={TASKS} basePath={BASE} />);
        expect(screen.queryByLabelText('Show fields')).toBeNull();
    });
});

describe('OutputView — the table is the answer', () => {
    beforeEach(() => cleanup());

    // Exactly what a Gmail search returns.
    const SEARCH = {
        query: 'isv',
        total: 201,
        results: [{ id: '19ff', to: 'ruben@example.com', date: 'Tue, 11 Aug' }],
    };

    it('drops the request echo above the table — the header already counts the rows', () => {
        render(<OutputView value={SEARCH} basePath={BASE} />);
        expect(screen.queryByText('Query:')).toBeNull();
        expect(screen.queryByText('Total:')).toBeNull();
        expect(screen.queryByText('Results')).toBeNull();
        // …and the data itself is right there, unlabelled and above the fold.
        expect(screen.getByText('ruben@example.com')).toBeTruthy();
    });

    it('keeps the labels when they are the only thing telling two lists apart', () => {
        render(<OutputView value={{ sent: [{ id: 1 }], failed: [{ id: 2 }] }} basePath={BASE} />);
        expect(screen.getByText('Sent')).toBeTruthy();
        expect(screen.getByText('Failed')).toBeTruthy();
    });

    it('keeps the labels when a scalar is all there is', () => {
        render(<OutputView value={{ status: 'ok', note: 'nothing to do' }} basePath={BASE} />);
        expect(screen.getByText('Status:')).toBeTruthy();
    });

    it('keeps a scalar that is part of the ANSWER, not of the request', () => {
        // Same shape as the search envelope; every word of it is content.
        render(<OutputView value={{ urgency: 'Medium', topSenders: [{ name: 'Van Dijk Administratie' }] }} basePath={BASE} />);
        expect(screen.getByText('Urgency:')).toBeTruthy();
        expect(screen.getByText('Medium')).toBeTruthy();
    });

    it('keeps a lone list\'s label — it is the only word naming the table', () => {
        render(<OutputView value={{ invoices: [{ n: 1 }] }} basePath={BASE} />);
        expect(screen.getByText('Invoices')).toBeTruthy();
    });

    it('caps every column so one long value cannot push the rest off the panel', () => {
        const { container } = render(<OutputView value={SEARCH} basePath={BASE} />);
        const cells = [...container.querySelectorAll('td'), ...container.querySelectorAll('th')];
        expect(cells.length).toBeGreaterThan(0);
        expect(cells.every(c => c.style.maxWidth === '220px')).toBe(true);
    });

    it('shows a cell\'s full contents on hover, once the pointer settles', () => {
        vi.useFakeTimers();
        try {
            const long = { results: [{ to: 'Ruben van de Laar <ruben@example.com>, Tom Smit <tomsmit@beeflow.nl>' }] };
            const { container } = render(<OutputView value={long} basePath={BASE} />);
            const td = container.querySelector('td');
            fireEvent.mouseEnter(td);
            // Nothing yet — sweeping across a table must not strobe.
            expect(document.querySelector('[role="tooltip"]')).toBeNull();
            act(() => { vi.advanceTimersByTime(300); });
            const card = document.querySelector('[role="tooltip"]');
            expect(card).toBeTruthy();
            expect(card.textContent).toContain('tomsmit@beeflow.nl');
            fireEvent.mouseLeave(td);
            expect(document.querySelector('[role="tooltip"]')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('stays quiet for a short value that already fits', () => {
        vi.useFakeTimers();
        try {
            const { container } = render(<OutputView value={{ results: [{ n: 201 }] }} basePath={BASE} />);
            fireEvent.mouseEnter(container.querySelector('td'));
            act(() => { vi.advanceTimersByTime(300); });
            expect(document.querySelector('[role="tooltip"]')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});

// The runner's per-item envelope: one row per iteration, each carrying BOTH
// the upstream item the step looped over and what the step itself returned.
const PER_ITEM = {
    iterations: 2,
    results: [
        { index: 0, item: { name: 'a.pdf', url: 'https://x/a' }, output: { count: 2, rooms: [{ token: 't1' }] }, status: 'success' },
        { index: 1, item: { name: 'b.pdf', url: 'https://x/b' }, output: { count: 1, rooms: [{ token: 't2' }] }, status: 'success' },
    ],
};

describe('OutputView — run-once-per-item envelope (BFSF-369)', () => {
    beforeEach(() => cleanup());

    it('says which columns were looped over and which the step returned', () => {
        const { container } = render(<OutputView value={PER_ITEM} basePath={BASE} />);
        // Two header rows: the grouping row, then the column names.
        const rows = container.querySelectorAll('thead tr');
        expect(rows).toHaveLength(2);
        expect(screen.getByText('Looped over')).toBeTruthy();
        expect(screen.getByText('This step returned')).toBeTruthy();
    });

    it('spans each half over its own columns, leaving index/status alone', () => {
        const { container } = render(<OutputView value={PER_ITEM} basePath={BASE} />);
        const groupRow = container.querySelectorAll('thead tr')[0];
        const labelled = [...groupRow.querySelectorAll('th')]
            .map(th => [th.textContent, th.getAttribute('colSpan') || th.colSpan]);
        // index → ungrouped; item → "Looped over"; output → "This step
        // returned"; status → ungrouped. Order follows the columns.
        expect(labelled.map(([text]) => text)).toEqual(['', 'Looped over', 'This step returned', '']);
    });

    it('leaves an ordinary table with a single header row', () => {
        // No item/output pair → nothing to disambiguate, so no extra chrome.
        const { container } = render(<OutputView value={VALUE} basePath={BASE} />);
        expect(container.querySelectorAll('thead tr')).toHaveLength(1);
    });
});

describe('OutputView — a web-service response with a parsed body', () => {
    beforeEach(() => cleanup());

    // `body` stays the raw text and `data` is the same thing parsed. Left as
    // a plain object the panel led with "Status / Ok / Headers / Body" and
    // buried the actual answer, which is the complaint this addresses.
    const HTTP = {
        status: 200,
        ok: true,
        headers: { 'content-type': 'application/json' },
        body: '[{"summary":"one"},{"summary":"two"}]',
        data: [{ summary: 'one', state: 'Open' }, { summary: 'two', state: 'Done' }],
        truncated: false,
    };

    it('leads with the table instead of the transport fields', () => {
        render(<OutputView value={HTTP} basePath={BASE} />);
        expect(screen.getByText('Summary')).toBeTruthy();
        expect(screen.getByText('one')).toBeTruthy();
        // The envelope around it is chrome, not content.
        expect(screen.queryByText('Truncated:')).toBeNull();
    });

    it('still shows everything under the JSON view', () => {
        render(<OutputView value={HTTP} basePath={BASE} />);
        fireEvent.click(screen.getByText('JSON'));
        expect(screen.getByText(/truncated/)).toBeTruthy();
    });

    it('keeps the labelled fields when there is no parsed body', () => {
        // A non-JSON response is unchanged by any of this.
        const plain = { status: 200, ok: true, headers: {}, body: 'a,b\n1,2', truncated: false };
        render(<OutputView value={plain} basePath={BASE} />);
        expect(screen.getByText('Status:')).toBeTruthy();
    });

    it('does not collapse an object that merely happens to hold a list', () => {
        // The signature is strict on purpose: without it, hiding "unrecognised"
        // scalars would start swallowing real fields on every other step.
        const notHttp = { invoices: [{ id: 1 }], customer: 'Acme' };
        render(<OutputView value={notHttp} basePath={BASE} />);
        expect(screen.getByText('Customer:')).toBeTruthy();
    });

    it('unwraps an OBJECT payload too, not only an array one', () => {
        // `{…, data: {tasks: […]}}` used to render flat, with the giant raw
        // `body` string above the only half anyone wanted (BFSF-402).
        const nested = {
            status: 200,
            ok: true,
            headers: { 'content-type': 'application/json' },
            body: '{"tasks":[{"title":"one"}]}',
            truncated: false,
            data: { tasks: [{ title: 'one', state: 'Open' }] },
        };
        render(<OutputView value={nested} basePath={BASE} />);
        expect(screen.getByText('Title')).toBeTruthy();
        expect(screen.getByText('one')).toBeTruthy();
        expect(screen.queryByText('Body:')).toBeNull();
    });

    it('never hides a clip warning behind the unwrap', () => {
        // `truncated` is one of the fields the unwrap drops — and the one that
        // changes what the data below MEANS.
        const clipped = {
            status: 200, ok: true, headers: {}, truncated: true,
            body: '[{"a":1}]', data: [{ a: 1 }],
        };
        render(<OutputView value={clipped} basePath={BASE} />);
        expect(screen.getByText(/cut short/)).toBeTruthy();
    });
});

describe('OutputView — a JSON string is structure, not 372014 characters', () => {
    beforeEach(() => cleanup());

    it('shows a body that parses as the structure it encodes, not as text', () => {
        // It used to wait behind a "Show as tree" button; JSON text at any
        // level now reads as the records and tables it holds.
        render(<OutputView value={JSON.stringify({ tasks: [{ title: 'one' }] })} />);
        expect(screen.getByText('Title')).toBeTruthy();
        expect(screen.getByText('one')).toBeTruthy();
        expect(screen.queryByText('Show as tree')).toBeNull();
    });

    it('leaves ordinary text alone', () => {
        render(<OutputView value={'a'.repeat(700)} />);
        expect(screen.queryByText('Show as tree')).toBeNull();
        expect(screen.getByText('Show all 700 characters')).toBeTruthy();
    });

    it('says so when the sniff was wrong, instead of pretending', () => {
        render(<OutputView value={'{ not really json }'} />);
        fireEvent.click(screen.getByText('Show as tree'));
        expect(screen.getByText('Not valid JSON')).toBeTruthy();
    });
});

describe('OutputView — the truncation sentinel is a sentinel, not data', () => {
    beforeEach(() => cleanup());

    const SENTINEL = { __truncated__: true, originalBytes: 2_411_724, headSample: '{"results":[' };

    it('says how big the output was and what survived', () => {
        render(<OutputView value={SENTINEL} basePath={BASE} />);
        expect(screen.getByText(/Output was 2\.3 MB/)).toBeTruthy();
        expect(screen.getByText('{"results":[')).toBeTruthy();
    });

    it('never renders it as three anonymous labelled fields', () => {
        render(<OutputView value={SENTINEL} basePath={BASE} />);
        expect(screen.queryByText('Original Bytes:')).toBeNull();
        expect(screen.queryByText('Head Sample:')).toBeNull();
    });

    it('not in the JSON view either — the sentinel is caught above the view switch', () => {
        render(<OutputView value={SENTINEL} basePath={BASE} />);
        expect(screen.queryByRole('button', { name: /JSON/ })).toBeNull();
        expect(screen.queryByText('__truncated__')).toBeNull();
    });

    it('no longer advises a re-run that would only store the same sample again', () => {
        render(<OutputView value={SENTINEL} basePath={BASE} />);
        expect(screen.queryByText(/Re-run the step/)).toBeNull();
        expect(screen.getByText(/The step itself worked with all of it/)).toBeTruthy();
    });

    it('says plainly when no full copy was kept, and offers nothing to load', () => {
        render(<OutputView value={SENTINEL} basePath={BASE} />);
        expect(screen.getByText(/No full copy of this output was kept/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Show the full output' })).toBeNull();
    });
});

describe('OutputView — the full copy of a truncated output (BFSF-402)', () => {
    beforeEach(() => { cleanup(); vi.mocked(fetchRunFullOutput).mockReset(); });

    it('loads it on request and shows it with the Table and JSON views, search included', async () => {
        const ref = { runId: 'run-1', stepId: 'http1', attempts: 1 };
        vi.mocked(fetchRunFullOutput).mockResolvedValue({ items: [{ id: 'first-item' }, { id: 'second-item' }] });
        const user = userEvent.setup();
        render(<OutputView value={{ __truncated__: true, originalBytes: 2_411_724, headSample: '{"items":[', fullOutputRef: ref }} basePath={BASE} />);

        await user.click(screen.getByRole('button', { name: 'Show the full output' }));
        expect(fetchRunFullOutput).toHaveBeenCalledWith(ref);
        expect(await screen.findByText('second-item')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: /JSON/ }));
        expect(screen.getByLabelText('Search keys or values')).toBeTruthy();
    });
});

describe('OutputView — the JSON view is usable (BFSF-434)', () => {
    beforeEach(() => cleanup());

    it('has a search box — the only live call site used to switch it off', () => {
        render(<OutputView value={VALUE} basePath={BASE} />);
        fireEvent.click(screen.getByRole('button', { name: /JSON/ }));
        expect(screen.getByLabelText('Search keys or values')).toBeTruthy();
    });

    it('counts a list the way the rest of the product counts', () => {
        render(<OutputView value={{ rows: [{ a: 1 }, { a: 2 }, { a: 3 }] }} basePath={BASE} />);
        fireEvent.click(screen.getByRole('button', { name: /JSON/ }));
        expect(screen.getByText('3 records')).toBeTruthy();
        expect(screen.queryByText('Array(3)')).toBeNull();
    });

    it('caps one container at 50 children instead of rendering 500', () => {
        const big = { rows: Array.from({ length: 500 }, (_, i) => ({ i })) };
        render(<OutputView value={big} basePath={BASE} />);
        fireEvent.click(screen.getByRole('button', { name: /JSON/ }));
        expect(screen.getByText('+450 more')).toBeTruthy();
    });
});
