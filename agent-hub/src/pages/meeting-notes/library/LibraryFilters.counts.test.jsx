import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import LibraryFilters, { VISIBLE_TAGS } from './LibraryFilters';

/**
 * The rail's filter row (Meeting Notes artboard 1a, line 31):
 *
 *   Alles · van mij · gedeeld · dataweging 4 · spelersmonitor 3 · +9 tags
 *
 * Two things are easy to get wrong and both strand the user:
 *   - the counts must come from the SERVER vocabulary handed in as
 *     `[{tag,count}]` — the loaded rows are one page of 50;
 *   - a SELECTED tag must stay visible however unpopular it is, or the only
 *     way to switch the filter off is a page reload.
 */

const TAGS = [
    { tag: 'dataweging', count: 4 },
    { tag: 'spelersmonitor', count: 3 },
    { tag: 'workflow', count: 3 },
    { tag: 'rapportage', count: 2 },
    { tag: 'knltb', count: 2 },
    { tag: 'offerte', count: 1 },
    { tag: 'zeldzaam', count: 1 },
];

function setup(props = {}) {
    const onTagChange = vi.fn();
    const onOwnerChange = vi.fn();
    const onQueryChange = vi.fn();
    const onSortChange = vi.fn();
    const utils = render(
        <LibraryFilters
            query=""
            onQueryChange={onQueryChange}
            sort="recent"
            onSortChange={onSortChange}
            owner="all"
            onOwnerChange={onOwnerChange}
            tag={null}
            onTagChange={onTagChange}
            tags={TAGS}
            currentUserId="u1"
            {...props}
        />,
    );
    return { ...utils, onTagChange, onOwnerChange, onQueryChange, onSortChange };
}

/** The chip button for a tag, whatever its count node. */
function chip(name) {
    return screen.getAllByRole('button').find((b) => b.textContent.startsWith(name));
}

describe('LibraryFilters — counted tag chips', () => {
    it('shows each tag with its count next to the label', () => {
        setup();
        const dataweging = chip('dataweging');
        expect(dataweging).toBeTruthy();
        expect(within(dataweging).getByText('4')).toBeTruthy();
        expect(within(chip('spelersmonitor')).getByText('3')).toBeTruthy();
    });

    it('folds everything past the first five behind one "+N tags" chip', () => {
        setup();
        expect(chip('zeldzaam')).toBeFalsy();
        const more = screen.getByTestId('meetings-more-tags');
        expect(more.textContent).toBe(`+${TAGS.length - VISIBLE_TAGS} tags`);

        fireEvent.click(more);
        expect(chip('zeldzaam')).toBeTruthy();
        // …and folds back, so a long vocabulary does not eat the rail.
        fireEvent.click(screen.getByRole('button', { name: /fewer tags/i }));
        expect(chip('zeldzaam')).toBeFalsy();
    });

    it('keeps a selected but unpopular tag visible so it can be switched off', () => {
        const { onTagChange } = setup({ tag: 'zeldzaam' });
        const selected = chip('zeldzaam');
        expect(selected).toBeTruthy();
        expect(selected.getAttribute('aria-pressed')).toBe('true');

        fireEvent.click(selected);
        expect(onTagChange).toHaveBeenCalledWith(null);
    });

    it('clicking an unselected tag filters by it', () => {
        const { onTagChange } = setup();
        fireEvent.click(chip('dataweging'));
        expect(onTagChange).toHaveBeenCalledWith('dataweging');
    });

    it('orders by count, then alphabetically, whatever order the server sent', () => {
        setup({
            tags: [
                { tag: 'beta', count: 1 },
                { tag: 'alpha', count: 1 },
                { tag: 'top', count: 9 },
            ],
        });
        const labels = screen.getAllByRole('button')
            .map((b) => b.textContent)
            .filter((txt) => /^(top|alpha|beta)/.test(txt));
        expect(labels[0].startsWith('top')).toBe(true);
        expect(labels[1].startsWith('alpha')).toBe(true);
        expect(labels[2].startsWith('beta')).toBe(true);
    });

    it('no vocabulary yet → the owner chips still work, no empty chip row', () => {
        const { onOwnerChange } = setup({ tags: [] });
        expect(screen.queryByTestId('meetings-more-tags')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Mine' }));
        expect(onOwnerChange).toHaveBeenCalledWith('mine');
    });

    it('hides the mine/shared chips for an anonymous caller (no user id)', () => {
        setup({ currentUserId: null });
        expect(screen.queryByRole('button', { name: 'Mine' })).toBeNull();
        expect(screen.getByRole('button', { name: 'All' })).toBeTruthy();
    });

    it('renders the view switch the page hands in, between search and chips', () => {
        setup({ viewSwitch: <div data-testid="view-switch" /> });
        expect(screen.getByTestId('view-switch')).toBeTruthy();
    });

    it('search reports every keystroke to the page', () => {
        const { onQueryChange } = setup();
        fireEvent.change(screen.getByLabelText(/search meetings/i), { target: { value: 'knltb' } });
        expect(onQueryChange).toHaveBeenCalledWith('knltb');
    });
});
