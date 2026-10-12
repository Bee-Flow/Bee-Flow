import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Pattern, RepeatingSuggestion } from '../../../../../api/queries/automation/repeating';
import PatternCard from './PatternCard';

const labelFor = (id: string) => ({ gmail: 'Gmail', google_sheets: 'Google Sheets' } as Record<string, string>)[id] || id;

const pattern = (over: Partial<Pattern> = {}): Pattern => ({
    kind: 'mail_template', signature: 'sig-1',
    cadence: { kind: 'weekly', weekday: 1, hourBand: [9, 10], weeksPresent: 3, weeksWindow: 4 },
    occurrences: 14, windowDays: 90, distinctDays: 12, weekdayHistogram: [0, 9, 1, 0, 0, 0, 0],
    minutesPerMonth: [60, 120], basis: 'heuristic', template: 'Invoice <n> from <org>',
    apps: ['gmail', 'google_sheets'],
    draft: {
        trigger: { kind: 'app', app: 'gmail', label: 'New invoice mail' },
        steps: [
            { family: 'ai', label: 'Read the amount' },
            { family: 'app', app: 'google_sheets', label: 'Add a row' },
            { family: 'data', label: 'Format the date' },
            { family: 'app', app: 'gmail', label: 'Reply' },
        ],
    },
    reasons: ['frequent', 'regular'], confidence: 'normal', ...over,
});
const suggestion = (over: Partial<RepeatingSuggestion> = {}): RepeatingSuggestion => ({
    id: 's1', title: 'Invoice mail to a sheet', description: 'Every Monday you copy invoice totals into a sheet.',
    groundedIn: 'activity', requiredIntegrations: ['gmail', 'google_sheets'], pattern: pattern(), ...over,
});

function renderCard(props: Partial<Parameters<typeof PatternCard>[0]> = {}) {
    const handlers = { onBuild: vi.fn(), onSnooze: vi.fn(), onNotRepetitive: vi.fn(), onDismiss: vi.fn() };
    const view = render(<PatternCard suggestion={suggestion()} labelFor={labelFor} {...handlers} {...props} />);
    return { ...handlers, ...view };
}

