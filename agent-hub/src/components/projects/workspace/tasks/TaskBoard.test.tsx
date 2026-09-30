import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DragEndEvent } from '@dnd-kit/core';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
const dnd = vi.hoisted(() => ({ end: null as null | ((e: DragEndEvent) => void) }));
vi.mock('@dnd-kit/core', async original => ({
    ...await original<typeof import('@dnd-kit/core')>(),
    DndContext: ({ onDragEnd, children }: { onDragEnd: (e: DragEndEvent) => void; children: React.ReactNode }) => { dnd.end = onDragEnd; return <>{children}</>; },
    DragOverlay: () => null,
}));
vi.mock('./TaskRow', () => ({ assigneeEdge: () => ({}), TaskFacts: () => null }));
import TaskBoard from './TaskBoard';
describe('board drop destinations', () => {
    it('appends within the same column and preserves insertion before another card', () => {
        const tasks = [{ id: 'a', status: 'todo', title: 'A', labels: [], sortOrder: 1 }, { id: 'b', status: 'todo', title: 'B', labels: [], sortOrder: 2 }] as unknown as ProjectTask[];
        const move = vi.fn();
        render(<TaskBoard tasks={tasks} canEdit people={{} as never} onOpen={vi.fn()} onMove={move} />);
        const drop = (over: string) => dnd.end?.({ active: { id: 'a' }, over: { id: over } } as DragEndEvent);
        drop('column:todo'); expect(move).toHaveBeenLastCalledWith(tasks[0], 'todo', null);
        drop('card:b'); expect(move).toHaveBeenLastCalledWith(tasks[0], 'todo', 'b');
        drop('column:done'); expect(move).toHaveBeenLastCalledWith(tasks[0], 'done', null);
        move.mockClear(); drop('card:a'); expect(move).not.toHaveBeenCalled();
    });
});
