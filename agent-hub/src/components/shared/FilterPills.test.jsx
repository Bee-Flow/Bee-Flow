import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import FilterPills, { FilterPill, PILL_TONES, pillStyle } from './FilterPills';
import { FilterChip } from '../../pages/meeting-notes/library/LibraryFilters';

/**
 * The counted filter capsule (Compliance 1b/1c/1d toolbars, the Meeting
 * Notes rail). Pinned:
 *   - NO ink fill, in any tone, in any state — the artboard's black "Alle 15"
 *     was rejected (2026-09-03); active is a tint;
 *   - neutral active reads as ON: primary text and border on a bg-tertiary
 *     tint (the old grey-accent tint measured about 2.4:1 and looked
 *     disabled); the Meeting Notes rail's FilterChip is this same pill;
 *   - toned pills: raw border + ink text, active adds a 14 % tint of the raw
 *     and a 1.5px border, so the selection does not rest on colour alone;
 *   - `checked` draws a Check glyph for a multi-select pill;
 *   - the count renders only when the caller counted (undefined → nothing,
 *     an explicit 0 → "0");
 *   - the group is a role=group of aria-pressed buttons; onChange gets the
 *     option's value.
 */

const OPTIONS = [
    { value: 'all', label: 'All', count: 15 },
    { value: 'fail', label: 'Failing', count: 1, tone: 'error' },
    { value: 'warn', label: 'Needs attention', count: 4, tone: 'warning' },
    { value: 'pass', label: 'Passing', count: 9, tone: 'success' },
    { value: 'na', label: 'N/A', count: 1, tone: 'muted' },
];

const INK_FILL = /var\(--text-primary\)/;

