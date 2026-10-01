import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SourcePanel from './SourcePanel';

/**
 * useUpstreamVariables returns groups TOPOLOGICALLY — trigger first, the step
 * closest to the one being edited last. The panel shows them nearest-first.
 */
const GROUPS = [
    {
        id: 'trg',
        label: 'Trigger',
        kind: 'trigger',
        basePath: 'trigger.output',
        sample: { email: 'a@b.nl' },
        fields: [{ key: 'email', path: 'trigger.output.email', sample: 'a@b.nl' }],
    },
    {
        id: 's1',
        label: 'Gmail search',
        kind: 'integration_action',
        basePath: 'steps.s1.output',
        sample: { results: [{ subject: 'Contract' }], count: 1 },
        fields: [
            { key: 'count', path: 'steps.s1.output.count', sample: 1 },
            {
                key: 'results',
                path: 'steps.s1.output.results',
                sample: [{ subject: 'Contract' }],
                children: [{ key: 'subject', path: 'steps.s1.output.results[*].subject', sample: 'Contract' }],
            },
        ],
    },
];

// A switchable dictionary over the REAL useTranslation, off by default so the
// tests above keep reading the shipped English. Switched on below to prove the
// panel's chrome comes from t() at all: with English defaults a hardcoded
// string and a translated one are indistinguishable.
const { transOverride } = vi.hoisted(() => ({ transOverride: { current: null } }));
vi.mock('../../../../hooks/useTranslation', async (importOriginal) =>
    (await import('@/test/translationOverride')).overrideTranslation(await importOriginal(), transOverride));

/** Search is an icon until clicked (round 4, artboard 4c). */
const openSearch = async (label = 'Search fields') => { await userEvent.click(screen.getByLabelText(label)); };

const renderPanel = (props = {}) => {
    const onPick = vi.fn();
    render(<SourcePanel groups={GROUPS} previewSample={null} onPick={onPick} {...props} />);
    return { onPick };
};

describe('SourcePanel', () => {
    beforeEach(cleanup);

    it('shows the field tree, not a nested table, by default', () => {
        renderPanel();
        // The nearest step is open, so its fields are on screen straight away.
        expect(screen.getByText('Count')).toBeTruthy();
        // OutputView's Table/JSON toggle is the tell-tale of the old view.
        expect(screen.queryByText('JSON')).toBeNull();
    });

    it('lists the nearest step first and opens only that one', () => {
        renderPanel();
        const labels = screen.getAllByText(/Gmail search|Trigger/).map(el => el.textContent);
        expect(labels[0]).toBe('Gmail search');
        // The trigger section is collapsed, so its field is not rendered.
        expect(screen.queryByText('Email')).toBeNull();
        fireEvent.click(screen.getByText('Trigger'));
        expect(screen.getByText('Email')).toBeTruthy();
    });

    it('clicking a field inserts its path', () => {
        const { onPick } = renderPanel();
        fireEvent.click(screen.getByText('Count'));
        expect(onPick).toHaveBeenCalledWith('steps.s1.output.count', { raw: false, source: { root: 'steps', id: 's1', path: ['count'] } });
    });

    it('dragging a field carries BOTH mime types', () => {
        renderPanel();
        const setData = vi.fn();
        fireEvent.dragStart(screen.getByText('Count').parentElement, {
            dataTransfer: { setData, get effectAllowed() { return ''; }, set effectAllowed(_v) {} },
        });
        expect(setData).toHaveBeenCalledWith('text/plain', 'steps.s1.output.count');
        expect(setData).toHaveBeenCalledWith('application/x-binding-path', 'steps.s1.output.count');
    });

    it('dragging the section header carries the whole output path', () => {
        renderPanel();
        const setData = vi.fn();
        fireEvent.dragStart(screen.getByText('Gmail search').parentElement, {
            dataTransfer: { setData, get effectAllowed() { return ''; }, set effectAllowed(_v) {} },
        });
        expect(setData).toHaveBeenCalledWith('application/x-binding-path', 'steps.s1.output');
    });

    it('searching filters across groups and opens what matched', async () => {
        renderPanel();
        await openSearch();
        fireEvent.change(screen.getByLabelText('Search input fields'), { target: { value: 'email' } });
        expect(screen.getByText('Email')).toBeTruthy();
        expect(screen.queryByText('Count')).toBeNull();
        // The Gmail group has no match at all, so it drops out entirely.
        expect(screen.queryByText('Gmail search')).toBeNull();
    });

    it('reports honestly when nothing matches', async () => {
        renderPanel();
        await openSearch();
        fireEvent.change(screen.getByLabelText('Search input fields'), { target: { value: 'zzzz' } });
        expect(screen.getByText('No matches.')).toBeTruthy();
    });

    it('the Table view is one click away and takes over the panel', () => {
        renderPanel();
        fireEvent.click(screen.getByLabelText('Open Gmail search as a table'));
        // OutputView is mounted (its mode toggle appears) and the section list
        // is gone, so there is exactly one scroller.
        expect(screen.getByText('JSON')).toBeTruthy();
        expect(screen.queryByLabelText('Search fields')).toBeNull();
        fireEvent.click(screen.getByText('Fields'));
        expect(screen.getByLabelText('Search fields')).toBeTruthy();
    });

    it('expanding a field keeps the row itself clickable as the parent path', () => {
        const { onPick } = renderPanel();
        const row = screen.getByText('Results').parentElement;
        fireEvent.click(within(row).getByRole('button'));       // the chevron
        expect(screen.getByText('Subject')).toBeTruthy();
        expect(onPick).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText('Results'));            // the row
        expect(onPick).toHaveBeenCalledWith('steps.s1.output.results', expect.objectContaining({ raw: false }));
    });

    it('says so when there is no upstream data at all', () => {
        render(<SourcePanel groups={[]} onPick={vi.fn()} />);
        expect(screen.getByText(/No upstream data yet/)).toBeTruthy();
    });
});

