// The Overview's one sentence (./coworkOverviewModel.ts): what an item does and when, in plain words, and only what
// holds about sending. Also a step's plain title. Pure: the English fallbacks are what the screen shows.
import { describe, expect, it } from 'vitest';
import { briefLine, overviewSentence, plainStepTitle } from './coworkOverviewModel';
import type { OverviewFacts } from './coworkOverviewModel';
import type { TranslateFn } from '@/hooks/useTranslation';

const t = ((key: string, fallback?: unknown, params?: Record<string, unknown>) => {
    const text = typeof fallback === 'string' ? fallback : key;
    return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`));
}) as TranslateFn;

const item = (over: Partial<OverviewFacts['item']> = {}): OverviewFacts['item'] => ({
    title: 'Answer supplier mails',
    prompt: 'Read the new supplier mails and draft an answer to each. Keep it short.',
    isActive: true,
    repeatInterval: 'weekdays',
    daysOfWeek: null,
    timeOfDay: '16:30',
    nextRunAt: null,
    lastStatus: 'success',
    enabledApps: null,
    trigger: null,
    triggerKind: 'schedule',
    ...over,
});

const facts = (over: Partial<OverviewFacts> = {}): OverviewFacts => ({ item: item(), plan: null, sends: null, level: null, agentName: null, ...over });

describe('overviewSentence', () => {
    it('a scheduled prompt item: when, and the first sentence of its brief, with no promise about sending', () => {
        const sentence = overviewSentence(facts(), t);
        expect(sentence).toBe('Every weekday 16:30, the AI works on: “Read the new supplier mails and draft an answer to each”. It reports to you after each run.');
        expect(sentence).not.toMatch(/Nothing is sent/);
    });

    it('a plan item that asks before sending says so', () => {
        const sentence = overviewSentence(facts({ plan: { steps: 6, approved: true }, sends: 'others', level: 'asks_before_sending' }), t);
        expect(sentence).toBe('Every weekday 16:30, it follows its approved plan of 6 steps. Nothing is sent without you.');
    });

    it('a plan that waits for approval, and the other levels, say what holds', () => {
        expect(overviewSentence(facts({ plan: { steps: 3, approved: false } }), t)).toMatch(/a plan that waits for your approval\. Its plan waits for your approval\.$/);
        expect(overviewSentence(facts({ plan: { steps: 2, approved: true }, sends: 'owner' }), t)).toMatch(/It only reports to you\.$/);
        expect(overviewSentence(facts({ plan: { steps: 2, approved: true }, sends: 'others', level: 'on_its_own' }), t)).toMatch(/It sends on its own, as you approved\.$/);
    });

    it('a mail-started item says what starts it, and who works on it', () => {
        const mail = item({ repeatInterval: null, timeOfDay: null, triggerKind: 'app_event', trigger: { provider: 'msgraph', event: 'mail.new' } });
        const sentence = overviewSentence(facts({ item: mail, agentName: 'Mail desk' }), t);
        expect(sentence).toMatch(/^When a new e-mail arrives in Outlook, Mail desk works on: “Read the new supplier mails/);
    });

    it('a paused item says first that nothing runs', () => {
        const sentence = overviewSentence(facts({ item: item({ isActive: false }) }), t);
        expect(sentence).toMatch(/^Paused: nothing runs until you resume it\. Every weekday 16:30, the AI works on/);
        // A one-off that ran and was switched off is finished, not paused.
        expect(overviewSentence(facts({ item: item({ isActive: false, repeatInterval: null, timeOfDay: null }) }), t)).toMatch(/^Once, the AI works on/);
    });

    it('an item with no apps only writes an answer; a new one that starts now says so', () => {
        expect(overviewSentence(facts({ item: item({ enabledApps: [] }) }), t)).toMatch(/It only writes an answer for you\.$/);
        expect(overviewSentence(facts({ item: item({ repeatInterval: null, timeOfDay: null }), startsNow: true }), t)).toMatch(/^Right away, the AI works on/);
    });
});

describe('briefLine', () => {
    it('keeps one sentence, cut at a word when it is long', () => {
        expect(briefLine('Short one. Then more.')).toBe('Short one.');
        const long = briefLine(`${'word '.repeat(40)}end`);
        expect(long.length).toBeLessThanOrEqual(111);
        expect(long.endsWith('…')).toBe(true);
    });
});

describe('plainStepTitle', () => {
    it('shows the step title, words for a tool name, and the kind of step for a bare id', () => {
        expect(plainStepTitle({ id: 'a_b858bb', title: 'Get last week\'s supplier mail', kind: 'fixed' }, t)).toBe('Get last week\'s supplier mail');
        expect(plainStepTitle({ id: 's2', title: 'fireflies_get_summary', kind: 'fixed' }, t)).toBe('Fireflies get summary');
        expect(plainStepTitle({ id: 'a_b858bb', title: 'a_b858bb', kind: 'ai' }, t)).toBe('An AI step');
        expect(plainStepTitle({ id: 's3', title: '', kind: 'deliver' }, t)).toBe('A result for you');
    });
});
