/**
 * Editors of the customer-story blocks: the four-figure cap, the add button,
 * and the URL form of the sector.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';

import { StoryHeaderEditor } from './StoryHeaderEditor';
import { CustomerStoriesEditor, cleanSectorId } from './CustomerStoriesEditor';

const metric = (n: number) => ({ stat: `${n}%`, label: `m${n}` });

describe('StoryHeaderEditor', () => {
    it('adds an empty figure below the cap', async () => {
        const onChange = vi.fn();
        render(<StoryHeaderEditor data={{ metrics: [metric(1), metric(2)] }} onChange={onChange} />);
        await userEvent.click(screen.getByRole('button', { name: /Add figure/ }));
        expect(onChange.mock.calls[0][0].metrics).toHaveLength(3);
    });

    it('stops offering "Add figure" at four', () => {
        render(<StoryHeaderEditor data={{ metrics: [1, 2, 3, 4].map(metric) }} onChange={() => {}} />);
        expect(screen.queryByRole('button', { name: /Add figure/ })).toBeNull();
    });

    it('asks for a second figure while there is one', () => {
        render(<StoryHeaderEditor data={{ metrics: [metric(1)] }} onChange={() => {}} />);
        expect(screen.getByText(/at least two figures/)).toBeInTheDocument();
    });
});

describe('CustomerStoriesEditor', () => {
    it('clamps the limit and writes the sector in its URL form', async () => {
        const onChange = vi.fn();
        render(<CustomerStoriesEditor data={{ limit: 6 }} onChange={onChange} />);
        const sector = screen.getByPlaceholderText('e.g. public-sector');
        await userEvent.type(sector, 'P');
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sectorId: 'p' }));
        expect(cleanSectorId('Public Sector!')).toBe('public-sector-');
    });
});
