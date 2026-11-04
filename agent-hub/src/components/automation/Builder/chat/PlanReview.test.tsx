/**
 * The plan view numbers the steps itself, so a "1." the model wrote into a line
 * must not show twice ("011."), and the line's inline markdown must render.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlanReview from './PlanReview';

vi.mock('@/hooks/useTranslation', () => ({
    default: () => ({ t: (_k: string, d: string, p?: Record<string, unknown>) => d.replace(/\{(\w+)\}/g, (_m, k) => String(p?.[k] ?? `{${k}}`)) }),
    useTranslation: () => ({ t: (_k: string, d: string, p?: Record<string, unknown>) => d.replace(/\{(\w+)\}/g, (_m, k) => String(p?.[k] ?? `{${k}}`)) }),
}));

afterEach(cleanup);

const plan = (over = {}) => ({ id: 'p', version: 1, status: 'review', title: 'Plan', goal: 'Goal', steps: ['Read'], ...over });

describe('PlanReview lines', () => {
    it('shows the number the view draws and not the one the model wrote', () => {
        const { container } = render(<PlanReview plan={plan({ steps: ['1. Add a **webhook** trigger', '2) Call `http_request`', '- Stop on error'] })} onApprove={vi.fn()} onClose={vi.fn()} />);
        const rows = [...container.querySelectorAll('section details > div > div')];
        expect(rows.map(r => r.firstElementChild?.textContent)).toEqual(['01', '02', '03']);
        expect(rows.map(r => r.querySelector('p')?.textContent)).toEqual(['Add a webhook trigger', 'Call http_request', 'Stop on error']);
        expect(container.textContent).not.toMatch(/011\.|022\)/);
    });

    it('renders inline markdown in a line and keeps the line itself free of block markup', () => {
        const { container } = render(<PlanReview plan={plan({ steps: ['Add a **webhook** trigger and run `daily-report`\n- then stop'] })} onApprove={vi.fn()} onClose={vi.fn()} />);
        const p = container.querySelector('section p') as HTMLElement;
        expect(p.querySelector('strong')?.textContent).toBe('webhook');
        expect(p.querySelector('code')?.textContent).toBe('daily-report');
        expect(p.querySelector('ul, ol, li')).toBeNull();
        expect(p.textContent).not.toContain('**');
    });

    it('strips a bullet from the other sections but keeps text that merely starts with a digit', () => {
        render(<PlanReview plan={plan({ assumptions: ['- Finance inbox', '3 retries on failure'] })} onApprove={vi.fn()} onClose={vi.fn()} />);
        expect(screen.getByText('Finance inbox')).toBeTruthy();
        expect(screen.getByText('3 retries on failure')).toBeTruthy();
    });

    it('hands the clean line to the comment callback and names the button without markdown', () => {
        const onComment = vi.fn();
        render(<PlanReview plan={plan({ steps: ['1. Add a **webhook** trigger'] })} onApprove={vi.fn()} onClose={vi.fn()} onComment={onComment} />);
        const button = screen.getByRole('button', { name: /comment on this line: Add a webhook trigger/i });
        button.click();
        expect(onComment).toHaveBeenCalledWith('steps', 0, 'Add a **webhook** trigger');
    });
});

describe('PlanReview tables', () => {
    it('lists the tables to create and the existing ones used', () => {
        const plan = { title: 'P', version: 1, status: 'review', steps: ['a'], datatables: [{ name: 'Facturen', fields: [{ name: 'Datum', type: 'date' }] }], useDatatables: [{ id: 't1', key: 'klanten', name: 'Klanten' }] };
        render(<PlanReview plan={plan} onApprove={() => {}} onClose={() => {}} />);
        expect(screen.getByTestId('plan-new-table')).toHaveTextContent('Facturen');
        expect(screen.getByTestId('plan-new-table')).toHaveTextContent('Datum · date');
        expect(screen.getByTestId('plan-used-table')).toHaveTextContent('Klanten');
    });
});

describe('PlanReview after the build', () => {
    const buttons = () => screen.queryAllByRole('button').map(b => b.textContent || b.getAttribute('aria-label'));

    it('a built plan says so and offers Close only, never a build button', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(<PlanReview plan={plan({ status: 'built' })} onApprove={vi.fn()} onClose={onClose} onReject={vi.fn()} />);
        expect(screen.getByText('Plan v1 built')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Build this plan|Continue plan|Discard/ })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalled();
        expect(buttons().filter(Boolean)).not.toContain('Build this plan');
    });

    it('a build that stopped says so and offers Continue plan only (no Build, no Discard)', async () => {
        const user = userEvent.setup();
        const onApprove = vi.fn();
        render(<PlanReview plan={plan({ status: 'building' })} onApprove={onApprove} onClose={vi.fn()} onReject={vi.fn()} />);
        expect(screen.getByText(/build stopped/i)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Build this plan|Discard/ })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Continue plan' }));
        expect(onApprove).toHaveBeenCalledWith(false);
    });

    it('a build that is running offers no button to start it again', () => {
        render(<PlanReview plan={plan({ status: 'building' })} running onApprove={vi.fn()} onClose={vi.fn()} />);
        expect(screen.queryByRole('button', { name: /Build this plan|Continue plan/ })).toBeNull();
    });
});
