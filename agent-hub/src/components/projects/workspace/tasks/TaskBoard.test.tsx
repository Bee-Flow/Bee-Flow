import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DragEndEvent } from '@dnd-kit/core';
import type { BoardColumn } from '../../../../api/queries/projectBoard';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
const dnd = vi.hoisted(() => ({ end: null as null | ((e: DragEndEvent) => void) }));
vi.mock('@dnd-kit/core', async original => ({
    ...await original<typeof import('@dnd-kit/core')>(),
    DndContext: ({ onDragEnd, children }: { onDragEnd: (e: DragEndEvent) => void; children: React.ReactNode }) => { dnd.end = onDragEnd; return <>{children}</>; },
    DragOverlay: () => null,
}));
import TaskBoard from './TaskBoard';

const people = { nameOf: (id: string) => (id === 'u1' ? 'Eddie Editor' : ''), avatarOf: () => undefined, colorOf: () => '#888888' } as never;
const make = (id: string, extra: Partial<ProjectTask> = {}) => ({
    id, status: 'todo', title: id.toUpperCase(), labels: [], links: [], checklist: [], assigneeIds: [], priority: 'normal', dueDate: null, sortOrder: 1, ...extra,
}) as unknown as ProjectTask;
const COLUMNS: BoardColumn[] = [
    { id: 'todo', title: '', status: 'todo', wipLimit: null },
    { id: 'doing', title: '', status: 'doing', wipLimit: 1 },
    { id: 'done', title: '', status: 'done', wipLimit: null },
];

describe('board drop destinations', () => {
    it('appends within the same column and preserves insertion before another card', () => {
        const tasks = [make('a', { sortOrder: 1 }), make('b', { sortOrder: 2 })];
        const move = vi.fn();
        render(<TaskBoard tasks={tasks} canEdit people={people} onOpen={vi.fn()} onMove={move} />);
        const drop = (over: string) => dnd.end?.({ active: { id: 'a' }, over: { id: over } } as DragEndEvent);
        drop('column:todo'); expect(move).toHaveBeenLastCalledWith(tasks[0], 'todo', null);
        drop('card:b'); expect(move).toHaveBeenLastCalledWith(tasks[0], 'todo', 'b');
        drop('column:done'); expect(move).toHaveBeenLastCalledWith(tasks[0], 'done', null);
        move.mockClear(); drop('card:a'); expect(move).not.toHaveBeenCalled();
    });
});

describe('board cards and lanes', () => {
    it('moves, opens and deletes a card from its actions menu', async () => {
        const user = userEvent.setup();
        const task = make('a');
        const onMove = vi.fn(), onOpen = vi.fn(), onDelete = vi.fn();
        render(<TaskBoard tasks={[task]} columns={COLUMNS} canEdit people={people} onOpen={onOpen} onMove={onMove} onDelete={onDelete} />);
        await user.click(within(screen.getByTestId('board-task-a')).getByRole('button', { name: 'Task actions' }));
        const menu = screen.getByRole('menu', { name: 'Task actions' });
        expect(within(menu).getByRole('menuitem', { name: 'To do' })).toHaveAttribute('aria-current', 'true');
        await user.click(within(menu).getByRole('menuitem', { name: 'In progress' }));
        expect(onMove).toHaveBeenCalledWith(task, 'doing', null, 'doing');
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Task actions' }));
        await user.click(screen.getByRole('menuitem', { name: 'Open' }));
        expect(onOpen).toHaveBeenCalledWith(task);

        await user.click(screen.getByRole('button', { name: 'Task actions' }));
        await user.click(screen.getByTestId('delete-task-a'));
        expect(onDelete).toHaveBeenCalledWith(task);
    });

    it('leaves Delete out of the menu for a task the reader may not delete, and the menu off for a viewer', async () => {
        const user = userEvent.setup();
        const { unmount } = render(<TaskBoard tasks={[make('a')]} canEdit people={people} onOpen={vi.fn()} onMove={vi.fn()} onDelete={vi.fn()} mayDelete={() => false} />);
        await user.click(screen.getByRole('button', { name: 'Task actions' }));
        expect(screen.queryByTestId('delete-task-a')).not.toBeInTheDocument();
        unmount();
        render(<TaskBoard tasks={[make('a')]} canEdit={false} people={people} onOpen={vi.fn()} onMove={vi.fn()} onConfigure={vi.fn()} onCreate={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Task actions' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Drag task/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Column actions/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Add task' })).not.toBeInTheDocument();
    });

    it('shows one count per lane: the WIP limit as n/limit, a warning above it, and the shown count when filtered', () => {
        const all = [make('a', { status: 'doing' }), make('b', { status: 'doing' }), make('c'), make('d')];
        render(<TaskBoard tasks={[all[0], all[1], all[2]]} allTasks={all} columns={COLUMNS} canEdit people={people} onOpen={vi.fn()} onMove={vi.fn()} />);
        const doing = within(screen.getByTestId('board-column-doing'));
        expect(doing.getByText('2/1')).toHaveAttribute('title', 'Above the work in progress limit');
        expect(doing.getByRole('status')).toHaveTextContent('Above the work in progress limit');
        expect(within(screen.getByTestId('board-column-todo')).getByText('1')).toHaveAttribute('title', '1 of 2 shown');
        expect(within(screen.getByTestId('board-column-done')).getByText('No tasks here yet')).toBeInTheDocument();
    });

    it('puts the people, the type and the facts on the card, and nobody as a silent "Not assigned"', () => {
        const tasks = [make('a', { assigneeIds: ['u1'], itemType: 'epic', labels: ['x', 'y', 'z'], checklist: [{ id: '1', text: 'a', done: true }] } as Partial<ProjectTask>), make('b')];
        render(<TaskBoard tasks={tasks} canEdit people={people} onOpen={vi.fn()} onMove={vi.fn()} />);
        const a = within(screen.getByTestId('board-task-a'));
        expect(a.getByTestId('task-assignees')).toHaveTextContent('Eddie Editor');
        expect(a.getByText('Epic')).toBeInTheDocument();
        expect(a.getByText('+1')).toBeInTheDocument();
        expect(a.getByText('1/1')).toBeInTheDocument();
        expect(within(screen.getByTestId('board-task-b')).getByTestId('task-unassigned')).toHaveClass('sr-only');
    });

});