describe('FilterPill — recipes', () => {
    it('neutral inactive: transparent, hairline border, secondary text, tertiary count', () => {
        render(<FilterPill label="All" count={15} testId="p" />);
        const p = screen.getByTestId('p');
        expect(p.style.background).toBe('transparent');
        expect(p.style.borderColor).toBe('var(--border-default)');
        expect(p.style.color).toBe('var(--text-secondary)');
        expect(within(p).getByText('15').style.color).toBe('var(--text-tertiary)');
        expect(p.getAttribute('aria-pressed')).toBe('false');
    });

    it('neutral active: primary text and border on a bg-tertiary tint, count in secondary', () => {
        render(<FilterPill label="All" count={15} active testId="p" />);
        const p = screen.getByTestId('p');
        expect(p.style.background).toBe('var(--bg-tertiary)');
        expect(p.style.borderColor).toBe('var(--text-primary)');
        expect(p.style.color).toBe('var(--text-primary)');
        expect(within(p).getByText('15').style.color).toBe('var(--text-secondary)');
        expect(p.getAttribute('aria-pressed')).toBe('true');
        // Neutral keeps the 1px border; the colour change is already strong.
        expect(p.className).toMatch(/\bborder px-2 py-0\.5\b/);
    });

    it('toned inactive: raw border, ink text — the artboard\'s "Niet in orde 1"', () => {
        render(<FilterPill label="Failing" count={1} tone="error" testId="p" />);
        const p = screen.getByTestId('p');
        expect(p.style.background).toBe('transparent');
        expect(p.style.borderColor).toBe('var(--error)');
        expect(p.style.color).toBe('var(--error-ink)');
        expect(within(p).getByText('1').style.color).toBe('var(--error-ink)');
    });

    it('toned active: same border and ink over a 14 % tint of the raw tone, the border 1.5px at the same size', () => {
        const { rerender } = render(<FilterPill label="Failing" count={1} tone="error" active testId="p" />);
        let p = screen.getByTestId('p');
        expect(p.style.background).toBe('color-mix(in srgb, var(--error) 14%, transparent)');
        expect(p.style.borderColor).toBe('var(--error)');
        expect(p.style.color).toBe('var(--error-ink)');
        expect(p.className).toContain('border-[1.5px] px-[7.5px] py-[1.5px]');
        rerender(<FilterPill label="Failing" count={1} tone="error" testId="p" />);
        expect(screen.getByTestId('p').className).toMatch(/\bborder px-2 py-0\.5\b/);
        rerender(<FilterPill label="Failing" count={1} tone="error" active testId="p" />);
        rerender(<FilterPill label="Needs attention" count={4} tone="warning" active testId="p" />);
        p = screen.getByTestId('p');
        expect(p.style.background).toBe('color-mix(in srgb, var(--warning) 14%, transparent)');
        expect(p.style.color).toBe('var(--warning-ink)');
        rerender(<FilterPill label="Approved" count={9} tone="success" active testId="p" />);
        p = screen.getByTestId('p');
        expect(p.style.background).toBe('color-mix(in srgb, var(--success) 14%, transparent)');
        expect(p.style.borderColor).toBe('var(--success)');
        expect(p.style.color).toBe('var(--success-ink)');
    });

    it('muted: tertiary text and hairline; active fills with bg-tertiary', () => {
        const { rerender } = render(<FilterPill label="N/A" count={1} tone="muted" testId="p" />);
        let p = screen.getByTestId('p');
        expect(p.style.background).toBe('transparent');
        expect(p.style.color).toBe('var(--text-tertiary)');
        expect(p.style.borderColor).toBe('var(--border-default)');
        rerender(<FilterPill label="N/A" count={1} tone="muted" active testId="p" />);
        p = screen.getByTestId('p');
        expect(p.style.background).toBe('var(--bg-tertiary)');
        expect(p.style.color).toBe('var(--text-tertiary)');
    });

    it('checked: a Check glyph before the label (multi-select); aria-pressed still carries the state', () => {
        const { rerender } = render(<FilterPill label="Consent" active checked testId="p" />);
        let p = screen.getByTestId('p');
        const glyph = p.firstElementChild;
        expect(glyph.tagName.toLowerCase()).toBe('svg');
        expect(glyph.getAttribute('aria-hidden')).toBe('true');
        expect(glyph.getAttribute('width')).toBe('11');
        expect(p.dataset.checked).toBe('true');
        expect(p.getAttribute('aria-pressed')).toBe('true');
        expect(p).toHaveAccessibleName('Consent');
        rerender(<FilterPill label="Consent" testId="p" />);
        p = screen.getByTestId('p');
        expect(p.querySelector('svg')).toBeNull();
        expect(p.dataset.checked).toBeUndefined();
        expect(p.getAttribute('aria-pressed')).toBe('false');
    });

    it('focus ring: the theme focus token, not the grey accent', () => {
        render(<FilterPill label="All" testId="p" />);
        // An outline with a 2px gap, so it never merges with a toned border.
        expect(screen.getByTestId('p').className).toContain('focus-visible:outline-[var(--focus-ring)]');
        expect(screen.getByTestId('p').className).toContain('focus-visible:outline-offset-2');
        expect(screen.getByTestId('p').className).not.toContain('accent-primary');
    });

    it('never fills with ink: no var(--text-primary) background in any tone, active or not', () => {
        for (const tone of PILL_TONES) {
            for (const active of [false, true]) {
                const s = pillStyle(tone, active);
                expect(s.background).not.toMatch(INK_FILL);
                expect(s.background).not.toMatch(/#[0-9a-f]{3,8}/i);
            }
        }
        render(<FilterPills value="all" onChange={() => {}} options={OPTIONS} testId="g" />);
        for (const b of screen.getAllByRole('button')) expect(b.style.background).not.toMatch(INK_FILL);
    });

    it('an unknown tone falls back to neutral', () => {
        render(<FilterPill label="x" tone="cyan" testId="p" />);
        expect(screen.getByTestId('p').dataset.tone).toBe('neutral');
        expect(screen.getByTestId('p').style.color).toBe('var(--text-secondary)');
    });

    it('count: undefined or null renders nothing, an explicit 0 renders "0", in tabular figures after the label', () => {
        const { rerender } = render(<FilterPill label="All" testId="p" />);
        expect(screen.getByTestId('p').textContent).toBe('All');
        expect(screen.getByTestId('p').children.length).toBe(1);
        rerender(<FilterPill label="All" count={null} testId="p" />);
        expect(screen.getByTestId('p').children.length).toBe(1);
        rerender(<FilterPill label="All" count={0} testId="p" />);
        const p = screen.getByTestId('p');
        expect(p.textContent).toBe('All0');
        expect(p.lastElementChild.className).toMatch(/\btabular-nums\b/);
        expect(p.lastElementChild.textContent).toBe('0');
    });

    it('is the 11px rounded-full capsule, truncating a long label', () => {
        render(<FilterPill label="A very long filter name" testId="p" />);
        const p = screen.getByTestId('p');
        expect(p.tagName).toBe('BUTTON');
        expect(p.getAttribute('type')).toBe('button');
        expect(p.className).toMatch(/\brounded-full text-\[11px\] font-medium\b/);
        expect(p.className).toMatch(/\bborder px-2 py-0\.5\b/);
        expect(p.firstElementChild.className).toBe('truncate max-w-[9rem]');
    });

    it('disabled pills do not fire', async () => {
        const user = userEvent.setup();
        const onClick = vi.fn();
        render(<FilterPill label="x" onClick={onClick} disabled testId="p" />);
        await user.click(screen.getByTestId('p'));
        expect(onClick).not.toHaveBeenCalled();
        expect(screen.getByTestId('p')).toBeDisabled();
    });

    it('LibraryFilters still exports FilterChip, and it IS the shared FilterPill', () => {
        expect(FilterChip).toBe(FilterPill);
    });
});

describe('FilterPills — the group', () => {
    it('is a role=group of aria-pressed buttons, the active one matching value', () => {
        render(<FilterPills value="warn" onChange={() => {}} options={OPTIONS} ariaLabel="Status" testId="g" />);
        const group = screen.getByRole('group', { name: 'Status' });
        const buttons = within(group).getAllByRole('button');
        expect(buttons.length).toBe(OPTIONS.length);
        expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false', 'false']);
        expect(screen.getByTestId('g-warn').dataset.tone).toBe('warning');
        expect(screen.getByTestId('g-all').dataset.tone).toBe('neutral');
    });

    it('onChange receives the option\'s value', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<FilterPills value="all" onChange={onChange} options={OPTIONS} testId="g" />);
        await user.click(screen.getByTestId('g-fail'));
        expect(onChange).toHaveBeenCalledWith('fail');
        await user.click(screen.getByTestId('g-all'));
        expect(onChange).toHaveBeenCalledWith('all');
    });

    it('renders the counts the caller passed and nothing for the ones it did not', () => {
        render(<FilterPills value="all" onChange={() => {}} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B', count: 3 }]} testId="g" />);
        expect(screen.getByTestId('g-a').textContent).toBe('A');
        expect(screen.getByTestId('g-b').textContent).toBe('B3');
    });

    it('an empty options list is an empty group, not a crash', () => {
        render(<FilterPills value={null} onChange={() => {}} options={[]} testId="g" />);
        expect(screen.getByTestId('g').children.length).toBe(0);
    });
});
