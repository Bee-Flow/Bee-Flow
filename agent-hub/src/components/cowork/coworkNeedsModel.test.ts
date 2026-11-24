// What waits for the owner, as the cards of ./CoworkNeedCard.tsx (./coworkNeedsModel.ts): from "Needs you" and from
// the desks the owner is on.
import { describe, expect, it } from 'vitest';
import { deskNeedCards, needCards, waitsForSteps } from './coworkNeedsModel';
import type { CoworkItem } from '@/api/cowork.types';
import type { DeskView } from '@/api/coworkDesks';
import type { CoworkNeed } from '@/api/coworkNeedsYou';

const need = (over: Partial<CoworkNeed>): CoworkNeed => ({ kind: 'plan', itemId: 'w1', title: 'Digest', runId: null, since: null, reason: null, plan: null, ...over });
const ITEMS: CoworkItem[] = [
    { id: 'w1', title: 'Digest', prompt: '', runCount: 4, lastRunAt: '2026-11-23T08:00:00.000Z', planAutomationId: 'auto-1' },
    { id: 'new', title: 'From a package', prompt: '', runCount: 0, lastRunAt: null, isActive: false },
];

describe('needCards', () => {
    it('a plan: tested is a check, never tested and never run is a first test, a failed test or wrong wiring is a fix', () => {
        const kinds = needCards([
            need({ plan: 'first', tried: 'passed' }),
            need({ itemId: 'new', plan: 'first', tried: null }),
            need({ plan: 'first', tried: 'failed', fixable: true }),
            need({ plan: 'first', tried: 'failed', fixable: false }),
            need({ plan: 'blocked', fixable: true }),
            need({ plan: 'blocked' }),
            need({ plan: 'gone' }),
            need({ plan: 'changed', tried: null }),
        ], ITEMS).map((c) => [c.kind, c.problem ?? null, c.changed ?? false]);
        expect(kinds).toEqual([
            ['check', null, false], ['first_test', null, false], ['fix', 'wiring', false], ['fix', 'tried_failed', false],
            ['fix', 'wiring', false], ['fix', 'blocked', false], ['fix', 'gone', false], ['check', null, true],
        ]);
    });

    it('a decision is a message to send, with the automation its approval waits in; the rest map one to one', () => {
        const cards = needCards([
            need({ kind: 'decision', runId: 'r1' }),
            need({ kind: 'review', runId: 'r2', reason: 'Two invoices look the same.' }),
            need({ kind: 'sign_in' }),
            need({ kind: 'repair', repair: { proposalId: 'pr-1', reasonCode: 'step_failed_twice', stepTitle: 'Read orders' } }),
            need({ kind: 'incomplete', runId: 'r3' }),
            need({ kind: 'ai_failed', runId: 'r4' }),
        ], ITEMS);
        expect(cards.map((c) => c.kind)).toEqual(['send', 'review', 'sign_in', 'repair', 'fix', 'fix']);
        expect(cards[0].automationId).toBe('auto-1');
        expect(cards[1].reason).toBe('Two invoices look the same.');
        expect(cards[3].repair?.proposalId).toBe('pr-1');
        expect(cards.slice(4).map((c) => c.problem)).toEqual(['incomplete', 'ai_failed']);
        expect(new Set(cards.map((c) => c.key)).size).toBe(cards.length);
    });
});

