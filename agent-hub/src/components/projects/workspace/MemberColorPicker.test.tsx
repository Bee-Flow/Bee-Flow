import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import MemberColorPicker from './MemberColorPicker';
import { inkOf, MEMBER_COLORS, personColor, washOf } from './memberColors';

const base = { name: 'Jan Test', color: '#3b82f6' };

describe('MemberColorPicker', () => {
    it('lets whoever may change it choose one of the project colours', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<MemberColorPicker {...base} canChange onChange={onChange} />);
        await user.click(screen.getByTestId('member-colour-button'));
        expect(await screen.findAllByRole('menuitemradio')).toHaveLength(MEMBER_COLORS.length);
        await user.click(screen.getByTestId('member-colour-22c55e'));
        expect(onChange).toHaveBeenCalledWith('#22c55e');
    });

    it('marks the colour the person has, and offers Automatic only when they have chosen one', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const { rerender } = render(<MemberColorPicker {...base} chosen="#3b82f6" canChange onChange={onChange} />);
        await user.click(screen.getByTestId('member-colour-button'));
        expect(screen.getByTestId('member-colour-3b82f6')).toHaveAttribute('aria-checked', 'true');
        await user.click(screen.getByTestId('member-colour-auto'));
        expect(onChange).toHaveBeenCalledWith(null);
        rerender(<MemberColorPicker {...base} canChange onChange={onChange} />);
        await user.click(screen.getByTestId('member-colour-button'));
        expect(screen.getByTestId('member-colour-auto')).toBeDisabled();
    });

    it('is only a dot for someone who may not change it', () => {
        render(<MemberColorPicker {...base} canChange={false} onChange={vi.fn()} />);
        expect(screen.getByTestId('member-colour-static')).toBeInTheDocument();
        expect(screen.queryByTestId('member-colour-button')).not.toBeInTheDocument();
    });
});

describe('a person\'s colour', () => {
    it('is the one the project gave them, else one from their name that stays the same', () => {
        expect(personColor('#22C55E', 'Jan')).toBe('#22C55E');
        expect(personColor('#22c55e', 'Jan')).toBe('#22c55e');
        expect(personColor(undefined, 'Jan Test')).toBe(personColor(null, 'Jan Test'));
        expect(personColor(undefined, 'Jan Test')).toMatch(/^hsl\(\d+ 60% 50%\)$/);
        // Only the project's colours are painted: anything else is the automatic one.
        expect(personColor('red; background:url(x)', 'Jan Test')).toMatch(/^hsl\(/);
    });

    it('is only ever a wash or a lean towards the theme\'s ink', () => {
        expect(washOf('#3b82f6', 8)).toBe('color-mix(in srgb, #3b82f6 8%, transparent)');
        expect(inkOf('#3b82f6')).toContain('var(--text-primary)');
    });
});
