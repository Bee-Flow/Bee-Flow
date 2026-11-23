import { describe, expect, it } from 'vitest';
import { howLine, todayWords } from './coworkHomeModel';
import type { HowItWorks, TodayEntry } from '../../api/coworkHome';

const t = (_k: string, en: string, vars?: Record<string, unknown>) => en.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars?.[name] ?? ''));
const plan = (over: Partial<HowItWorks> = {}): HowItWorks => ({ kind: 'plan', fixed: 4, ai: 2, ask: 0, deliver: 1, level: 'asks_before_sending', ...over });

describe('Cowork home words', () => {
    it('a plan says its make-up and its level; a prompt and an agent say what they are', () => {
        expect(howLine(plan(), t)).toBe('4 fixed steps, 2 AI, asks before sending');
        expect(howLine(plan({ ai: 0, level: 'on_its_own' }), t)).toBe('4 fixed steps, on its own');
        expect(howLine(plan({ level: null }), t)).toBe('4 fixed steps, 2 AI, cannot run as chosen');
        expect(howLine({ ...plan(), kind: 'agent' }, t)).toBe('Done by an agent');
        expect(howLine({ ...plan(), kind: 'prompt' }, t)).toBe('Runs a prompt');
        expect(howLine(null, t)).toBeNull();
    });

    it('a moment of the day: how it went, or that it is still to come', () => {
        const entry = (over: Partial<TodayEntry>): TodayEntry => ({ kind: 'ran', itemId: 'w1', title: 'T', at: null, status: 'success', runId: 'r1', ...over });
        expect(['success', 'running', 'waiting', 'error'].map((status) => todayWords(entry({ status }), t))).toEqual(['Done', 'Running now', 'Waits for you', 'Did not finish']);
        expect(todayWords(entry({ kind: 'next', status: null }), t)).toBe('Still to come');
    });
});
