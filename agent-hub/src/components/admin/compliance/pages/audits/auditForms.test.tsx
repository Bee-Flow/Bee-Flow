import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';
import {
    Field as FieldJs, INPUT_CLASS, PAGE_FRAME, RegisterLayout as RegisterLayoutJs, fmtDate, fmtStamp,
} from './auditForms';

/**
 * The form atoms and the register frame every register page shares. Pinned:
 * the hint is helper text under the control (described-by, not part of the
 * label), inputs show the focus token, dates follow the app locale, and the
 * drawer sits beside the table only in `inline` mode.
 */

// auditForms is plain JavaScript; these are the props it actually takes.
const Field = FieldJs as unknown as React.ComponentType<{
    label: React.ReactNode; hint?: React.ReactNode; testId?: string; children?: React.ReactNode;
}>;
const RegisterLayout = RegisterLayoutJs as unknown as React.ComponentType<{
    toolbar?: React.ReactNode; drawer?: React.ReactNode; isMobile?: boolean;
    drawerMode?: 'inline' | 'overlay' | 'modal'; frameRef?: React.Ref<HTMLDivElement>;
    testId?: string; children?: React.ReactNode;
}>;

describe('Field', () => {
    it('the hint is helper text under the control, not appended to the uppercase label', () => {
        render(<Field label="Repeat (months)" hint="Leave empty for a one-off" testId="f"><input /></Field>);
        const input = screen.getByRole('textbox', { name: 'Repeat (months)' });
        const hint = screen.getByTestId('f-hint');
        expect(hint.textContent).toBe('Leave empty for a one-off');
        expect(hint.className).toContain('text-[11px]');
        expect(hint.className).toContain('text-[var(--text-tertiary)]');
        expect(input).toHaveAccessibleDescription('Leave empty for a one-off');
        // After the control in the field's own order.
        expect(input.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('without a hint there is no helper line and no describedby', () => {
        render(<Field label="Owner" testId="f"><input /></Field>);
        expect(screen.queryByTestId('f-hint')).toBeNull();
        expect(screen.getByRole('textbox', { name: 'Owner' }).getAttribute('aria-describedby')).toBeNull();
    });
});

describe('INPUT_CLASS and PAGE_FRAME', () => {
    it('inputs ring with the theme focus token, not the grey accent', () => {
        expect(INPUT_CLASS).toContain('focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]');
        expect(INPUT_CLASS).toContain('focus:border-[var(--text-secondary)]');
        expect(INPUT_CLASS).not.toContain('accent-primary');
    });

    it('the page frame is one literal', () => {
        expect(PAGE_FRAME).toBe('p-3.5 @[1100px]/cpage:px-5 @[1100px]/cpage:py-4 flex flex-col gap-3.5 text-xs');
    });
});

describe('fmtDate / fmtStamp', () => {
    const day = new Date(new Date().getFullYear(), 7, 19, 20, 38);

    it('write the app language, not the browser one', () => {
        expect(fmtDate(day, 'en')).toBe('19 Aug');
        expect(fmtDate(day, 'nl')).toBe('19 aug');
        expect(fmtStamp(day, 'en')).toBe('19 Aug 20:38');
        expect(fmtStamp(day, 'nl')).toBe('19 aug 20:38');
    });

    it('no date is a dash', () => {
        expect(fmtDate(null, 'en')).toBe('—');
        expect(fmtDate('nonsense', 'en')).toBe('—');
        expect(fmtStamp(undefined, 'nl')).toBe('—');
    });
});

describe('RegisterLayout', () => {
    const drawer = <aside data-testid="drawer">drawer</aside>;

    it('uses the page frame', () => {
        render(<RegisterLayout testId="l">table</RegisterLayout>);
        expect(screen.getByTestId('l').className).toContain(PAGE_FRAME);
    });

    it('inline: the drawer sits in the row beside the table, and the row carries the frame ref', () => {
        const ref = React.createRef<HTMLDivElement>();
        render(<RegisterLayout drawer={drawer} drawerMode="inline" frameRef={ref} testId="l"><p>table</p></RegisterLayout>);
        const row = screen.getByText('table').parentElement?.parentElement;
        expect(ref.current).toBe(row);
        expect(row?.contains(screen.getByTestId('drawer'))).toBe(true);
        expect(screen.getByTestId('l').dataset.drawerMode).toBe('inline');
    });

    it('overlay: the drawer renders outside the row, over the frame', () => {
        const ref = React.createRef<HTMLDivElement>();
        render(<RegisterLayout drawer={drawer} drawerMode="overlay" frameRef={ref} testId="l"><p>table</p></RegisterLayout>);
        expect(ref.current?.contains(screen.getByTestId('drawer'))).toBe(false);
        expect(screen.getByTestId('drawer').parentElement).toBe(screen.getByTestId('l'));
        expect(screen.getByTestId('l').className).toMatch(/\brelative\b/);
    });

    it('without drawerMode the old rule holds: modal (outside the row) on a phone, inline otherwise', () => {
        const { rerender } = render(<RegisterLayout drawer={drawer} isMobile testId="l"><p>table</p></RegisterLayout>);
        expect(screen.getByTestId('drawer').parentElement).toBe(screen.getByTestId('l'));
        expect(screen.getByTestId('l').dataset.drawerMode).toBe('modal');
        rerender(<RegisterLayout drawer={drawer} testId="l"><p>table</p></RegisterLayout>);
        expect(screen.getByTestId('l').dataset.drawerMode).toBe('inline');
        expect(screen.getByTestId('drawer').parentElement).not.toBe(screen.getByTestId('l'));
    });
});
