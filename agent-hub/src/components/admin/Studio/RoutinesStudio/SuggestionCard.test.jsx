import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SuggestionCard from './SuggestionCard.jsx';

const base = (overrides = {}) => ({
    id: 'sug_1',
    title: 'Auto-file incoming invoices to a spreadsheet',
    description: 'Extract amount/vendor/date from invoice emails and append a row.',
    complexity: 'assisted',
    requiredIntegrations: ['gmail', 'google-sheets'],
    unavailableIntegrations: [],
    triggerKind: 'app_event',
    buildPrompt: 'When an invoice arrives, extract details and append a row.',
    ...overrides,
});

const LABELS = { gmail: 'Gmail', 'google-sheets': 'Google Sheets' };
const labelFor = (id) => LABELS[id] || id;

describe('SuggestionCard, the compact row', () => {
    beforeEach(() => cleanup());

    it('shows the title, one sentence, the apps it comes from and the effort in words', () => {
        render(<SuggestionCard suggestion={base()} labelFor={labelFor} />);
        expect(screen.getByText('Auto-file incoming invoices to a spreadsheet')).toBeTruthy();
        expect(screen.getByText(/Extract amount\/vendor\/date/)).toBeTruthy();
        expect(screen.getByText('from Gmail, Google Sheets')).toBeTruthy();
        expect(screen.getByText('a few steps')).toBeTruthy();
    });

    it('says which apps still have to be connected, and leaves them out of "from"', () => {
        render(<SuggestionCard suggestion={base({ unavailableIntegrations: ['google-sheets'] })} labelFor={labelFor} />);
        expect(screen.getByText('needs Google Sheets connected')).toBeTruthy();
        expect(screen.getByText('from Gmail')).toBeTruthy();
    });

    it('"Build it" and "Adjust first" hand over the suggestion', async () => {
        const user = userEvent.setup();
        const onBuildDirectly = vi.fn();
        const onAskForChanges = vi.fn();
        const s = base();
        render(<SuggestionCard suggestion={s} onBuildDirectly={onBuildDirectly} onAskForChanges={onAskForChanges} />);
        await user.click(screen.getByRole('button', { name: 'Build it' }));
        expect(onBuildDirectly).toHaveBeenCalledWith(s);
        await user.click(screen.getByRole('button', { name: 'Adjust first' }));
        expect(onAskForChanges).toHaveBeenCalledWith(s);
    });

    // ---- the quiet evidence line, feature-detected -------------------------

    it('omits evidence, time saved and grounding when the fields are absent', () => {
        const { container } = render(<SuggestionCard suggestion={base()} />);
        expect(screen.queryByText('Observed')).toBeNull();
        expect(screen.queryByText('Idea')).toBeNull();
        expect(container.innerHTML).not.toMatch(/min\/mo|hr\/mo|seen/);
    });

    it('turns the server\'s activity counts into "seen n× in the last 3 months"', () => {
        const evidence = {
            kind: 'activity',
            summary: 'gmail ×6 in 3d',
            signals: [{ integration: 'gmail', count: 6, lastUsedDays: 3 }, { integration: 'google-sheets', count: 0 }],
        };
        render(<SuggestionCard suggestion={base({ evidence, groundedIn: 'activity' })} labelFor={labelFor} />);
        expect(screen.getByText('seen 6× in the last 3 months')).toBeTruthy();
        // The raw server shorthand is not shown when there are counts.
        expect(screen.queryByText('gmail ×6 in 3d')).toBeNull();
        expect(screen.getByText('Observed')).toBeTruthy();
    });

    it('an idea without activity shows no generic sentence, only that it is an idea', () => {
        const evidence = { kind: 'integration', summary: 'based on what gmail can do', signals: [{ integration: 'gmail', count: 0 }] };
        render(<SuggestionCard suggestion={base({ evidence, groundedIn: 'integration' })} />);
        expect(screen.getByText('Idea')).toBeTruthy();
        expect(screen.queryByText('based on what gmail can do')).toBeNull();
    });

    it('an older scan without counts keeps its sentence, as a string or as { summary }', () => {
        render(<SuggestionCard suggestion={base({ evidence: { summary: 'Seen 12 invoice emails last week' } })} />);
        expect(screen.getByText('Seen 12 invoice emails last week')).toBeTruthy();
        cleanup();
        render(<SuggestionCard suggestion={base({ evidence: 'Plain string evidence' })} />);
        expect(screen.getByText('Plain string evidence')).toBeTruthy();
    });

    it('never displays an estimated time-saved value (intentionally hidden)', () => {
        render(<SuggestionCard suggestion={base({ value: { minutesSavedPerMonth: 45 }, timeSavedMinutes: 30 })} />);
        expect(screen.queryByText(/min\/mo|hr\/mo/i)).toBeNull();
    });

    it('draws "Observed" in the success colour', () => {
        render(<SuggestionCard suggestion={base({ groundedIn: 'activity' })} />);
        expect(screen.getByText('Observed').className).toContain('var(--success)');
    });

    it('dismisses with the suggestion', async () => {
        const user = userEvent.setup();
        const onDismiss = vi.fn();
        const s = base();
        render(<SuggestionCard suggestion={s} onDismiss={onDismiss} />);
        await user.click(screen.getByRole('button', { name: 'Dismiss suggestion' }));
        expect(onDismiss).toHaveBeenCalledWith(s);
    });

    it('greys out and disables its actions when dismissed, and hides dismiss', () => {
        render(<SuggestionCard suggestion={base()} dismissed muted onDismiss={vi.fn()} />);
        expect(screen.getByText('Dismissed')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Build it' }).disabled).toBe(true);
        expect(screen.getByRole('button', { name: 'Adjust first' }).disabled).toBe(true);
        expect(screen.queryByRole('button', { name: 'Dismiss suggestion' })).toBeNull();
    });

    it('shows a "Built" tag and disables its actions when built', () => {
        render(<SuggestionCard suggestion={base()} built muted />);
        expect(screen.getByText('Built')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Build it' }).disabled).toBe(true);
    });

    it('never uses purple/violet/indigo', () => {
        const { container } = render(
            <SuggestionCard
                suggestion={base({ groundedIn: 'activity', evidence: { summary: 'evidence' }, value: { minutesSavedPerMonth: 90 }, complexity: 'advanced' })}
                built
                muted
                onDismiss={vi.fn()}
            />,
        );
        expect(container.innerHTML).not.toMatch(/purple|violet|indigo/);
    });
});
