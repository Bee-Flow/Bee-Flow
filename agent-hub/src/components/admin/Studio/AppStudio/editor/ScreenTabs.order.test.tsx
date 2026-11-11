import { DndContext } from '@dnd-kit/core';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import ScreenTabs from './ScreenTabs';
import { reorderTarget, SCREEN_DRAG_TYPE } from './screenOrder';
import { AppEditorProvider } from '../state/AppEditorContext';
import { KITCHEN_SINK } from '../state/sampleDefinitions';
import type { AppDefinition } from '../inspector/appDefinition';

function renderTabs() {
    const onCommit = vi.fn();
    render(
        <AppEditorProvider app={{ definition: KITCHEN_SINK, version: 1 }}>
            <DndContext>
                <ScreenTabs onCommit={onCommit} />
            </DndContext>
        </AppEditorProvider>,
    );
    return { onCommit, last: (): AppDefinition => onCommit.mock.calls[onCommit.mock.calls.length - 1][0] };
}

const ids = (def: AppDefinition) => (def.screens || []).map((s) => s.id);
const BASE = ids(KITCHEN_SINK);
const names = (KITCHEN_SINK.screens || []).map((s) => s.name as string);

async function openMenu(user: ReturnType<typeof userEvent.setup>, index: number) {
    await user.click(screen.getByRole('button', { name: `Screen options for ${names[index]}` }));
}

describe('ScreenTabs — order and copies', () => {
    it('moves a screen right and left from its menu; the ends are disabled', async () => {
        const user = userEvent.setup();
        const { onCommit, last } = renderTabs();
        await openMenu(user, 0);
        expect(screen.getByRole('menuitem', { name: 'Move left' })).toBeDisabled();
        await user.click(screen.getByRole('menuitem', { name: 'Move right' }));
        expect(ids(last())).toEqual([BASE[1], BASE[0], ...BASE.slice(2)]);
        await openMenu(user, BASE.length - 1);
        expect(screen.getByRole('menuitem', { name: 'Move right' })).toBeDisabled();
        await user.click(screen.getByRole('menuitem', { name: 'Move left' }));
        expect(onCommit).toHaveBeenCalledTimes(2);
    });

    it('duplicates a screen right after itself under a "copy" name', async () => {
        const user = userEvent.setup();
        const { last } = renderTabs();
        await openMenu(user, 0);
        await user.click(screen.getByRole('menuitem', { name: 'Duplicate screen' }));
        const next = ids(last());
        expect(next).toHaveLength(BASE.length + 1);
        expect(next[0]).toBe(BASE[0]);
        expect(BASE).not.toContain(next[1]);
        expect(last().screens![1].name).toBe(`${names[0]} copy`);
    });

    it('drops a dragged tab before the tab it lands on', () => {
        const { last } = renderTabs();
        const tab = (i: number) => screen.getByRole('button', { name: new RegExp(`^${names[i]}`) }).closest('[draggable]') as HTMLElement;
        const store: Record<string, string> = {};
        const dataTransfer = {
            get types() { return Object.keys(store); },
            setData: (k: string, v: string) => { store[k] = v; },
            getData: (k: string) => store[k],
            effectAllowed: 'all', dropEffect: 'none',
        };
        fireEvent.dragStart(tab(1), { dataTransfer });
        expect(store[SCREEN_DRAG_TYPE]).toBe(BASE[1]);
        // jsdom has no DragEvent, so the event carries no clientX: it lands on the near half, "before".
        fireEvent.dragOver(tab(0), { dataTransfer });
        expect(tab(0)).toHaveAttribute('data-screentab-drop', 'before');
        fireEvent.drop(tab(0), { dataTransfer });
        expect(ids(last())).toEqual([BASE[1], BASE[0], ...BASE.slice(2)]);
        expect(tab(0)).not.toHaveAttribute('data-screentab-drop');
    });

    it('ignores a drag that did not start on a screen tab', () => {
        const { onCommit } = renderTabs();
        const tab = screen.getByRole('button', { name: new RegExp(`^${names[0]}`) }).closest('[draggable]') as HTMLElement;
        const dataTransfer = { types: ['Files'], setData: () => {}, getData: () => '', effectAllowed: 'all', dropEffect: 'none' };
        fireEvent.dragOver(tab, { dataTransfer });
        fireEvent.drop(tab, { dataTransfer });
        expect(tab).not.toHaveAttribute('data-screentab-drop');
        expect(onCommit).not.toHaveBeenCalled();
    });

    it('reorderTarget counts the landing place without the dragged tab', () => {
        expect(reorderTarget(0, 2, true)).toBe(2);
        expect(reorderTarget(0, 2, false)).toBe(1);
        expect(reorderTarget(3, 1, false)).toBe(1);
        expect(reorderTarget(3, 1, true)).toBe(2);
        expect(reorderTarget(1, 1, true)).toBe(1);
    });
});
