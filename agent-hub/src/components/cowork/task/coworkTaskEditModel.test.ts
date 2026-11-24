// The edit view as data (./coworkTaskEditModel.ts): "Save and test" exactly when the steps must be made again, what a
// save sends for each start, and which start goes through PUT /start.
import { describe, expect, it } from 'vitest';
import { changeOf, draftOf, mustRebuild, startChoiceOf } from './coworkTaskEditModel';
import type { CoworkItem } from '@/api/cowork.types';

const ITEM: CoworkItem = {
    id: 'w1', title: 'Weekly digest', prompt: 'Sum up the week.', isActive: true, repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '09:00',
    nextRunAt: '2026-11-30T08:00:00.000Z', runCount: 3, agentId: null,
};
const NOW = new Date('2026-11-24T10:00:00');

describe('coworkTaskEditModel', () => {
    it('asks to rebuild the steps of a task with fixed steps when its sentence or its start changes, not for a new name or time', () => {
        const initial = draftOf(ITEM, null, 'steps', NOW);
        expect(mustRebuild({ ...initial, title: 'Monday digest', time: '07:30' }, initial)).toBe(false);
        expect(mustRebuild({ ...initial, prompt: 'Sum up the week, and the open invoices.' }, initial)).toBe(true);
        expect(mustRebuild({ ...initial, kind: 'webhook' }, initial)).toBe(true);
    });

    it('rebuilds when the task becomes fixed steps, never when it becomes the AI or an agent', () => {
        const initial = draftOf(ITEM, null, 'ai', NOW);
        expect(mustRebuild({ ...initial, mode: 'steps' }, initial)).toBe(true);
        expect(mustRebuild({ ...initial, mode: 'agent', agentId: 'ag1', prompt: 'Other' }, initial)).toBe(false);
    });

    it('sends the clock for a schedule, the trigger for a mail, and nothing of the clock for a start on an event', () => {
        const initial = draftOf(ITEM, null, 'ai', NOW);
        const clock = changeOf({ ...initial, repeat: 'weekly', days: ['wed', 'mon'] }, NOW);
        expect(clock).toMatchObject({ title: 'Weekly digest', triggerKind: 'schedule', repeatInterval: 'weekly', daysOfWeek: ['mon', 'wed'], timeOfDay: '09:00', agentId: null });
        expect(changeOf({ ...initial, kind: 'email', mode: 'agent', agentId: 'ag1' }, NOW)).toMatchObject({ triggerKind: 'app_event', agentId: 'ag1', trigger: { provider: 'gmail', event: 'mail.new' } });
        expect(changeOf({ ...initial, kind: 'row', tableId: 't1' }, NOW)).toEqual({ title: 'Weekly digest', prompt: 'Sum up the week.', agentId: null });
    });

    it('saves a start on an event through PUT /start only when it is new or points elsewhere', () => {
        const initial = draftOf(ITEM, { kind: 'row', after: null, datatableId: 't1', inFolder: null, hasAddress: false }, 'ai', NOW);
        expect(initial.kind).toBe('row');
        expect(startChoiceOf(initial, initial)).toBeNull();
        expect(startChoiceOf({ ...initial, tableId: 't2' }, initial)).toEqual({ kind: 'row', datatableId: 't2' });
        expect(startChoiceOf({ ...initial, kind: 'webhook' }, initial)).toEqual({ kind: 'webhook' });
        expect(startChoiceOf({ ...initial, kind: 'schedule' }, initial)).toEqual({ kind: 'schedule' });
    });
});
