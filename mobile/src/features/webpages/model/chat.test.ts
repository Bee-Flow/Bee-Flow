/**
 * The builder transcript: the web's stored rows survive a round trip through
 * the phone, a settled turn carries its plan, and a plan's answer is kept.
 */

import { emptyWebpageTurn, type WebpagePlan } from '@/shared/stream';

import {
    historyOf,
    markExecuted,
    newEntry,
    pendingPlan,
    readStoredChat,
    setPlanStatus,
    settleEntry,
    toStored,
    visibleMessages,
} from './chat';

const PLAN: WebpagePlan = { planId: 'p1', title: 'Menu', summary: 'Add a menu', steps: [] };

const WEB_ROWS = [
    { id: 'u1', role: 'user', content: 'Make a bakery page', timestamp: '2026-09-01T10:00:00Z', attachments: [] },
    {
        id: 'a1',
        role: 'assistant',
        content: 'Here is a plan',
        respondingAgentId: 'direct',
        webpagePlan: { planId: 'p1', plan: { title: 'Menu', summary: 'Add a menu', steps: [] }, status: 'pending' },
    },
    { id: 'u2', role: 'user', content: 'Approved — please build the plan.', isHidden: true },
];

describe('reading and writing the stored rows', () => {
    it('reads the web’s rows, keeping what the phone does not own', () => {
        const entries = readStoredChat(WEB_ROWS);
        expect(entries[1]?.plan).toEqual({ plan: PLAN, status: 'pending' });
        expect(entries[2]?.hidden).toBe(true);
        const stored = toStored(entries[1]!);
        expect(stored.respondingAgentId).toBe('direct');
        expect(stored.webpagePlan).toEqual(WEB_ROWS[1]!.webpagePlan);
    });

    it('draws only the visible messages, newest first', () => {
        const messages = visibleMessages(readStoredChat(WEB_ROWS));
        expect(messages.map((m) => m.id)).toEqual(['a1', 'u1']);
    });

    it('sends only user and assistant turns with text as history', () => {
        const entries = [...readStoredChat(WEB_ROWS), newEntry({ id: 'x', role: 'assistant', content: '  ' })];
        expect(historyOf(entries)).toEqual([
            { role: 'user', content: 'Make a bakery page' },
            { role: 'assistant', content: 'Here is a plan' },
            { role: 'user', content: 'Approved — please build the plan.' },
        ]);
    });
});

describe('a turn settling', () => {
    const placeholder = newEntry({ id: 'a2', role: 'assistant', content: '', streaming: true });

    it('writes the answer and its plan into the streaming placeholder only', () => {
        const turn = { ...emptyWebpageTurn(), text: 'Proposed', plan: PLAN, done: true };
        const settled = settleEntry(placeholder, turn);
        expect(settled.message).toMatchObject({ content: 'Proposed', streaming: false });
        expect(settled.message.interrupted).toBeUndefined();
        expect(settled.plan).toEqual({ plan: PLAN, status: 'pending' });
        const other = newEntry({ id: 'u', role: 'user', content: 'hi' });
        expect(settleEntry(other, turn)).toBe(other);
    });

    it('marks a turn that produced nothing as interrupted', () => {
        expect(settleEntry(placeholder, { ...emptyWebpageTurn(), done: true }).message.interrupted).toBe(true);
        expect(settleEntry(placeholder, { ...emptyWebpageTurn(), error: 'boom' }).message.error).toBe('boom');
    });
});

describe('plans', () => {
    it('finds the pending plan only on the latest answer', () => {
        const entries = readStoredChat(WEB_ROWS.slice(0, 2));
        expect(pendingPlan(entries)?.planId).toBe('p1');
        const later = [...entries, newEntry({ id: 'a3', role: 'assistant', content: 'Done' })];
        expect(pendingPlan(later)).toBeNull();
    });

    it('moves a plan from approved to executed', () => {
        const approved = setPlanStatus(readStoredChat(WEB_ROWS), 'p1', 'approved');
        expect(pendingPlan(approved)).toBeNull();
        expect(markExecuted(approved)[1]?.plan?.status).toBe('executed');
        expect(setPlanStatus(approved, 'other', 'rejected')[1]?.plan?.status).toBe('approved');
    });
});
