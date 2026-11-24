// "Sends to" as data (./coworkTaskSendsModel.ts): who receives what a task sends, in words, and the one "Ask me"
// choice over the three levels of independence.
import { describe, expect, it } from 'vitest';
import { englishT as t, planState } from '../coworkPlan.fixture';
import { ASK_LEVELS, askLabel, askLevelOf, askNote, reachesOthers, recipientWord, recipientsOf, sendsValue } from './coworkTaskSendsModel';
import type { IndependenceState } from '@/api/coworkIndependence';
import type { PlanState } from '@/api/coworkPlan.types';

const ITEM = { triggerKind: 'schedule' as const, trigger: null };

/** A plan whose steps reach these recipients; `sends` is what its permissions say. */
function planTo(recipients: Record<string, string>, sends: 'none' | 'owner' | 'others'): PlanState {
    const state = planState();
    if (state.draft) state.draft = { ...state.draft, recipients, permissions: { ...state.draft.permissions, sends } };
    return state;
}

describe('coworkTaskSendsModel', () => {
    it('names the three choices in the order from most to least asking, and maps each to its level', () => {
        expect(ASK_LEVELS.map((level) => [level, askLabel(level, t)])).toEqual([
            ['asks_everything', 'Ask me before every change or message'],
            ['asks_before_sending', 'Show me each message first'],
            ['on_its_own', "Don't ask"],
        ]);
    });

    it('reads the level that holds: the owner\'s choice, else what the next run uses', () => {
        const state = (over: Partial<IndependenceState>): IndependenceState => ({ chosen: null, level: null, asksAvailable: true, letThrough: 0, needed: 10, options: [], ...over });
        expect(askLevelOf(state({ chosen: 'on_its_own', level: 'asks_before_sending' }))).toBe('on_its_own');
        expect(askLevelOf(state({ level: 'asks_everything' }))).toBe('asks_everything');
        expect(askLevelOf(undefined)).toBeNull();
        expect(askLevelOf({} as IndependenceState)).toBeNull();
    });

    it('lists who the fixed steps send to: you first, each address once, and the ones it picks', () => {
        const plan = planTo({ digest: 'owner', mail: 'sam@x.example,bo@x.example', again: 'sam@x.example', each: '*' }, 'others');
        expect(recipientsOf({ item: ITEM, mode: 'steps', plan }, t)).toEqual(['You', 'sam@x.example', 'bo@x.example', 'The addresses it picks']);
        expect(sendsValue({ item: ITEM, mode: 'steps', plan: planTo({ digest: 'owner' }, 'owner') }, t)).toBe('You');
        expect(reachesOthers({ item: ITEM, mode: 'steps', plan })).toBe(true);
        expect(reachesOthers({ item: ITEM, mode: 'steps', plan: planTo({ digest: 'owner' }, 'owner') })).toBe(false);
    });

    it('says so when the steps send nothing, and falls back on what the steps may reach from an older server', () => {
        expect(sendsValue({ item: ITEM, mode: 'steps', plan: planTo({}, 'none') }, t)).toBe('Nobody: it sends nothing');
        expect(recipientsOf({ item: ITEM, mode: 'steps', plan: planTo({}, 'others') }, t)).toEqual(['Other people']);
        expect(recipientsOf({ item: ITEM, mode: 'steps', plan: planTo({}, 'owner') }, t)).toEqual(['You']);
    });

    it('a task the AI or an agent does tells only its owner; one a mail starts drafts a reply to the sender', () => {
        expect(recipientsOf({ item: ITEM, mode: 'ai', plan: undefined }, t)).toEqual(['You']);
        const byMail = { triggerKind: 'app_event' as const, trigger: { provider: 'gmail' as const, event: 'mail.new' as const } };
        expect(recipientsOf({ item: byMail, mode: 'agent', plan: undefined }, t)).toEqual(['The sender of the mail, as a draft for you to send']);
    });

    it('puts one recipient in words, and says under the row which choice holds or why none does yet', () => {
        expect([recipientWord('owner', t), recipientWord('*', t), recipientWord('a@x.example,b@x.example', t), recipientWord(null, t)])
            .toEqual(['you', 'the addresses it picks', 'a@x.example, b@x.example', null]);
        expect(askNote('asks_before_sending', true, t)).toBe('Show me each message first');
        expect(askNote('asks_before_sending', false, t)).toBe('Asking first starts once its steps are approved');
    });
});
