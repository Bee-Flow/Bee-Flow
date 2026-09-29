import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import RoutineRow from './RoutineRow';

/**
 * BFSF-403: the per-row actions menu (Activate, View executions, Duplicate,
 * Export JSON, Move to folder, Copy ID, Delete) was reachable only via
 * right-click — undiscoverable on a normal click, and unreachable at all on
 * touch input. These tests pin the visible "More options" button that opens
 * the same menu on a left click, without breaking onSelect or right-click.
 */
const routine = (over = {}) => ({
    id: 'r1', title: 'My automation', isActive: true, isDraft: false, triggerType: 'manual', ...over,
});

function renderRow(props = {}) {
    const handlers = {
        onSelect: vi.fn(),
        onDuplicate: vi.fn(),
        onExportJson: vi.fn(),
        onCopyId: vi.fn(),
        onDelete: vi.fn(),
        onToggleActive: vi.fn(),
        onOpenRuns: vi.fn(),
        onMoveToFolder: vi.fn(),
        ...props,
    };
    const utils = render(<RoutineRow routine={routine()} kind="automation" selected={false} {...handlers} />);
    return { ...utils, ...handlers };
}

describe('RoutineRow — more options button', () => {
    beforeEach(cleanup);

    it('renders a visible "More options" button (not hover-only) when actions are available', () => {
        renderRow();
        const btn = screen.getByLabelText('More options');
        expect(btn).toBeTruthy();
        // Discoverability is the whole point of the ticket: the button must
        // not rely on the hover-only convention the Delete button uses.
        expect(btn.className).not.toMatch(/opacity-0/);
    });

    it('opens the same menu the right-click context menu opens, on a left click', () => {
        renderRow();
        fireEvent.click(screen.getByLabelText('More options'));
        expect(screen.getByText('Duplicate')).toBeTruthy();
        expect(screen.getByText('Export JSON')).toBeTruthy();
        expect(screen.getByText('Move to folder…')).toBeTruthy();
        expect(screen.getByText('Copy ID')).toBeTruthy();
        expect(screen.getByText('Delete')).toBeTruthy();
        expect(screen.getByText('Pause')).toBeTruthy();
        expect(screen.getByText('View executions')).toBeTruthy();
    });

    it('does not trigger onSelect when opening the menu via the button', () => {
        const { onSelect } = renderRow();
        fireEvent.click(screen.getByLabelText('More options'));
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('still opens onSelect for a normal click elsewhere on the row', () => {
        const { onSelect, container } = renderRow();
        fireEvent.click(container.querySelector('[title="My automation"]'));
        expect(onSelect).toHaveBeenCalled();
    });

    it('still opens the menu via right-click (power-user shortcut kept)', () => {
        const { container } = renderRow();
        fireEvent.contextMenu(container.querySelector('[title="My automation"]'));
        expect(screen.getByText('Duplicate')).toBeTruthy();
    });

    it('running an item from the menu still calls its handler and closes the menu', () => {
        const { onDuplicate } = renderRow();
        fireEvent.click(screen.getByLabelText('More options'));
        fireEvent.click(screen.getByText('Duplicate'));
        expect(onDuplicate).toHaveBeenCalled();
        expect(screen.queryByText('Delete')).toBeNull();
    });

    it('keeps the standalone Delete shortcut (now "Move to trash") alongside the new menu button', () => {
        renderRow();
        expect(screen.getByTitle('Move to trash')).toBeTruthy();
        expect(screen.getByLabelText('More options')).toBeTruthy();
    });

    it('does not render the button when there is nothing the user can mutate', () => {
        renderRow({
            onDuplicate: undefined,
            onExportJson: undefined,
            onCopyId: undefined,
            onDelete: undefined,
            onToggleActive: undefined,
            onOpenRuns: undefined,
            onMoveToFolder: undefined,
            canManage: false,
        });
        expect(screen.queryByLabelText('More options')).toBeNull();
    });

    it('the tooltip leads with the full name, then the description (a narrow sidebar cuts names short)', () => {
        const { container } = render(<RoutineRow routine={routine({ description: 'Files every invoice.' })} kind="automation" selected={false} onSelect={vi.fn()} />);
        const titles = [...container.querySelectorAll('[title]')].map(el => el.getAttribute('title'));
        expect(titles).toContain('My automation\nFiles every invoice.');
        const meta = screen.getByTestId('routine-row-meta');
        expect(meta.getAttribute('title')).toBe(meta.textContent);
    });
});
