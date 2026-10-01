import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ValueChip from './ValueChip';

describe('ValueChip', () => {
    it('shows the label, the list count and the example, and opens the options', async () => {
        const onOpen = vi.fn();
        render(<ValueChip label="Product of all orderregels" count={12} preview="Stoel, Lamp" onOpen={onOpen} />);
        expect(screen.getByText('Product of all orderregels')).toBeInTheDocument();
        expect(screen.getByLabelText('12 values')).toHaveTextContent('· 12');
        expect(screen.getByText('Stoel, Lamp')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Change how Product of all orderregels is used' }));
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('one value has no count badge', () => {
        render(<ValueChip label="E-mail van klant" preview="jan@voorbeeld.nl" />);
        expect(screen.queryByText(/·/)).not.toBeInTheDocument();
        expect(screen.getByTestId('value-chip')).toHaveAttribute('data-state', 'ok');
    });

    it('stale: amber, says what is gone, and offers to pick again', async () => {
        const onRepick = vi.fn();
        render(<ValueChip label="E-mail van klant" state="stale" onRepick={onRepick} />);
        expect(screen.getByTestId('value-chip')).toHaveAttribute('data-state', 'stale');
        expect(screen.getByText('No longer available: E-mail van klant')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Pick again' }));
        expect(onRepick).toHaveBeenCalledTimes(1);
    });

    it('formula: a grey Formula chip with its summary in words', async () => {
        const onOpen = vi.fn();
        render(<ValueChip label="" state="formula" summary="join(‹Orders› , ', ')" onOpen={onOpen} />);
        expect(screen.getByTestId('value-chip')).toHaveAttribute('data-state', 'formula');
        expect(screen.getByText("join(‹Orders› , ', ')")).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Formula' }));
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('remove, and nothing clickable when disabled', async () => {
        const onRemove = vi.fn();
        const { rerender } = render(<ValueChip label="Naam" onRemove={onRemove} onOpen={() => {}} />);
        await userEvent.click(screen.getByRole('button', { name: 'Remove Naam' }));
        expect(onRemove).toHaveBeenCalledTimes(1);
        rerender(<ValueChip label="Naam" onRemove={onRemove} onOpen={() => {}} disabled />);
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
});
