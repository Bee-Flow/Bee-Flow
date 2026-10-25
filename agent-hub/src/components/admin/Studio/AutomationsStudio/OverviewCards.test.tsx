import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { CardsView } from './OverviewCards';
import type { AutomationRecord } from './overviewModel';

const row = (over: Partial<AutomationRecord> & { id: string }): AutomationRecord => ({
    title: over.id, isActive: true, isDraft: false, triggerType: 'manual', lastStatus: null, ...over,
});

const FOLDERS = [
    { id: 'fin', name: 'Finance' },
    { id: 'inv', name: 'Invoices', parentId: 'fin' },
];

const ROWS = [
    row({ id: 'mail', triggerType: 'app_event', definition: { trigger: { kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } } }, folderId: 'inv', lastStatus: 'success', lastRunAt: '2026-10-01T00:00:00Z' }),
    row({ id: 'sched', triggerType: 'schedule', scheduleCron: '0 9 * * *', folderId: 'fin' }),
    row({ id: 'draft', isDraft: true, isActive: false }),
    row({ id: 'broken', lastStatus: 'error', lastRunAt: '2026-10-01T00:00:00Z' }),
];

const cardIds = (el: HTMLElement) => within(el).queryAllByTestId('automations-overview-card').map(c => c.getAttribute('data-automation-id'));

describe('CardsView', () => {
    afterEach(cleanup);

    it('draws one plain grid when the library has no folders', () => {
        render(<CardsView rows={ROWS} folders={[]} column="" />);
        expect(screen.queryAllByTestId('overview-folder-section')).toHaveLength(0);
        expect(screen.getAllByTestId('automations-overview-card')).toHaveLength(4);
    });

    it('groups the cards into folder sections, nested folders by path, loose ones last', () => {
        render(<CardsView rows={ROWS} folders={FOLDERS} column="" />);
        const sections = screen.getAllByTestId('overview-folder-section');
        expect(sections.map(s => s.getAttribute('aria-label'))).toEqual(['Finance', 'Finance / Invoices', 'No folder']);
        expect(cardIds(sections[1])).toEqual(['mail']);
        expect(cardIds(sections[2])).toEqual(['draft', 'broken']);
    });

    it('folds a section away and back', async () => {
        const user = userEvent.setup();
        render(<CardsView rows={ROWS} folders={FOLDERS} column="" />);
        const header = screen.getAllByTestId('overview-folder-header')[0];
        expect(header.getAttribute('aria-expanded')).toBe('true');
        await user.click(header);
        expect(header.getAttribute('aria-expanded')).toBe('false');
        expect(cardIds(screen.getAllByTestId('overview-folder-section')[0])).toEqual([]);
        await user.click(header);
        expect(cardIds(screen.getAllByTestId('overview-folder-section')[0])).toEqual(['sched']);
    });

    it('tints each card by its trigger and says the state without colour alone', () => {
        render(<CardsView rows={ROWS} folders={[]} column="" />);
        const card = (id: string) => screen.getAllByTestId('automations-overview-card').find(c => c.getAttribute('data-automation-id') === id) as HTMLElement;
        expect(card('mail').getAttribute('data-tone')).toBe('mail');
        expect(card('sched').getAttribute('data-tone')).toBe('schedule');
        expect(within(card('sched')).getByTestId('overview-trigger-tile').getAttribute('aria-label')).toMatch(/^Schedule: /);
        expect(within(card('draft')).getByTestId('overview-lifecycle').textContent).toBe('Draft');
        // A draft that never ran says nothing about runs; a live one says "Never ran".
        expect(within(card('draft')).queryByTestId('overview-outcome')).toBeNull();
        expect(within(card('sched')).getByTestId('overview-outcome').getAttribute('data-outcome')).toBe('never');
        expect(within(card('broken')).getByTestId('overview-outcome').textContent).toContain('Failed');
        expect(within(card('mail')).getByTestId('overview-outcome').textContent).toContain('Finished');
    });
});
