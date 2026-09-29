import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import SegmentedControl, { resolveSegmentedBadge } from './SegmentedControl';

const OPTIONS = [
    { value: 'simple', label: 'Simple' },
    { value: 'advanced', label: 'All options' },
] as const;

describe('SegmentedControl', () => {
    it('is a radiogroup named by ariaLabel, with aria-checked on the active radio', () => {
        render(
            <SegmentedControl
                value="simple"
                onChange={() => {}}
                options={OPTIONS}
                ariaLabel="How much of this step to show"
            />,
        );
        const group = screen.getByRole('radiogroup', { name: 'How much of this step to show' });
        expect(group).toBeTruthy();
        expect(screen.getByRole('radio', { name: 'Simple' }).getAttribute('aria-checked')).toBe('true');
        expect(screen.getByRole('radio', { name: 'All options' }).getAttribute('aria-checked')).toBe('false');
    });

    it('reports the picked value through onChange', () => {
        const onChange = vi.fn();
        render(<SegmentedControl value="simple" onChange={onChange} options={OPTIONS} />);
        fireEvent.click(screen.getByRole('radio', { name: 'All options' }));
        expect(onChange).toHaveBeenCalledWith('advanced');
    });

    it('inactive segments read as available choices, not disabled ones', () => {
        // --text-tertiary is the caption tier; an inactive-but-clickable
        // segment must sit at least at --text-secondary or it reads as
        // switched off next to the active pill.
        render(<SegmentedControl value="simple" onChange={() => {}} options={OPTIONS} />);
        const inactive = screen.getByRole('radio', { name: 'All options' });
        const active = screen.getByRole('radio', { name: 'Simple' });
        expect(inactive.style.color).toBe('var(--text-secondary)');
        expect(active.style.color).toBe('var(--text-primary)');
    });

    it('a disabled option cannot be picked', () => {
        const onChange = vi.fn();
        render(
            <SegmentedControl
                value="simple"
                onChange={onChange}
                options={[OPTIONS[0], { ...OPTIONS[1], disabled: true }]}
            />,
        );
        const opt = screen.getByRole('radio', { name: 'All options' }) as HTMLButtonElement;
        expect(opt.disabled).toBe(true);
        fireEvent.click(opt);
        expect(onChange).not.toHaveBeenCalled();
    });
});

/**
 * The count after a tab label — "Used by 3", "Rows 412", "Review 2". Studio
 * Home artboard 1b draws it as `Gebruikt door <span style="color:
 * var(--text-tertiary)">n</span>`: the label's own size and weight, only
 * dimmer. Not the rounded chip shared/Tabs wears.
 */
describe('SegmentedControl — badge', () => {
    it('renders a bare count after the label as a dimmer inline span', () => {
        render(
            <SegmentedControl
                value="usage"
                onChange={() => {}}
                options={[
                    { value: 'columns', label: 'Columns' },
                    { value: 'usage', label: 'Used by', badge: 3 },
                ]}
            />,
        );
        const radio = screen.getByRole('radio', { name: /Used by/ });
        const count = within(radio).getByText('3');
        expect(count.style.color).toBe('var(--text-tertiary)');
        // Label first, count after it — "Used by 3", never "3 Used by".
        expect(count.previousElementSibling?.textContent).toBe('Used by');
        expect(radio.lastElementChild).toBe(count);
    });

    it('takes the status colour for error and warning tones, tertiary for neutral', () => {
        // Solutions 1a colours "Controle 2" in --error: a count that is a
        // problem wears the problem's colour; a plain count stays a caption.
        render(
            <SegmentedControl
                value="review"
                onChange={() => {}}
                options={[
                    { value: 'review', label: 'Review', badge: { count: 2, tone: 'error' } },
                    { value: 'drafts', label: 'Drafts', badge: { count: 1, tone: 'warning' } },
                    { value: 'rows', label: 'Rows', badge: { count: 412 } },
                ]}
            />,
        );
        const badgeOf = (name: RegExp, text: string) =>
            within(screen.getByRole('radio', { name })).getByText(text);
        expect(badgeOf(/Review/, '2').style.color).toBe('var(--error)');
        expect(badgeOf(/Drafts/, '1').style.color).toBe('var(--warning)');
        expect(badgeOf(/Rows/, '412').style.color).toBe('var(--text-tertiary)');
        expect(badgeOf(/Review/, '2').getAttribute('data-tone')).toBe('error');
        expect(badgeOf(/Rows/, '412').getAttribute('data-tone')).toBe('neutral');
    });

    it('renders nothing at all when the badge is absent or null — the label IS the textContent', () => {
        // BuilderHeader.views.test.jsx pins its four view labels via
        // textContent; a strip without counts must not grow an empty span,
        // and a count still loading must not show up as "0".
        render(
            <SegmentedControl
                value="build"
                onChange={() => {}}
                options={[
                    { value: 'build', label: 'Editor' },
                    { value: 'settings', label: 'Settings', badge: null },
                    { value: 'runs', label: 'Runs', badge: { count: null } },
                    { value: 'versions', label: 'Versions', badge: { count: undefined, tone: 'error' } },
                ]}
            />,
        );
        for (const label of ['Editor', 'Settings', 'Runs', 'Versions']) {
            const radio = screen.getByRole('radio', { name: label });
            expect(radio.textContent).toBe(label);
            expect(radio.querySelectorAll('span')).toHaveLength(1);
        }
    });

    it('a count of 0 is an answer, not an absence', () => {
        // "Used by 0" tells the owner the table is safe to delete; hiding the
        // number would make that tab look like it never loaded.
        render(
            <SegmentedControl
                value="usage"
                onChange={() => {}}
                options={[{ value: 'usage', label: 'Used by', badge: 0 }]}
            />,
        );
        expect(within(screen.getByRole('radio', { name: /Used by/ })).getByText('0')).toBeTruthy();
    });

    it('resolveSegmentedBadge normalises both shapes for callers that fold the strip into a menu', () => {
        expect(resolveSegmentedBadge(3)).toEqual({ count: 3, tone: 'neutral' });
        expect(resolveSegmentedBadge({ count: 2, tone: 'error' })).toEqual({ count: 2, tone: 'error' });
        expect(resolveSegmentedBadge({ count: 5 })).toEqual({ count: 5, tone: 'neutral' });
        expect(resolveSegmentedBadge(undefined)).toBeNull();
        expect(resolveSegmentedBadge(null)).toBeNull();
        expect(resolveSegmentedBadge(false)).toBeNull();
        expect(resolveSegmentedBadge({ count: null })).toBeNull();
    });
});