describe('PatternCard: what it shows', () => {
    it('reads like a canvas card: trigger bar, kicker, title, why and evidence', () => {
        renderCard();
        const card = screen.getByTestId('pattern-card');
        expect(card.className).toContain('shadow-[inset_4px_0_0_var(--type-trigger)');
        const eyebrow = screen.getByTestId('pattern-eyebrow');
        expect(within(eyebrow).getByText('Pattern')).toBeTruthy();
        expect(eyebrow).toHaveTextContent('· Weekly · Mon 09–10');
        expect(screen.getByRole('heading', { name: 'Invoice mail to a sheet' })).toBeTruthy();
        expect(screen.getByText(/copy invoice totals/)).toBeTruthy();
        const pills = within(screen.getByTestId('evidence-pills'));
        expect(pills.getByText('14× in 90 days')).toBeTruthy();
        expect(pills.getByText('3 of 4 weeks')).toBeTruthy();
        expect(pills.getByText('≈1–2 h/month (estimated)')).toBeTruthy();
        expect(pills.getByText('Gmail → Google Sheets')).toBeTruthy();
        expect(screen.getByRole('img', { name: /By weekday: Mon 9, Tue 1/ })).toBeTruthy();
    });

    it('previews the automation as mini nodes: the trigger, three steps, then +n', () => {
        renderCard();
        const preview = within(screen.getByTestId('pattern-step-preview'));
        expect(preview.getByText('New invoice mail')).toBeTruthy();
        expect(preview.getByText('Read the amount')).toBeTruthy();
        expect(preview.getByText('Format the date')).toBeTruthy();
        expect(preview.queryByText('Reply')).toBeNull();
        expect(preview.getByText('+1 more')).toBeTruthy();
    });

    it('shows a dashed "Trigger to choose" when the pattern has no draft', () => {
        renderCard({ suggestion: suggestion({ pattern: pattern({ draft: null }) }) });
        const preview = within(screen.getByTestId('pattern-step-preview'));
        const node = preview.getByText('Trigger to choose').closest('[data-testid="mini-node"]') as HTMLElement;
        expect(node.className).toContain('!border-dashed');
    });

    it('shows the masked template with its placeholders in words', () => {
        renderCard();
        const line = screen.getByTestId('pattern-template');
        expect(line).toHaveTextContent('Invoice number from organisation');
        expect(within(line).getByText('number').className).toContain('bg-[var(--bg-tertiary)]');
    });

    it('explains why it ranks here only when asked', async () => {
        const user = userEvent.setup();
        renderCard();
        expect(screen.queryByText('It happens often')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Why this ranks here' }));
        expect(screen.getByText('It happens often')).toBeTruthy();
        expect(screen.getByText('It follows a steady rhythm')).toBeTruthy();
    });

    it('marks an early signal and an app that still has to be connected', () => {
        renderCard({ suggestion: suggestion({ unavailableIntegrations: ['google_sheets'], pattern: pattern({ confidence: 'early' }) }) });
        expect(screen.getByText('Early signal')).toBeTruthy();
        expect(screen.getByText('needs Google Sheets connected')).toBeTruthy();
    });

    it('still shows an older scan: Observed, its sentence, and no time-saved figure', () => {
        renderCard({ suggestion: suggestion({ pattern: null, evidence: { summary: 'Observed 12 invoice emails this month' }, value: { minutesSavedPerMonth: 45 } }) });
        expect(screen.getByText('Observed')).toBeTruthy();
        expect(screen.getByText('Observed 12 invoice emails this month')).toBeTruthy();
        expect(screen.queryByText(/min\/mo|hr\/mo/i)).toBeNull();
        expect(screen.queryByTestId('pattern-step-preview')).toBeNull();
    });
});

describe('PatternCard: what it does', () => {
    it('Build this sends at once; Adjust first only fills the builder in', async () => {
        const user = userEvent.setup();
        const { onBuild } = renderCard();
        await user.click(screen.getByRole('button', { name: 'Build this' }));
        expect(onBuild).toHaveBeenLastCalledWith(expect.objectContaining({ id: 's1' }), { autoSend: true });
        await user.click(screen.getByRole('button', { name: 'Adjust first' }));
        expect(onBuild).toHaveBeenLastCalledWith(expect.objectContaining({ id: 's1' }), { autoSend: false });
    });

    it('Not now snoozes; Not repetitive asks why in a menu', async () => {
        const user = userEvent.setup();
        const { onSnooze, onNotRepetitive } = renderCard();
        await user.click(screen.getByRole('button', { name: 'Not now' }));
        expect(onSnooze).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
        await user.click(screen.getByRole('button', { name: /Not repetitive/ }));
        const menu = screen.getByRole('menu');
        expect(within(menu).getAllByRole('menuitem')).toHaveLength(4);
        await user.click(within(menu).getByRole('menuitem', { name: 'I prefer to do this myself' }));
        expect(onNotRepetitive).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), 'do_myself');
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('closes the reasons menu on Escape', async () => {
        const user = userEvent.setup();
        renderCard();
        await user.click(screen.getByRole('button', { name: /Not repetitive/ }));
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('dims and waits while a re-scan runs', () => {
        renderCard({ busy: true });
        expect(screen.getByTestId('pattern-card').className).toContain('opacity-60');
        expect(screen.getByRole('button', { name: 'Build this' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Not now' })).toBeDisabled();
    });

    it('an idea has no evidence and is dismissed rather than snoozed', async () => {
        const user = userEvent.setup();
        const { onDismiss, container } = renderCard({ variant: 'idea', suggestion: suggestion({ groundedIn: 'idea', pattern: null }) });
        expect(screen.getByText('Idea')).toBeTruthy();
        expect(screen.queryByTestId('evidence-pills')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
        expect(container.querySelector('[data-testid="pattern-card"]')?.className).toContain('var(--type-ai)');
        await user.click(screen.getByRole('button', { name: 'Dismiss suggestion' }));
        expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    });

    it('never paints purple, violet or indigo', () => {
        const { container } = renderCard();
        expect(container.innerHTML).not.toMatch(/purple|violet|indigo/);
    });
});
