/**
 * Unit — behavior pins for the shared CMS micro-widgets in ./primitives:
 * PxSizeInput's 0/empty="inherit" semantics, ColorSwatch's complete-hex
 * commit rule, SegmentedControl selection, CollapsibleCard's localStorage
 * persistence (cms.ui.card.<persistKey>), and FieldSelect's hint line.
 *
 * Run: cd agent-hub && npx vitest run src/components/admin/ProductWebsite/primitives.test.jsx
 */
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    CollapsibleCard,
    ColorSwatch,
    PxSizeInput,
    SegmentedControl,
    FieldSelect,
} from './primitives';

beforeEach(() => {
    localStorage.clear();
});

describe('PxSizeInput', () => {
    it('renders 0 as an empty field with the "inherit" placeholder', () => {
        render(<PxSizeInput value={0} onChange={() => {}} ariaLabel="Title size" />);
        const input = screen.getByLabelText('Title size');
        expect(input).toHaveValue(null);
        expect(input).toHaveAttribute('placeholder', 'inherit');
    });

    it('shows a positive value and commits edits as numbers', () => {
        const onChange = vi.fn();
        render(<PxSizeInput value={24} onChange={onChange} ariaLabel="Title size" />);
        const input = screen.getByLabelText('Title size');
        expect(input).toHaveValue(24);
        fireEvent.change(input, { target: { value: '32' } });
        expect(onChange).toHaveBeenCalledWith(32);
    });

    it('commits 0 (= inherit) when the field is cleared', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<PxSizeInput value={24} onChange={onChange} ariaLabel="Title size" />);
        await user.clear(screen.getByLabelText('Title size'));
        expect(onChange).toHaveBeenCalledWith(0);
    });
});

describe('ColorSwatch', () => {
    it('does not commit partial hex values, only a complete #RRGGBB', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<ColorSwatch value="" onChange={onChange} title="Badge color" />);
        const hexInput = screen.getByLabelText('Badge color hex');

        await user.clear(hexInput);
        await user.type(hexInput, '#F3');
        expect(onChange).not.toHaveBeenCalled();
        // Partial input is kept locally so the user can keep typing.
        expect(hexInput).toHaveValue('#F3');

        await user.clear(hexInput);
        await user.type(hexInput, '#F3A612');
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith('#F3A612');
    });

    it('prefixes a missing # and strips non-hex characters', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<ColorSwatch value="" onChange={onChange} title="Badge color" />);
        await user.clear(screen.getByLabelText('Badge color hex'));
        await user.type(screen.getByLabelText('Badge color hex'), '12ab34');
        expect(onChange).toHaveBeenCalledWith('#12ab34');
    });
});

describe('SegmentedControl', () => {
    it('fires onChange with the clicked option value', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(
            <SegmentedControl
                options={[{ value: 'list', label: 'List' }, { value: 'columns', label: 'Columns' }]}
                value="list"
                onChange={onChange}
            />
        );
        await user.click(screen.getByText('Columns'));
        expect(onChange).toHaveBeenCalledWith('columns');
    });
});

describe('CollapsibleCard', () => {
    it('round-trips open state through localStorage when persistKey is set', async () => {
        const user = userEvent.setup();
        const { unmount } = render(
            <CollapsibleCard title="Badge" persistKey="blk.hero.badge">
                <div>Inner content</div>
            </CollapsibleCard>
        );
        // Defaults closed (defaultOpen defaults to false).
        expect(screen.queryByText('Inner content')).toBeNull();

        await user.click(screen.getByRole('button', { name: /Badge/ }));
        expect(screen.getByText('Inner content')).toBeInTheDocument();
        expect(localStorage.getItem('cms.ui.card.blk.hero.badge')).toBe('1');

        // Fresh mount reads the stored state lazily.
        unmount();
        render(
            <CollapsibleCard title="Badge" persistKey="blk.hero.badge">
                <div>Inner content</div>
            </CollapsibleCard>
        );
        expect(screen.getByText('Inner content')).toBeInTheDocument();

        // Closing writes back too.
        await user.click(screen.getByRole('button', { name: /Badge/ }));
        expect(localStorage.getItem('cms.ui.card.blk.hero.badge')).toBe('0');
    });

    it('stored state wins over defaultOpen', () => {
        localStorage.setItem('cms.ui.card.blk.hero.mockup', '0');
        render(
            <CollapsibleCard title="Mockup" defaultOpen={true} persistKey="blk.hero.mockup">
                <div>Mockup body</div>
            </CollapsibleCard>
        );
        expect(screen.queryByText('Mockup body')).toBeNull();
    });

    it('without persistKey it is plain local state and writes nothing', async () => {
        const user = userEvent.setup();
        render(
            <CollapsibleCard title="Plain" defaultOpen={true}>
                <div>Plain body</div>
            </CollapsibleCard>
        );
        expect(screen.getByText('Plain body')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /Plain/ }));
        expect(screen.queryByText('Plain body')).toBeNull();
        expect(localStorage.length).toBe(0);
    });
});

describe('FieldSelect', () => {
    it('renders the optional hint line', () => {
        render(
            <FieldSelect
                label="Style"
                value="primary"
                onChange={() => {}}
                options={[{ value: 'primary', label: 'Primary (filled)' }]}
                hint="Empty = inherit"
            />
        );
        expect(screen.getByText('Empty = inherit')).toBeInTheDocument();
    });

    it('omits the hint node when not provided', () => {
        render(
            <FieldSelect
                label="Style"
                value="primary"
                onChange={() => {}}
                options={[{ value: 'primary', label: 'Primary (filled)' }]}
            />
        );
        expect(screen.queryByText('Empty = inherit')).toBeNull();
    });
});
