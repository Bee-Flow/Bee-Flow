import { consequencesOf, triggerConditionOf } from './rules';
import { conditionSentence, consequenceParts, licenceMessage, narrowingParts, ruleState, runLabel } from './sentences';

const t = (_key: string, fallback: string, params: Record<string, string | number> = {}) =>
    fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? `{${name}}`));

const def = (filter: unknown, event = 'meeting.processed') => ({
    trigger: { kind: 'app_event', appEvent: { provider: 'meeting-notes', event, filter } },
    steps: [],
});

describe('the rule sentence', () => {
    it('names the condition', () => {
        expect(conditionSentence(null, t)).toBe('This rule no longer starts on a meeting note');
        expect(conditionSentence(triggerConditionOf(def({})), t)).toBe('When any meeting note is finished');
        expect(conditionSentence(triggerConditionOf(def({ tags: 'sales' })), t)).toBe(
            'When a meeting tagged sales is finished',
        );
        expect(conditionSentence(triggerConditionOf(def({ tags: ['a', 'b'] })), t)).toBe(
            'When a meeting tagged any of a, b is finished',
        );
        expect(conditionSentence(triggerConditionOf(def({}, 'meeting.scheduled')), t)).toBe(
            'When meeting notes fire meeting.scheduled',
        );
        expect(conditionSentence(triggerConditionOf(def({}, '')), t)).toBe(
            'When meeting notes fire an event this card cannot name',
        );
    });

    it('names what it does, and never stays silent', () => {
        expect(consequenceParts(consequencesOf(null), t)).toEqual(['its steps could not be read']);
        expect(consequenceParts(consequencesOf({ steps: [] }), t)).toEqual(['nothing yet — this rule has no steps']);
        expect(consequenceParts(consequencesOf({ steps: [{ type: 'set' }] }), t)).toEqual([
            '1 step that only prepares data — nothing leaves the run',
        ]);
        expect(
            consequenceParts(
                consequencesOf({ steps: [{ type: 'knowledge_write' }, { type: 'code' }, { type: 'code' }] }),
                t,
            ),
        ).toEqual(['files it in a knowledge base', '2 more steps this card cannot describe']);
    });

    it('says what narrows it', () => {
        expect(narrowingParts(triggerConditionOf(def({ reprocessed: true, age: 3 })), t)).toEqual([
            'Only a reprocess or a new summary',
            'narrowed further by conditions this card cannot show',
        ]);
        expect(narrowingParts(triggerConditionOf(def({ reprocessed: false })), t)).toEqual(['Only a brand-new note']);
    });
});

describe('the run line', () => {
    it('is silent when nobody counted, and explicit about a real zero', () => {
        expect(runLabel(null, 'r', 24, t)).toBeNull();
        expect(runLabel({ automationId: {} }, 'r', 24, t)).toBe('no runs of yours in the last 24 hours');
        expect(runLabel({ automationId: { r: 1 } }, 'r', 24, t)).toBe('1 run of yours in the last 24 hours');
        expect(runLabel({ automationId: { r: 5 } }, 'r', 48, t)).toBe('5 runs of yours in the last 48 hours');
    });
});

describe('state and licence', () => {
    it('lets draft win over active', () => {
        expect(ruleState({ isActive: true, isDraft: true })).toBe('draft');
        expect(ruleState({ isActive: true, isDraft: false })).toBe('live');
        expect(ruleState({ isActive: false, isDraft: false })).toBe('paused');
        expect(ruleState({})).toBeNull();
    });

    it('words a licence refusal and nothing else', () => {
        expect(licenceMessage({ message: 'feature_locked' }, t)).toMatch(/not part of this plan/);
        expect(licenceMessage({ message: 'x', status: 403 }, t)).toMatch(/not part of this plan/);
        expect(licenceMessage({ message: 'Server exploded', status: 500 }, t)).toBeNull();
        expect(licenceMessage(null, t)).toBeNull();
    });
});
