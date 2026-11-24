// The one status vocabulary of a task (./coworkTaskStatus.ts): Done · Failed · Needs you · Scheduled · Running ·
// Testing · Paused · Nothing to do, from the task and the cards that wait for its owner.
import { describe, expect, it } from 'vitest';
import { taskStatus, taskStatusLabel } from './coworkTaskStatus';
import type { NeedCardKind } from './coworkNeedsModel';
import type { CoworkItem } from '@/api/cowork.types';

const item = (over: Partial<CoworkItem> = {}): CoworkItem => ({
    id: 'w1', title: 'Weekly digest', prompt: 'Summarise the week', isActive: true, repeatInterval: 'weekly',
    lastStatus: 'success', lastRunAt: '2026-11-23T08:00:00.000Z', runCount: 3, ...over,
});
const card = (kind: NeedCardKind, itemId = 'w1') => ({ itemId, kind });
const t = (_key: string | undefined, fallback?: unknown) => String(fallback);

describe('taskStatus', () => {
    it('a good last run is Done; one that found nothing to do says so', () => {
        expect(taskStatus(item())).toBe('done');
        expect(taskStatus(item(), [], { outcome: 'nothing_to_do' })).toBe('nothing');
    });

    it('never ran: Scheduled', () => {
        expect(taskStatus(item({ lastStatus: null, lastRunAt: null, runCount: 0 }))).toBe('scheduled');
    });

    it('Testing while Cowork sets up its steps, Running while a run is open', () => {
        expect(taskStatus(item(), [card('fix')], { testing: true })).toBe('testing');
        expect(taskStatus(item({ lastStatus: 'running' }))).toBe('running');
        expect(taskStatus(item({ lastStatus: 'success', currentRunStartedAt: '2026-11-24T08:00:00.000Z' }))).toBe('running');
    });

    it('a card that says something is wrong makes it Failed, one that asks makes it Needs you; only its own cards count', () => {
        for (const kind of ['fix', 'repair', 'sign_in'] as const) expect(taskStatus(item(), [card(kind)])).toBe('failed');
        for (const kind of ['check', 'first_test', 'send', 'review', 'hand_off', 'invitation'] as const) expect(taskStatus(item(), [card(kind)])).toBe('needs');
        expect(taskStatus(item(), [card('check'), card('fix')])).toBe('failed');
        expect(taskStatus(item(), [card('fix', 'someone-else')])).toBe('done');
    });

    it('a last run that failed, or a sign-in that ran out, is Failed, also when the server paused the task for it', () => {
        expect(taskStatus(item({ lastStatus: 'error' }))).toBe('failed');
        expect(taskStatus(item({ lastStatus: 'needs_reauth', isActive: false }))).toBe('failed');
        expect(taskStatus(item({ lastStatus: 'incomplete' }))).toBe('failed');
    });

    it('switched off while it would start by itself: Paused, over a question; a finished one-off stays Done', () => {
        expect(taskStatus(item({ isActive: false }))).toBe('paused');
        expect(taskStatus(item({ isActive: false }), [card('first_test')])).toBe('paused');
        expect(taskStatus(item({ isActive: false, triggerKind: 'app_event', repeatInterval: null }))).toBe('paused');
        expect(taskStatus(item({ isActive: false, repeatInterval: null }))).toBe('done');
    });

    it('a run that waits for a decision or a review is Needs you without a card too', () => {
        expect(taskStatus(item({ lastStatus: 'waiting' }))).toBe('needs');
        expect(taskStatus(item({ lastStatus: 'needs_review' }))).toBe('needs');
    });

    it('says each status in the shared words', () => {
        expect(['done', 'failed', 'needs', 'scheduled', 'running', 'testing', 'paused', 'nothing'].map((s) => taskStatusLabel(s as never, t)))
            .toEqual(['Done', 'Failed', 'Needs you', 'Scheduled', 'Running', 'Testing', 'Paused', 'Nothing to do']);
    });
});
