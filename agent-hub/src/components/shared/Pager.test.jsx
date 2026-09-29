import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import Pager from './Pager';

/**
 * The 1d table footer. Pinned: the range sentence with its three numbers,
 * the bounds (Previous dead on the first page, Next dead on the last), the
 * offsets handed back, and that an UNKNOWN total draws nothing — never
 * "Rows 1–12 of 0".
 */

vi.mock('../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, vars) => {
            const base = typeof fallback === 'string' ? fallback : key;
            return vars ? Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), base) : base;
        },
        locale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

describe('Pager', () => {
    it('first page of 93 by 12: "Rows 1–12 of 93", Previous disabled, Next live', () => {
        render(<Pager offset={0} limit={12} total={93} onOffset={() => {}} testId="p" />);
        expect(screen.getByTestId('p-range').textContent).toBe('Rows 1–12 of 93');
        expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    });

    it('a middle page: both live, offsets step by limit', () => {
        const onOffset = vi.fn();
        render(<Pager offset={24} limit={12} total={93} onOffset={onOffset} testId="p" />);
        expect(screen.getByTestId('p-range').textContent).toBe('Rows 25–36 of 93');
        fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
        expect(onOffset).toHaveBeenLastCalledWith(12);
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        expect(onOffset).toHaveBeenLastCalledWith(36);
    });

    it('the last, short page: "Rows 85–93 of 93", Next disabled', () => {
        const onOffset = vi.fn();
        render(<Pager offset={84} limit={12} total={93} onOffset={onOffset} testId="p" />);
        expect(screen.getByTestId('p-range').textContent).toBe('Rows 85–93 of 93');
        expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        expect(onOffset).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
        expect(onOffset).toHaveBeenCalledWith(72);
    });

    it('one page in total: the range reads, both buttons dead', () => {
        render(<Pager offset={0} limit={12} total={7} onOffset={() => {}} testId="p" />);
        expect(screen.getByTestId('p-range').textContent).toBe('Rows 1–7 of 7');
        expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    });

    it('Previous from a short first step never goes below 0', () => {
        const onOffset = vi.fn();
        render(<Pager offset={5} limit={12} total={93} onOffset={onOffset} testId="p" />);
        fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
        expect(onOffset).toHaveBeenCalledWith(0);
    });

    it('an offset past the end (rows were deleted) is pulled back onto the last row', () => {
        render(<Pager offset={200} limit={12} total={93} onOffset={() => {}} testId="p" />);
        expect(screen.getByTestId('p-range').textContent).toBe('Rows 93–93 of 93');
        expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    });

    it('an unknown or empty total renders nothing at all', () => {
        const { rerender } = render(<Pager offset={0} limit={12} total={null} onOffset={() => {}} testId="p" />);
        expect(screen.queryByTestId('p')).toBeNull();
        rerender(<Pager offset={0} limit={12} onOffset={() => {}} testId="p" />);
        expect(screen.queryByTestId('p')).toBeNull();
        rerender(<Pager offset={0} limit={12} total={0} onOffset={() => {}} testId="p" />);
        expect(screen.queryByTestId('p')).toBeNull();
        rerender(<Pager offset={0} limit={12} total="x" onOffset={() => {}} testId="p" />);
        expect(screen.queryByTestId('p')).toBeNull();
    });

    it('is the 11px tertiary footer row with hairline rounded-md buttons; the live one reads in primary ink', () => {
        render(<Pager offset={0} limit={12} total={93} onOffset={() => {}} testId="p" />);
        const row = screen.getByTestId('p');
        expect(row.className).toMatch(/\bflex items-center gap-2 px-3\.5 py-2 text-\[11px\] text-\[var\(--text-tertiary\)\]/);
        const prev = screen.getByTestId('p-prev');
        const next = screen.getByTestId('p-next');
        for (const b of [prev, next]) expect(b.className).toMatch(/\bpx-2 py-0\.5 rounded-md border border-\[var\(--border-default\)\]/);
        expect(next.className).toMatch(/text-\[var\(--text-primary\)\]/);
        expect(prev.className).not.toMatch(/text-\[var\(--text-primary\)\]/);
        expect(prev.parentElement.className).toMatch(/\bml-auto\b/);
    });
});