describe('SourcePanel — every word on it comes from the dictionary', () => {
    beforeEach(() => { cleanup(); transOverride.current = null; });

    it('translates the search box and its clear button', async () => {
        transOverride.current = {
            'routines.mapping.search_open': 'Velden zoeken',
            'routines.mapping.search_fields': 'Zoek invoervelden',
            'routines.mapping.clear_search': 'Zoekopdracht wissen',
        };
        renderPanel();
        await openSearch('Velden zoeken');
        const box = screen.getByLabelText('Zoek invoervelden');
        fireEvent.change(box, { target: { value: 'email' } });
        expect(screen.getByLabelText('Zoekopdracht wissen')).toBeTruthy();
    });

    it('translates the empty-result line', async () => {
        transOverride.current = { 'routines.mapping.no_matches': 'Geen treffers.' };
        renderPanel();
        await openSearch();
        fireEvent.change(screen.getByLabelText('Search input fields'), { target: { value: 'zzzz' } });
        expect(screen.getByText('Geen treffers.')).toBeTruthy();
    });

    it('interpolates the base path into the drag tooltip instead of gluing it on', () => {
        transOverride.current = { 'routines.mapping.drag_whole_output': 'Sleep de hele uitvoer ({path})' };
        renderPanel();
        expect(screen.getByTitle(/Sleep de hele uitvoer \(steps\.s1\.output\)/)).toBeTruthy();
    });

    it('interpolates the step name into the Table button, title and label alike', () => {
        transOverride.current = {
            'routines.mapping.open_table': 'Open {label} als tabel',
            'routines.mapping.open_table_title': 'Open {label} als tabel — een hele kolom of één cel',
        };
        renderPanel();
        expect(screen.getByLabelText('Open Gmail search als tabel')).toBeTruthy();
        expect(screen.getByTitle('Open Gmail search als tabel — een hele kolom of één cel')).toBeTruthy();
    });

    it('says "no named fields" as ONE sentence, not three fragments', () => {
        // The <span className="font-medium">Table</span> in the middle was
        // styling. Assembled from fragments the sentence cannot be reordered,
        // so it is one key with the button's own name interpolated.
        transOverride.current = {
            'routines.mapping.no_named_fields': 'Geen velden met een naam — open {table} om uit de ruwe uitvoer te mappen.',
            'routines.mapping.table': 'Tabel',
        };
        render(<SourcePanel
            groups={[{ id: 'raw', label: 'Raw step', kind: 'code', basePath: 'steps.raw.output', sample: [1, 2], fields: [] }]}
            previewSample={null}
            onPick={vi.fn()}
        />);
        expect(screen.getByText('Geen velden met een naam — open Tabel om uit de ruwe uitvoer te mappen.')).toBeTruthy();
    });
});
