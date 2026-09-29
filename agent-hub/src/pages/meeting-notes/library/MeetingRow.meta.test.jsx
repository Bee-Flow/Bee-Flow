import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MeetingRow, { actionsPhrase } from './MeetingRow';

/**
 * One row of the 300px rail (Meeting Notes artboard 1a, line 33):
 *
 *   [32px kind-meet tile]  Update Bee Flow KNLTB
 *                          27 jul · 1:01 · 14 acties open
 *
 * The third part of that meta line reads the SERVER's list aggregates
 * (transcriptionStore LIST_AGGREGATES → actionsTotal / actionsOpen /
 * failureReason). A list row never carries `action_items`, so a row that
 * counted them client-side always said "0 open".
 */

const t = (key, fallback, vars) => String(fallback).replace(/\{(\w+)\}/g, (_, k) => (vars?.[k] ?? ''));

const BASE = {
    id: 'm1',
    title: 'Update Bee Flow KNLTB',
    createdAt: '2026-07-27T09:00:00.000Z',
    durationSeconds: 3660,
    status: 'completed',
};

const meta = () => screen.getByTestId('meeting-row-meta').textContent;

describe('MeetingRow meta line', () => {
    it('date · duration · open actions, from the list aggregates', () => {
        render(<MeetingRow meeting={{ ...BASE, actionsTotal: 16, actionsOpen: 14 }} onClick={() => {}} />);
        expect(meta()).toContain('14 actions open');
        expect(meta()).toContain('1:01');
    });

    it('says "all done" when every action is ticked, and nothing when there are none', () => {
        const { rerender } = render(<MeetingRow meeting={{ ...BASE, actionsTotal: 3, actionsOpen: 0 }} onClick={() => {}} />);
        expect(meta()).toContain('all done');

        rerender(<MeetingRow meeting={{ ...BASE, actionsTotal: 0, actionsOpen: 0 }} onClick={() => {}} />);
        expect(meta()).not.toContain('all done');
        expect(meta()).not.toContain('actions');
    });

    it('a failed note shows WHY, from failureReason — not a summary that is not one', () => {
        render(
            <MeetingRow
                meeting={{ ...BASE, status: 'failed', failureReason: 'Transcription failed: audio too short' }}
                onClick={() => {}}
            />,
        );
        expect(meta()).toContain('audio too short');
        // The stored prefix is noise in a 300px rail.
        expect(meta()).not.toContain('Transcription failed:');
    });

    it('a failed note with no reason still says it failed', () => {
        expect(actionsPhrase({ status: 'failed' }, t)).toBe('transcription failed');
    });

    it('a processing note says so instead of counting actions it does not have yet', () => {
        expect(actionsPhrase({ status: 'processing', actionsTotal: 4, actionsOpen: 4 }, t)).toBe('transcribing…');
    });

    it('paints the selected row with the meeting kind colour, not a hard-coded one', () => {
        const { container, rerender } = render(<MeetingRow meeting={BASE} active onClick={() => {}} />);
        const tile = container.querySelector('.w-8.h-8');
        expect(tile.getAttribute('style')).toContain('var(--kind-meet)');

        rerender(<MeetingRow meeting={BASE} active={false} onClick={() => {}} />);
        expect(container.querySelector('.w-8.h-8').getAttribute('style')).toContain('var(--bg-tertiary)');
    });

    it('marks the selected row for assistive tech and reports clicks', () => {
        const onClick = vi.fn();
        render(<MeetingRow meeting={BASE} active onClick={onClick} />);
        const row = screen.getByTestId('meeting-row');
        expect(row.getAttribute('aria-current')).toBe('true');
        fireEvent.click(row);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('a shared note carries a labelled share glyph, never a bare icon', () => {
        render(<MeetingRow meeting={{ ...BASE, isPublished: true, sharedGroups: ['g1', 'g2'] }} onClick={() => {}} />);
        expect(screen.getByLabelText('Shared with 2 groups')).toBeTruthy();
    });
});
