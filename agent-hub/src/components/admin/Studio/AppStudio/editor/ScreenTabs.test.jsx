import { DndContext } from '@dnd-kit/core';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ScreenTabs from './ScreenTabs';
import { AppEditorProvider } from '../state/AppEditorContext';
import { KITCHEN_SINK } from '../state/sampleDefinitions';

function renderTabs() {
    const onCommit = vi.fn();
    const utils = render(
        <AppEditorProvider app={{ definition: KITCHEN_SINK, version: 1 }}>
            <DndContext>
                <ScreenTabs onCommit={onCommit} />
            </DndContext>
        </AppEditorProvider>,
    );
    return { onCommit, ...utils };
}

describe('ScreenTabs', () => {
    it('renders a tab per screen and a pinned add button', () => {
        renderTabs();
        for (const s of KITCHEN_SINK.screens) {
            // Anchored: "Dashboard", not its "Screen options for Dashboard" kebab.
            expect(screen.getByRole('button', { name: new RegExp(`^${s.name}`) })).toBeInTheDocument();
        }
        expect(screen.getByRole('button', { name: 'Add screen' })).toBeInTheDocument();
    });

    it('opens the screen-options menu in a portal, so the strip cannot clip it', () => {
        renderTabs();
        fireEvent.click(screen.getAllByRole('button', { name: /Screen options for/ })[0]);

        const menu = screen.getByRole('menu');
        // AnchoredMenu portals to <body>: a `top-full` panel inside the
        // horizontally scrolling tab row was clipped to the ~40px strip.
        expect(menu.closest('[data-anchored-menu]')).not.toBeNull();
        expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: 'Set as home screen' })).toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: 'Manage navigation…' })).toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: 'Delete screen' })).toBeInTheDocument();
    });

    it('adds a screen from the pinned + button and commits the new definition', () => {
        const { onCommit } = renderTabs();
        fireEvent.click(screen.getByRole('button', { name: 'Add screen' }));
        expect(onCommit).toHaveBeenCalledTimes(1);
        const def = onCommit.mock.calls[0][0];
        expect(def.screens).toHaveLength(KITCHEN_SINK.screens.length + 1);
    });

    it('deleting asks for confirmation before committing', () => {
        const { onCommit } = renderTabs();
        fireEvent.click(screen.getAllByRole('button', { name: /Screen options for/ })[0]);
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete screen' }));

        // Nothing committed yet — the ConfirmDialog owns the decision.
        expect(onCommit).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Delete screen' }));
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit.mock.calls[0][0].screens).toHaveLength(KITCHEN_SINK.screens.length - 1);
    });
});
