/**
 * The destination pill on an action card (plan M3, artboard 1a).
 *
 * The picker's own behaviour lives in DestinationPicker.test.jsx; what is
 * pinned here is where the pill appears at all — and, above everything else,
 * WHO gets to see one.
 */
import { render, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import ActionItemsList from './ActionItemsList';

const meeting = { id: 'm-1', title: 'Weekly sync', createdAt: '2026-07-27T09:30:00.000Z' };

const items = [
    {
        id: 'ai-0', text: 'Filter inbouwen vóór de weging', assignee: 'Tom', timestamp: '18:23', source: 'ai',
        destination: { kind: 'automation', ref: 'a-1', label: 'Weging', at: '2026-07-27T10:00:00.000Z' },
    },
    { id: 'u-42', text: 'Morgen contact over de voortgang', source: 'user' },
];

const row = (text) => screen.getByText(text).closest('li');

describe('ActionItemsList — destination pill', () => {
    it('invites the owner to pick one on an action that has none', () => {
        render(<ActionItemsList items={items} meeting={meeting} onSetDestination={vi.fn()} />);
        const chip = within(row('Morgen contact over de voortgang')).getByTestId('action-destination-chip');
        expect(chip.textContent).toContain('Pick a destination');
    });

    it('names the destination an action already has', () => {
        render(<ActionItemsList items={items} meeting={meeting} onSetDestination={vi.fn()} />);
        const chip = within(row('Filter inbouwen vóór de weging')).getByTestId('action-destination-chip');
        expect(chip.textContent).toContain('Start: Weging');
    });

    /**
     * THE BITE.
     *
     * A destination names an automation, a table or a knowledge base that lives in
     * the OWNER's workspace. A published meeting note is read by colleagues who
     * may hold nothing in any of the three — and "Row in table Salarissen" is
     * the whole leak, whether or not the pill is clickable. So a reader who
     * cannot set one does not get to read one either: the same narrowing the
     * server already makes for Used-by rows, where `redactForeign` withholds
     * the TITLE of anything owned by someone else.
     *
     * Rendering the pill read-only "because it is only a label" is exactly the
     * change this assertion has to stop.
     */
    it('shows a reader NO destination at all — not even a read-only one', () => {
        render(<ActionItemsList items={items} meeting={meeting} />);
        expect(screen.queryAllByTestId('action-destination-chip')).toHaveLength(0);
        expect(screen.queryByText(/Weging/)).toBeNull();
        // The actions themselves are still readable — this narrows the link,
        // not the note.
        expect(screen.getByText('Filter inbouwen vóór de weging')).toBeTruthy();
    });

    it('leaves the avatar, the seek jump and the deadline exactly where they were', () => {
        const onSeek = vi.fn();
        render(<ActionItemsList
            items={[{ id: 'ai-0', text: 'Testen', assignee: 'Tom', timestamp: '18:23', due: '2026-07-28' }]}
            meeting={meeting}
            onSeek={onSeek}
            onSetDestination={vi.fn()}
        />);
        const li = row('Testen');
        expect(within(li).getByText('Tom')).toBeTruthy();
        expect(within(li).getByText('18:23')).toBeTruthy();
        expect(within(li).getByText('2026-07-28')).toBeTruthy();
        expect(within(li).getByTestId('action-destination-chip')).toBeTruthy();
    });
});
