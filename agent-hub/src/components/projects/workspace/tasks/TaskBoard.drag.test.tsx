import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import TaskBoard from './TaskBoard';

const task = { id: 'a', title: 'Drag this card', status: 'todo', priority: 'normal', labels: [], links: [], checklist: [], assigneeIds: [], dueDate: null, sortOrder: 1 } as unknown as ProjectTask;
// After a drop, dnd-kit keeps a capture-phase click blocker on `document` for
// 50 ms (MouseSensor detach). Wait it out, or the next test's first click lands
// inside that window and is swallowed — which only shows on a fast runner.
afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise(resolve => setTimeout(resolve, 60));
});

function renderBoard(canEdit = true) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const column = this.closest('[data-status]') as HTMLElement | null;
        const left = column?.dataset.status === 'done' ? 600 : column?.dataset.status === 'doing' ? 300 : 0;
        const card = !!this.closest('[data-testid="board-task-a"]') || this.tagName === 'LI';
        return { x: left, y: card ? 50 : 0, left, top: card ? 50 : 0, right: left + 280, bottom: card ? 160 : 500, width: 280, height: card ? 110 : 500, toJSON: () => ({}) };
    });
    const onMove = vi.fn(), onOpen = vi.fn();
    render(<TaskBoard tasks={[task]} canEdit={canEdit} people={{} as never} onMove={onMove} onOpen={onOpen} />);
    return { onMove, onOpen };
}

describe('board mouse gestures with the real drag sensors', () => {
    it.each(['card', 'title', 'handle'])('moves using the %s without opening the task', async target => {
        const { onMove, onOpen } = renderBoard();
        const node = target === 'card' ? screen.getByTestId('board-task-a') : screen.getByRole('button', { name: target === 'handle' ? 'Drag task: Drag this card' : 'Drag this card' });
        fireEvent.mouseDown(node, { button: 0, clientX: 80, clientY: 90 });
        fireEvent.mouseMove(document, { clientX: 100, clientY: 90 });
        await waitFor(() => expect(screen.getByTestId('board-task-a')).toHaveClass('opacity-40'));
        fireEvent.mouseMove(document, { clientX: 700, clientY: 200 });
        fireEvent.mouseUp(document);
        await waitFor(() => expect(onMove).toHaveBeenCalledWith(task, 'done', null));
        expect(onOpen).not.toHaveBeenCalled();
    });
    it('opens on an ordinary click and does not start dragging from the action menu', () => {
        const { onOpen, onMove } = renderBoard();
        fireEvent.click(screen.getByRole('button', { name: 'Drag this card' }));
        expect(onOpen).toHaveBeenCalledOnce();
        fireEvent.mouseDown(screen.getByLabelText('Task actions'), { button: 0, clientX: 80, clientY: 90 });
        fireEvent.mouseMove(document, { clientX: 700, clientY: 200 });
        fireEvent.mouseUp(document);
        expect(onMove).not.toHaveBeenCalled();
    });
    it('does not drag read-only cards', () => {
        const { onMove } = renderBoard(false);
        fireEvent.mouseDown(screen.getByTestId('board-task-a'), { button: 0, clientX: 80, clientY: 90 });
        fireEvent.mouseMove(document, { clientX: 700, clientY: 200 });
        fireEvent.mouseUp(document);
        expect(onMove).not.toHaveBeenCalled();
    });
});
