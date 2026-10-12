import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlanInlineCard from './PlanInlineCard';

vi.mock('../../../../hooks/useTranslation', () => {
    const t = (_k: string, d: string, p?: Record<string, unknown>) => d.replace(/\{(\w+)\}/g, (_m, k) => String(p?.[k] ?? `{${k}}`));
    return { default: () => ({ t }), useTranslation: () => ({ t }) };
});

afterEach(cleanup);

const plan = (status: string, extra = {}) => ({ id: 'p1', version: 2, title: 'Invoice flow', steps: ['a', 'b', 'c'], status, ...extra });

describe('PlanInlineCard', () => {
    it('review: summary, Open plan and Build this plan; the build button approves with the plan\'s pause setting', async () => {
        const user = userEvent.setup();
        const onApprove = vi.fn();
        const onOpen = vi.fn();
        render(<PlanInlineCard plan={plan('review', { pauseAfterStep: true })} onApprove={onApprove} onOpen={onOpen} />);
        expect(screen.getByText('Plan v2 · 3 steps')).toBeTruthy();
        expect(screen.getByText('Invoice flow')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Open plan' }));
        expect(onOpen).toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Build this plan' }));
        expect(onApprove).toHaveBeenCalledWith(true);
    });

    it('paused: Continue plan', async () => {
        const user = userEvent.setup();
        const onApprove = vi.fn();
        render(<PlanInlineCard plan={plan('paused')} onApprove={onApprove} />);
        await user.click(screen.getByRole('button', { name: 'Continue plan' }));
        expect(onApprove).toHaveBeenCalledWith(false);
    });

    it('building while a turn runs: a status line and no button', () => {
        render(<PlanInlineCard plan={plan('building')} running onApprove={vi.fn()} />);
        expect(screen.getByText('Building plan v2…')).toBeTruthy();
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('building with nothing running (a stopped build) offers Continue plan instead of a dead end', () => {
        render(<PlanInlineCard plan={plan('building')} onApprove={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Continue plan' })).toBeTruthy();
    });

    it('built: one collapsed line, no button', () => {
        render(<PlanInlineCard plan={plan('built')} onApprove={vi.fn()} />);
        expect(screen.getByText('Plan v2 built')).toBeTruthy();
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('hides the build buttons while a turn runs, and renders nothing without a plan', () => {
        const { container, rerender } = render(<PlanInlineCard plan={plan('review')} running onApprove={vi.fn()} />);
        expect(screen.queryByRole('button')).toBeNull();
        rerender(<PlanInlineCard plan={null} onApprove={vi.fn()} />);
        expect(container.textContent).toBe('');
    });
});
