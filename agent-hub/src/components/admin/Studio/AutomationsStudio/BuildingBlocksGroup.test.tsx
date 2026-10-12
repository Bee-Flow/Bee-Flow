import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory scopedStorage so the open/closed choice can be asserted.
const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock('../../../../utils/scopedStorage', () => ({
    default: {
        getJSON: (k: string, fb: unknown = null) => (store.has(k) ? store.get(k) : fb),
        setJSON: (k: string, v: unknown) => { store.set(k, v); },
    },
}));

import BuildingBlocksGroup from './BuildingBlocksGroup';
import type { BuildingBlocksGroupProps } from './BuildingBlocksGroup';

const blocks = [
    { id: 'vat', title: 'VAT check', publishedVersion: 2, isPublished: true, exposeAsTool: true },
    { id: 'lookup', title: 'Customer lookup', publishedVersion: null, isPublished: false },
];

function renderGroup(props: Partial<BuildingBlocksGroupProps> = {}) {
    const handlers = { onOpen: vi.fn(), onOpenRuns: vi.fn(), onDelete: vi.fn(), onCreate: vi.fn() };
    const utils = render(<BuildingBlocksGroup steps={blocks} {...handlers} {...props} />);
    return { ...handlers, ...utils };
}

const header = () => screen.getByRole('button', { name: /Building blocks/ });

describe('BuildingBlocksGroup: building blocks in the automations list', () => {
    beforeEach(() => store.clear());
    afterEach(cleanup);

    it('is a "Building blocks · n" group, open by default, one quiet row per block', () => {
        renderGroup();
        expect(header().textContent).toBe('Building blocks2');
        expect(header().getAttribute('aria-expanded')).toBe('true');
        expect(header().getAttribute('data-tour')).toBe('automation-building-blocks');
        const rows = screen.getAllByTestId('step-row');
        expect(rows.map(r => r.textContent)).toEqual([
            'VAT checkPublished · Organisation · In chat',
            'Customer lookupDraft · Personal',
        ]);
    });

    it('a row opens the block, and runs and delete act on it without opening it', async () => {
        const user = userEvent.setup();
        const { onOpen, onOpenRuns, onDelete } = renderGroup();
        const row = screen.getAllByTestId('step-row')[0];
        await user.click(within(row).getByRole('button', { name: 'View runs' }));
        expect(onOpenRuns).toHaveBeenCalledWith('vat');
        await user.click(within(row).getByRole('button', { name: 'Delete building block' }));
        expect(onDelete).toHaveBeenCalledWith(blocks[0]);
        expect(onOpen).not.toHaveBeenCalled();
        await user.click(within(row).getByText('VAT check'));
        expect(onOpen).toHaveBeenCalledWith('vat');
        // And from the keyboard.
        screen.getAllByTestId('step-row')[1].focus();
        await user.keyboard('{Enter}');
        expect(onOpen).toHaveBeenLastCalledWith('lookup');
    });

    it('collapses like a folder, and remembers it', async () => {
        const user = userEvent.setup();
        const { unmount } = renderGroup();
        await user.click(header());
        expect(header().getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryAllByTestId('step-row')).toHaveLength(0);
        expect(store.get('automationBlocksOpen')).toBe(false);
        unmount();
        renderGroup();
        expect(screen.queryAllByTestId('step-row')).toHaveLength(0);
    });

    it('opens by itself while filtering or while a block is being edited', () => {
        store.set('automationBlocksOpen', false);
        renderGroup({ filtering: true, steps: [blocks[0]] });
        expect(screen.getAllByTestId('step-row')).toHaveLength(1);
        cleanup();
        renderGroup({ forceOpen: true, selectedId: 'vat' });
        expect(screen.getAllByTestId('step-row')).toHaveLength(2);
        expect(screen.getAllByTestId('step-row')[0].className).toContain('bg-[var(--bg-secondary)]');
    });

    it('while filtering without matches the group steps aside', () => {
        renderGroup({ filtering: true, steps: [] });
        expect(screen.queryByTestId('automation-blocks')).toBeNull();
    });

    it('without blocks it explains what one is and offers to make one', async () => {
        const user = userEvent.setup();
        const { onCreate } = renderGroup({ steps: [] });
        expect(header().textContent).toBe('Building blocks0');
        expect(screen.getByText(/A building block is a step you build once/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'New building block' }));
        expect(onCreate).toHaveBeenCalledTimes(1);
    });
});