describe('board lane controls', () => {
    it('opens the column settings at the right field from the lane menu', async () => {
        const user = userEvent.setup();
        const onConfigure = vi.fn();
        render(<TaskBoard tasks={[]} columns={COLUMNS} canEdit people={people} onOpen={vi.fn()} onMove={vi.fn()} onConfigure={onConfigure} />);
        await user.click(screen.getByRole('button', { name: 'Column actions: In progress' }));
        await user.click(screen.getByRole('menuitem', { name: 'Set WIP limit' }));
        expect(onConfigure).toHaveBeenLastCalledWith({ columnId: 'doing', field: 'wip' });
        await user.click(screen.getByRole('button', { name: 'Column actions: Done' }));
        await user.click(screen.getByRole('menuitem', { name: 'Rename column' }));
        expect(onConfigure).toHaveBeenLastCalledWith({ columnId: 'done', field: 'title' });
        await user.click(screen.getByRole('button', { name: 'Column actions: To do' }));
        await user.click(screen.getByRole('menuitem', { name: 'Configure board' }));
        expect(onConfigure).toHaveBeenLastCalledWith(undefined);
    });

    it('adds a task with Enter, keeps Shift+Enter as a new line, and cancels with Escape', async () => {
        const user = userEvent.setup();
        const onCreate = vi.fn().mockResolvedValue(undefined);
        render(<TaskBoard tasks={[]} columns={COLUMNS} canEdit people={people} onOpen={vi.fn()} onMove={vi.fn()} onCreate={onCreate} />);
        await user.click(screen.getByRole('button', { name: 'Add task to In progress' }));
        const box = within(screen.getByTestId('board-column-doing')).getByRole('textbox', { name: 'What needs to be done?' });
        await user.type(box, 'Write{Shift>}{Enter}{/Shift}more');
        expect(onCreate).not.toHaveBeenCalled();
        await user.type(box, '{Enter}');
        expect(onCreate).toHaveBeenCalledWith('doing', 'Write\nmore');
        expect(box).toHaveValue('');
        await user.type(box, '{Escape}');
        expect(within(screen.getByTestId('board-column-doing')).queryByRole('textbox')).not.toBeInTheDocument();
        await user.click(within(screen.getByTestId('board-column-todo')).getByRole('button', { name: 'Add task' }));
        expect(within(screen.getByTestId('board-column-todo')).getByRole('textbox', { name: 'What needs to be done?' })).toHaveFocus();
    });
});
