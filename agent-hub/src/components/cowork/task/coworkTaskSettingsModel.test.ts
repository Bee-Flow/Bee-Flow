// A task's Settings as data (./coworkTaskSettingsModel.ts): "Save and test" exactly when the steps must be made again,
// what a save of each row sends (its own fields, nothing else), and which start goes through PUT /start.
import { describe, expect, it } from 'vitest';
import { canSave, changeOf, draftOf, mustRebuild, rowChanged, saveEffect, startChoiceOf } from './coworkTaskSettingsModel';
import type { CoworkItem } from '@/api/cowork.types';

const ITEM: CoworkItem = {
    id: 'w1', title: 'Weekly digest', prompt: 'Sum up the week.', isActive: true, repeatInterval: 'weekly', daysOfWeek: ['mon'], timeOfDay: '09:00',
    nextRunAt: '2026-11-30T08:00:00.000Z', runCount: 3, agentId: null, enabledApps: ['outlook'],
};
const NOW = new Date('2026-11-24T10:00:00');

describe('coworkTaskSettingsModel', () => {
    it('asks to rebuild the steps of a task with fixed steps when its sentence, its start or its apps change, not for a new name or time', () => {
        const initial = draftOf(ITEM, null, 'steps', NOW);
        expect(mustRebuild({ ...initial, title: 'Monday digest', time: '07:30' }, initial)).toBe(false);
        expect(mustRebuild({ ...initial, prompt: 'Sum up the week, and the open invoices.' }, initial)).toBe(true);
        expect(mustRebuild({ ...initial, kind: 'webhook' }, initial)).toBe(true);
        expect(mustRebuild({ ...initial, apps: ['outlook', 'web-search'] }, initial)).toBe(true);
        expect(mustRebuild({ ...initial, apps: ['outlook'] }, initial)).toBe(false);
    });

    it('rebuilds when the task becomes fixed steps, never when it becomes the AI or an agent', () => {
        const initial = draftOf(ITEM, null, 'ai', NOW);
        expect(mustRebuild({ ...initial, mode: 'steps' }, initial)).toBe(true);
        expect(mustRebuild({ ...initial, mode: 'agent', agentId: 'ag1', prompt: 'Other' }, initial)).toBe(false);
        expect(mustRebuild({ ...initial, apps: [] }, initial)).toBe(false);
    });

    it('says what a save does to the steps: made again, taken off, kept, or nothing to say for a task without fixed steps', () => {
        const fixed = draftOf(ITEM, null, 'steps', NOW);
        expect(saveEffect({ ...fixed, prompt: 'Other' }, fixed)).toBe('rebuild');
        expect(saveEffect({ ...fixed, mode: 'ai' }, fixed)).toBe('drops_steps');
        expect(saveEffect({ ...fixed, mode: 'agent', agentId: 'ag1' }, fixed)).toBe('drops_steps');
        expect(saveEffect({ ...fixed, title: 'Monday digest' }, fixed)).toBe('keeps_steps');
        const byAi = draftOf(ITEM, null, 'ai', NOW);
        expect(saveEffect({ ...byAi, title: 'Monday digest' }, byAi)).toBe('plain');
        expect(saveEffect({ ...byAi, mode: 'steps' }, byAi)).toBe('rebuild');
    });

    it('sends only the fields of the row that is saved: a new name never moves the clock', () => {
        const initial = draftOf(ITEM, null, 'ai', NOW);
        expect(changeOf('what', { ...initial, title: ' Monday digest ', time: '07:30' }, NOW)).toEqual({ title: 'Monday digest', prompt: 'Sum up the week.' });
        expect(changeOf('uses', { ...initial, apps: ['outlook', 'web-search'] }, NOW)).toEqual({ agentId: null, enabledApps: ['outlook', 'web-search'] });
        expect(changeOf('uses', { ...initial, apps: null, mode: 'agent', agentId: 'ag1' }, NOW)).toEqual({ agentId: 'ag1' });
    });

    it('sends the clock for a schedule, the trigger for a mail, and nothing for a start on another event', () => {
        const initial = draftOf(ITEM, null, 'ai', NOW);
        const clock = changeOf('when', { ...initial, repeat: 'weekly', days: ['wed', 'mon'] }, NOW);
        expect(clock).toMatchObject({ triggerKind: 'schedule', repeatInterval: 'weekly', daysOfWeek: ['mon', 'wed'], timeOfDay: '09:00' });
        expect(clock).not.toHaveProperty('title');
        expect(changeOf('when', { ...initial, kind: 'email' }, NOW)).toMatchObject({ triggerKind: 'app_event', trigger: { provider: 'gmail', event: 'mail.new' } });
        expect(changeOf('when', { ...initial, kind: 'row', tableId: 't1' }, NOW)).toBeNull();
    });

    it('saves a start on an event through PUT /start only when it is new or points elsewhere', () => {
        const initial = draftOf(ITEM, { kind: 'row', after: null, datatableId: 't1', inFolder: null, hasAddress: false }, 'ai', NOW);
        expect(initial.kind).toBe('row');
        expect(startChoiceOf(initial, initial)).toBeNull();
        expect(startChoiceOf({ ...initial, tableId: 't2' }, initial)).toEqual({ kind: 'row', datatableId: 't2' });
        expect(startChoiceOf({ ...initial, kind: 'webhook' }, initial)).toEqual({ kind: 'webhook' });
        expect(startChoiceOf({ ...initial, kind: 'schedule' }, initial)).toEqual({ kind: 'schedule' });
    });

    it('knows which row has something to save, and what each row needs first', () => {
        const initial = draftOf(ITEM, null, 'ai', NOW);
        expect([rowChanged('what', initial, initial), rowChanged('when', initial, initial), rowChanged('uses', initial, initial)]).toEqual([false, false, false]);
        const renamed = { ...initial, title: 'Monday digest' };
        expect([rowChanged('what', renamed, initial), rowChanged('when', renamed, initial)]).toEqual([true, false]);
        expect(rowChanged('what', { ...initial, title: 'Weekly digest  ' }, initial)).toBe(false);
        expect(rowChanged('uses', { ...initial, apps: [] }, initial)).toBe(true);
        expect(canSave('what', { ...initial, prompt: '  ' })).toBe(false);
        expect(canSave('when', { ...initial, kind: 'file', folder: 'Invoices' })).toBe(false);
        expect(canSave('when', { ...initial, kind: 'file', folder: '/Invoices' })).toBe(true);
        expect(canSave('when', { ...initial, repeat: 'weekly', days: [] })).toBe(false);
        expect(canSave('uses', { ...initial, mode: 'agent', agentId: '' })).toBe(false);
    });
});
