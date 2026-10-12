import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import TaskPlanning from './TaskPlanning';
import { addDays, monday } from './taskPlanning';
import { todayKey } from './taskText';

afterEach(() => vi.restoreAllMocks());

describe('timeline dragging across the visible period', () => {
    it.each([
        ['start', 'Adjust start', -58, -116],
        ['end', 'Adjust end', 580, 638],
        ['move', 'Move schedule', -580, -638],
    ] as const)('keeps the task data when the %s handle disappears during dragging', async (mode, label, firstDelta, finalDelta) => {
        const first = monday(todayKey());
        const task: ProjectTask = {
            id: 'a', title: 'Scheduled work', description: '', status: 'todo', priority: 'normal',
            labels: [], checklist: [], sortOrder: 1, source: null, assigneeIds: [], links: [],
            startDate: first, dueDate: addDays(first, 5), createdBy: 'u1', completedAt: null,
            createdAt: '', updatedAt: '',
        };
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            x: 300, y: 100, left: 300, top: 100, right: 648, bottom: 140, width: 348, height: 40,
            toJSON: () => ({}),
        });
        const onDates = vi.fn();
        render(<TaskPlanning projectId="p1" tasks={[task]} canEdit busy={false} people={{ nameOf: () => '' } as never} onOpen={vi.fn()} onDates={onDates} />);
        const name = `${label}: Scheduled work`;
        fireEvent.mouseDown(screen.getByRole('button', { name }), { button: 0, clientX: 400, clientY: 120 });
        fireEvent.mouseMove(document, { clientX: 410, clientY: 120 });
        fireEvent.mouseMove(document, { clientX: 400 + firstDelta, clientY: 120 });
        await waitFor(() => expect(screen.queryByRole('button', { name })).not.toBeInTheDocument());
        // The active draggable is now unmounted, and dnd-kit no longer holds
        // its task payload. Continuing and dropping must still save the dates.
        fireEvent.mouseMove(document, { clientX: 400 + finalDelta, clientY: 120 });
        fireEvent.mouseUp(document);
        const days = finalDelta / 58;
        await waitFor(() => expect(onDates).toHaveBeenCalledWith(task, {
            startDate: mode === 'end' ? first : addDays(first, days),
            dueDate: mode === 'start' ? task.dueDate : addDays(task.dueDate!, days),
        }));
        expect(screen.getByTestId('task-planning')).toBeInTheDocument();
    });
});

describe('planning sub-nav and display menu', () => {
    const base = (id: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
        id, title: `Work ${id}`, description: '', status: 'todo', priority: 'normal',
        labels: [], checklist: [], sortOrder: 1, source: null, assigneeIds: [], links: [],
        dueDate: null, createdBy: 'u1', completedAt: null, createdAt: '', updatedAt: '', ...extra,
    });
    const people = { nameOf: () => '', colorOf: () => '', avatarOf: () => undefined } as never;

    it('hides completed bars from the Display menu and lists undated work as unscheduled', async () => {
        const user = userEvent.setup();
        const today = todayKey();
        render(<TaskPlanning projectId="p1" tasks={[base('a', { startDate: today, dueDate: today }), base('b', { status: 'done', startDate: today, dueDate: today }), base('c')]}
            canEdit busy={false} people={people} onOpen={vi.fn()} onDates={vi.fn()} />);
        expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByTestId('planning-row-b')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^Work c/ })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Display' }));
        await user.click(screen.getByRole('checkbox', { name: 'Hide completed' }));
        expect(screen.queryByTestId('planning-row-b')).not.toBeInTheDocument();
        expect(screen.getByTestId('planning-row-a')).toBeInTheDocument();
    });

    it('shows the backlog as rows with its count on the tab, and plans a sprint from the overflow menu', async () => {
        const user = userEvent.setup();
        const onOpen = vi.fn();
        render(<TaskPlanning projectId="p1" tasks={[base('a'), base('b', { status: 'done' })]} canEdit busy={false} people={people} onOpen={onOpen} onDates={vi.fn()} />);
        await user.click(screen.getByRole('tab', { name: /Backlog/ }));
        expect(screen.getByRole('tab', { name: /Backlog/ })).toHaveTextContent('1');
        await user.click(screen.getByRole('button', { name: /^Work a/ }));
        expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
        await user.click(screen.getByRole('button', { name: 'More backlog actions' }));
        expect(screen.getByTestId('plan-sprint-with-poker')).toBeInTheDocument();
    });

    it('connects a dependency from a visible bar to a row outside the period', async () => {
        const user = userEvent.setup();
        const today = todayKey();
        const onDependency = vi.fn();
        const far = addDays(today, 120);
        render(<TaskPlanning projectId="p1" tasks={[base('a', { startDate: today, dueDate: today }), base('z', { startDate: far, dueDate: far })]}
            canEdit busy={false} people={people} onOpen={vi.fn()} onDates={vi.fn()} onDependency={onDependency} />);
        await user.click(screen.getByRole('button', { name: 'Connect dependency from Work a' }));
        expect(screen.getByText('Choose a task that depends on Work a')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Make Work z depend on the selected task' }));
        expect(onDependency).toHaveBeenCalledWith(expect.objectContaining({ id: 'z' }), expect.objectContaining({ id: 'a' }));
    });

    it('moves keyboard focus into the Display menu and back to its trigger', async () => {
        const user = userEvent.setup();
        render(<TaskPlanning projectId="p1" tasks={[]} canEdit busy={false} people={people} onOpen={vi.fn()} onDates={vi.fn()} />);
        const trigger = screen.getByRole('button', { name: 'Display' });
        trigger.focus();
        await user.keyboard('{Enter}');
        expect(screen.getByRole('radio', { name: 'Two weeks' })).toHaveFocus();
        await user.tab(); await user.tab();
        expect(screen.getByRole('checkbox', { name: 'Hide completed' })).toHaveFocus();
        await user.keyboard('{Escape}');
        expect(trigger).toHaveFocus();
    });
});
