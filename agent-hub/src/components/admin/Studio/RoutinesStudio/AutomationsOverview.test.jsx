import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory scopedStorage so view/sort/group persistence is deterministic.
const { store } = vi.hoisted(() => ({ store: new Map() }));
vi.mock('../../../../utils/scopedStorage', () => ({
    default: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, v); },
        getJSON: () => null,
        setJSON: () => {},
    },
}));

import AutomationsOverview from './AutomationsOverview.jsx';

const row = (over = {}) => ({
    id: over.id || Math.random().toString(36).slice(2),
    title: 'Untitled',
    isActive: true,
    isDraft: false,
    triggerType: 'manual',
    lastStatus: null,
    updatedAt: '2026-09-01T00:00:00Z',
    ...over,
});

const LIB = [
    row({ id: 'a', title: 'Daily digest', triggerType: 'schedule', scheduleCron: '0 9 * * *', scheduleTz: 'Europe/Amsterdam', lastStatus: 'success', lastRunAt: '2026-09-10T09:00:00Z', nextRunAt: '2099-01-01T09:00:00Z', updatedAt: '2026-09-01T00:00:00Z', description: 'Sums up the inbox.' }),
    row({ id: 'b', title: 'Invoice intake', lastStatus: 'failed', lastRunAt: '2026-09-12T09:00:00Z', updatedAt: '2026-09-05T00:00:00Z' }),
    row({ id: 'c', title: 'Old webhook', isActive: false, triggerType: 'webhook', updatedAt: '2026-09-03T00:00:00Z' }),
    row({ id: 'd', title: 'Sketch', isDraft: true, isActive: false, updatedAt: '2026-09-18T00:00:00Z', folderId: 'f1' }),
];

const rowProps = (a) => ({
    routine: a,
    kind: 'automation',
    selected: a.id === 'b',
    onSelect: vi.fn(),
    onOpenRuns: vi.fn(),
    onToggleActive: vi.fn(),
    onDuplicate: vi.fn(),
    onExportJson: vi.fn(),
    onMoveToFolder: vi.fn(),
    onCopyId: vi.fn(),
    onDelete: vi.fn(),
});

const rowTitles = () => screen.getAllByTestId('automations-overview-row').map(r => r.getAttribute('data-automation-id'));

