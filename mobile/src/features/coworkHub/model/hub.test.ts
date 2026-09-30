/**
 * What the Cowork hub puts first. "Needs you" is four cards at most, so the
 * rules that decide who gets a card — failed or waiting, recent, one per
 * routine — are the section; "Coming up" merges tasks and reminders by time.
 */

import type { AutomationRun } from '@/features/automations';

import { NEEDS_YOU_WINDOW_MS, buildUpcoming, selectNeedsYou } from './hub';

const NOW = Date.parse('2026-09-24T12:00:00Z');

function run(id: string, over: Partial<AutomationRun> = {}): AutomationRun {
    return {
        id,
        automationId: `auto-${id}`,
        version: 1,
        userId: 'u1',
        triggerKind: 'schedule',
        triggerPayload: null,
        mode: 'live',
        status: 'error',
        startedAt: '2026-09-24T11:00:00Z',
        finishedAt: null,
        durationMs: null,
        error: 'boom',
        summary: null,
        parentRunId: null,
        rootRunId: id,
        cancelRequested: false,
        awaitingStepId: null,
        awaitingStepExpiresAt: null,
        errorClass: null,
        handledErrorCount: 0,
        ...over,
    };
}

describe('selectNeedsYou', () => {
    it('keeps failed and waiting runs and drops the ones that went fine', () => {
        const picked = selectNeedsYou(
            [run('a'), run('b', { status: 'success' }), run('c', { status: 'awaiting_approval' })],
            NOW,
        );
        expect(picked.map((r) => r.id)).toEqual(['a', 'c']);
    });

    it('ages out an old failure but never an old decision', () => {
        const old = new Date(NOW - NEEDS_YOU_WINDOW_MS - 60_000).toISOString();
        const picked = selectNeedsYou(
            [run('a', { startedAt: old }), run('b', { startedAt: old, status: 'awaiting_approval' })],
            NOW,
        );
        expect(picked.map((r) => r.id)).toEqual(['b']);
    });

    it('keeps a failure with no start time, which cannot be aged on evidence', () => {
        expect(selectNeedsYou([run('a', { startedAt: null })], NOW)).toHaveLength(1);
    });

    it('shows one card per routine, and four at most', () => {
        const sameRoutine = [run('a'), run('b', { automationId: 'auto-a' })];
        expect(selectNeedsYou(sameRoutine, NOW).map((r) => r.id)).toEqual(['a']);
        const many = ['1', '2', '3', '4', '5', '6'].map((id) => run(id));
        expect(selectNeedsYou(many, NOW)).toHaveLength(4);
    });
});

describe('buildUpcoming', () => {
    it('merges active tasks and reminders by time, five at most', () => {
        const tasks = [
            { id: 't1', title: 'Digest', nextRunAt: '2099-01-03T09:00:00Z', isActive: true },
            { id: 't2', title: 'Paused', nextRunAt: '2099-01-01T09:00:00Z', isActive: false },
            { id: 't3', title: 'Unscheduled', nextRunAt: null, isActive: true },
        ];
        const reminders = [
            { id: 'r1', title: 'Call back', remindAt: '2099-01-02T09:00:00Z' },
            { id: 'r2', title: 'No time', remindAt: null },
        ];
        const items = buildUpcoming(tasks, reminders);
        expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(['reminder:r1', 'task:t1']);
        expect(items.every((i) => !i.overdue)).toBe(true);
    });

    it('marks what is already due', () => {
        const [item] = buildUpcoming([], [{ id: 'r1', title: 'Late', remindAt: '2000-01-01T00:00:00Z' }]);
        expect(item?.overdue).toBe(true);
    });

    it('caps the list at five', () => {
        const reminders = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
            id: `r${n}`,
            title: `R${n}`,
            remindAt: `2099-01-0${n}T09:00:00Z`,
        }));
        expect(buildUpcoming([], reminders)).toHaveLength(5);
    });
});