describe('needCards for what went wrong', () => {
    it('a failed last run is a fix that names its problem, the step and the app; with steps the AI is a way out', () => {
        const cards = needCards([
            need({ kind: 'failed', runId: 'r9', hasSteps: true, failure: { cause: 'permission', step: 'List last week’s meetings', source: null, app: 'Fireflies' } }),
            need({ kind: 'failed', failure: { cause: 'reads', step: 'Write the summary', source: 'Get each meeting summary', app: null } }),
            need({ kind: 'failed', failure: { cause: 'sign_in', step: null, source: null, app: 'Gmail' } }),
            need({ kind: 'failed', failure: { cause: 'nothing_found', step: 'Get each', source: null, app: null } }),
            need({ kind: 'failed', failure: { cause: 'timeout', step: null, source: null, app: null } }),
            need({ kind: 'failed', failure: { cause: 'other', step: null, source: null, app: null } }),
            need({ kind: 'failed' }),
        ], ITEMS);
        expect(cards.map((c) => [c.kind, c.problem])).toEqual([
            ['fix', 'permission'], ['fix', 'reads'], ['fix', 'signed_out'], ['fix', 'incomplete'], ['fix', 'timeout'], ['fix', 'failed'], ['fix', 'failed'],
        ]);
        expect(cards[0]).toMatchObject({ runId: 'r9', hasSteps: true, words: { step: 'List last week’s meetings', source: null, app: 'Fireflies' } });
        expect(cards[1].hasSteps).toBe(false);
        expect(cards[6].words).toEqual({ step: null, source: null, app: null });
    });

    it('a set-up that did not work is its own card, with why as a class', () => {
        const cards = needCards([need({ kind: 'setup', cause: 'timeout' }), need({ kind: 'setup' })], ITEMS);
        expect(cards.map((c) => [c.kind, c.cause])).toEqual([['setup', 'timeout'], ['setup', 'failed']]);
    });

    it('a check says whether the task waits for it: one started to get steps does, an older one runs meanwhile', () => {
        const waits = { steps: 'wanted' as const, cause: null, since: null, sendsTo: null, askFirst: null, canUndo: false };
        const items: CoworkItem[] = [{ ...ITEMS[0], setup: waits, planId: null }, { ...ITEMS[0], id: 'w2' }];
        const cards = needCards([need({ plan: 'first', tried: 'passed' }), need({ itemId: 'w2', plan: 'first', tried: 'passed' })], items);
        expect(cards.map((c) => c.held)).toEqual([true, false]);
        expect(waitsForSteps({ setup: waits, planId: 'plan-1' })).toBe(false);
        expect(waitsForSteps({ setup: { ...waits, steps: 'ai' } })).toBe(false);
        expect(waitsForSteps(undefined)).toBe(false);
    });
});

describe('deskNeedCards', () => {
    const member = (over: Partial<DeskView['members'][number]>): DeskView['members'][number] => ({
        scheduleId: 'w1', title: 'Mine', ownerName: 'Ann', mine: true, accepted: true, after: null, lastStatus: null, lastRunAt: null, deskRole: null, handOff: null, decidesHandOff: false, ...over,
    });
    const view = (members: DeskView['members']): DeskView => ({ desk: { id: 'd1', name: 'Supplier desk', isOwner: false, ownerName: 'Sam Peters' }, members, roles: [], colleagues: [] });

    it('an invitation of one of my tasks, and a colleague\'s task that asks for the result of mine', () => {
        const cards = deskNeedCards([view([
            member({ scheduleId: 'w1', title: 'Weekly sales' }),
            member({ scheduleId: 'w2', title: 'Invited one', accepted: false }),
            member({ scheduleId: 'c1', title: 'Stock check', ownerName: 'Noor Haddad', mine: false, after: 'w1', handOff: 'waiting', decidesHandOff: true }),
            member({ scheduleId: 'c2', title: 'Allowed', mine: false, after: 'w1', handOff: 'allowed', decidesHandOff: true }),
        ])]);
        expect(cards.map((c) => [c.kind, c.itemId])).toEqual([['invitation', 'w2'], ['hand_off', 'w1']]);
        expect(cards[0].desk).toEqual({ id: 'd1', name: 'Supplier desk', invitedBy: 'Sam Peters' });
        expect(cards[1].handOff).toEqual({ deskId: 'd1', followerId: 'c1', followerTitle: 'Stock check', ownerName: 'Noor Haddad' });
        expect(cards[1].title).toBe('Weekly sales');
    });
});