describe('AutomationsOverview', () => {
    beforeEach(() => { cleanup(); store.clear(); });

    it('defaults to the list view, newest first, with every column', () => {
        render(<AutomationsOverview automations={LIB} rowProps={rowProps} folders={[]} />);
        expect(screen.getByTestId('automations-overview').getAttribute('data-view')).toBe('list');
        expect(rowTitles()).toEqual(['d', 'b', 'c', 'a']);
        const table = screen.getByRole('table', { name: 'Automations' });
        // Every column is in the DOM; which of them show is a container query
        // (Trigger from 60rem, Next run from 76rem, Updated from 100rem).
        for (const col of ['Automation', 'Trigger', 'Status', 'Last run', 'Next run', 'Updated']) {
            expect(within(table).getByText(col)).toBeTruthy();
        }
        // The schedule reads as words, and the draft/paused/live words are on the rows.
        expect(screen.getByText(/09:00 · Europe\/Amsterdam/)).toBeTruthy();
        const states = screen.getAllByTestId('overview-lifecycle').map(el => el.getAttribute('data-status'));
        expect(states).toEqual(['draft', 'live', 'paused', 'live']);
    });

    it('the state pills carry counts and narrow the rows; Clear puts them back', () => {
        render(<AutomationsOverview automations={LIB} rowProps={rowProps} folders={[]} />);
        const failing = screen.getByTestId('automations-overview-state-failing');
        expect(failing.textContent).toBe('Failing1');
        fireEvent.click(failing);
        expect(rowTitles()).toEqual(['b']);
        fireEvent.click(screen.getByTestId('automations-overview-state-paused'));
        expect(rowTitles()).toEqual(['c']);
        fireEvent.click(screen.getByRole('button', { name: /Clear/ }));
        expect(rowTitles()).toHaveLength(4);
    });

    it('a live-run poll marks the row running without waiting for lastStatus', () => {
        render(<AutomationsOverview automations={LIB} rowProps={rowProps} folders={[]} activeRunIds={new Set(['c'])} />);
        expect(screen.getByTestId('automations-overview-state-running').textContent).toBe('Running1');
        fireEvent.click(screen.getByTestId('automations-overview-state-running'));
        expect(rowTitles()).toEqual(['c']);
    });

    it('clicking a column header sorts and is remembered across remounts', () => {
        const { unmount } = render(<AutomationsOverview automations={LIB} rowProps={rowProps} folders={[]} />);
        fireEvent.click(screen.getByRole('button', { name: 'Automation' }));
        expect(rowTitles()).toEqual(['a', 'b', 'c', 'd']);
        expect(store.get('automationsOverviewSort')).toBe('name');
        unmount();
        render(<AutomationsOverview automations={LIB} rowProps={rowProps} folders={[]} />);
        expect(rowTitles()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('switches to cards and to a board grouped by status, and the choice persists', () => {
        const { unmount } = render(<AutomationsOverview automations={LIB} rowProps={rowProps} folders={[]} />);
        fireEvent.click(screen.getByRole('radio', { name: /Cards/ }));
        expect(screen.getAllByTestId('automations-overview-card')).toHaveLength(4);
        expect(screen.getByText('Sums up the inbox.')).toBeTruthy();

        fireEvent.click(screen.getByRole('radio', { name: /Board/ }));
        const lanes = screen.getAllByTestId('automations-overview-lane');
        expect(lanes.map(l => l.getAttribute('data-lane'))).toEqual(['live', 'paused', 'draft']);
        expect(within(lanes[0]).getAllByTestId('automations-overview-card')).toHaveLength(2);
        expect(within(lanes[2]).getAllByTestId('automations-overview-card')).toHaveLength(1);
        expect(store.get('automationsOverviewView')).toBe('board');

        unmount();
        render(<AutomationsOverview automations={LIB} rowProps={rowProps} folders={[]} />);
        expect(screen.getByTestId('automations-overview').getAttribute('data-view')).toBe('board');
    });

    it('the board can group by folder, with the org folders as lanes', () => {
        store.set('automationsOverviewView', 'board');
        render(<AutomationsOverview automations={LIB} rowProps={rowProps} folders={[{ id: 'f1', name: 'Finance' }]} />);
        fireEvent.click(screen.getByTestId('automations-overview-group'));
        fireEvent.click(screen.getByRole('menuitemradio', { name: 'Folder' }));
        const lanes = screen.getAllByTestId('automations-overview-lane');
        expect(lanes.map(l => l.getAttribute('aria-label'))).toEqual(['No folder', 'Finance']);
        expect(within(lanes[1]).getByText('Sketch')).toBeTruthy();
    });

    it('a row opens on click and its kebab opens the same actions menu as the sidebar', () => {
        const props = new Map();
        const rp = (a) => { if (!props.has(a.id)) props.set(a.id, rowProps(a)); return props.get(a.id); };
        render(<AutomationsOverview automations={LIB} rowProps={rp} folders={[]} />);
        const first = screen.getAllByTestId('automations-overview-row')[0];
        fireEvent.click(within(first).getByText('Sketch'));
        expect(props.get('d').onSelect).toHaveBeenCalledTimes(1);

        fireEvent.click(within(first).getByRole('button', { name: 'More options' }));
        for (const label of ['Activate', 'View executions', 'Duplicate', 'Export JSON', 'Move to folder…', 'Copy ID', 'Delete']) {
            expect(screen.getByText(label)).toBeTruthy();
        }
        fireEvent.click(screen.getByText('Move to folder…'));
        expect(props.get('d').onMoveToFolder).toHaveBeenCalledTimes(1);
    });

    it('tells "no automations" apart from "none match the filter"', () => {
        const onCreate = vi.fn();
        const { rerender } = render(<AutomationsOverview automations={[]} query="" rowProps={rowProps} onCreate={onCreate} />);
        expect(screen.getByText('No automations yet')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /New automation/ }));
        expect(onCreate).toHaveBeenCalled();

        rerender(<AutomationsOverview automations={[]} query="zzz" rowProps={rowProps} onCreate={onCreate} />);
        expect(screen.queryByText('No automations yet')).toBeNull();
        expect(screen.getByText(/No automation matches “zzz”/)).toBeTruthy();
    });

    it('the toolbar\'s New is the split +: New makes an automation, the chevron also offers a building block', async () => {
        const user = userEvent.setup();
        const onCreate = vi.fn();
        const onCreateBlock = vi.fn();
        render(<AutomationsOverview automations={LIB} rowProps={rowProps} onCreate={onCreate} onCreateBlock={onCreateBlock} />);
        await user.click(screen.getByRole('button', { name: 'New' }));
        expect(onCreate).toHaveBeenCalledTimes(1);
        await user.click(screen.getByRole('button', { name: 'Choose what to create' }));
        await user.click(screen.getByRole('menuitem', { name: /New building block/ }));
        expect(onCreateBlock).toHaveBeenCalledTimes(1);
        expect(onCreate).toHaveBeenCalledTimes(1);
    });

    it('while the first load is in flight it says so and shows no count', () => {
        render(<AutomationsOverview automations={[]} loading rowProps={rowProps} />);
        expect(screen.getByText('Loading…')).toBeTruthy();
        expect(screen.queryByText('No automations yet')).toBeNull();
    });
});
