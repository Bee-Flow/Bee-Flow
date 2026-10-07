/**
 * The ladder sheet against the web's AiActLadderModal.jsx:
 *
 *   TEXTUAL       the eight Art. 5 ticks and the ten Annex III questions (ids,
 *                 keys, words, order); every `compliance.ladder_*` key the
 *                 sheet says, with the web's English for it; and the state
 *                 rules the modal keeps inline (the Art. 5 'no', the
 *                 pre-fill, taking an answer back, hints first, canRecord,
 *                 which sub-card for which signal);
 *   DIFFERENTIAL  outcomeText and step2State, evaluated from the modal's own
 *                 source beside the port.
 *
 * Plus the behaviour of those rules here.
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadWebFunctions } from '@/shared/testing/webModule';

import type { AiActSignals } from '../api';
import { disclosureCard, markingCard } from './ladderCards';
import { answerDomain, art5FromDenied, canRecord, orderByHints, prefill, step2State, toggleDenied } from './ladderModel';
import { ANNEX_III_CATEGORIES, ART5_PRACTICES, outcome, type Verdict } from './ladderOutcome';
import { ANNEX_QUESTIONS, ART5_CHIPS, containsAiWords, outcomeText, step2Verdict, step3Verdict } from './ladderWords';

const LADDER = 'components/admin/compliance/ladder';
const WEB_DIR = path.resolve(__dirname, `../../../../../agent-hub/src/${LADDER}`);
const MODAL = fs.readFileSync(`${WEB_DIR}/AiActLadderModal.jsx`, 'utf8');
const BLOCK = fs.readFileSync(`${WEB_DIR}/ComplianceBlock.jsx`, 'utf8');

const web = loadWebFunctions<{
    outcomeText: (v: Verdict, containsAi: boolean, t: unknown) => string;
    step2State: (s: Verdict['step2']) => string;
}>(`${LADDER}/AiActLadderModal.jsx`, ['outcomeText', 'step2State']);

const english = (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

const SIGNALS: AiActSignals = {
    containsAi: true, customerFacing: null, generatesContent: null, disclosurePresent: null, markingEnabled: null,
    aiSteps: null, aiStepLabels: [], annexHints: [],
};
const sig = (patch: Partial<AiActSignals>): AiActSignals => ({ ...SIGNALS, ...patch });

/** Every `t('compliance.ladder_…', '…'` in a source, key → English. */
function ladderCalls(src: string): [string, string][] {
    return [...src.matchAll(/\bt\(\s*'(compliance\.ladder_\w+)',\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1] as string, m[2] as string]);
}

describe('the questions', () => {
    const entries = (listName: string) => {
        const start = MODAL.indexOf(`const ${listName} = Object.freeze([`);
        const list = MODAL.slice(start, MODAL.indexOf(']);', start));
        return [...list.matchAll(/\{ id: '(\w+)', key: '([\w.]+)', en: '([^']+)' \}/g)].map((m) => ({ id: m[1], key: m[2], en: m[3] }));
    };

    it('asks the web’s eight Art. 5 ticks, in its order and words', () => {
        expect(ART5_CHIPS).toEqual(entries('ART5_CHIPS'));
        expect(ART5_CHIPS.map((c) => c.id)).toEqual([...ART5_PRACTICES]);
    });

    it('asks the web’s ten Annex III questions, in its order and words', () => {
        expect(ANNEX_QUESTIONS).toEqual(entries('ANNEX_QUESTIONS'));
        expect(ANNEX_QUESTIONS.map((q) => q.id)).toEqual([...ANNEX_III_CATEGORIES]);
    });
});

describe('the words', () => {
    const webWords = new Map<string, Set<string>>();
    for (const [key, en] of [...ladderCalls(MODAL), ...ladderCalls(BLOCK)]) webWords.set(key, (webWords.get(key) ?? new Set()).add(en));
    const dirs = [__dirname, path.join(__dirname, '../components')];
    const mine = dirs.flatMap((dir) =>
        fs
            .readdirSync(dir)
            .filter((f) => /^(Ladder|ladder|AiActLadder|useAiActLadder|AiActCompliance)\w*\.tsx?$/.test(f) && !f.includes('.test.'))
            .flatMap((f) => ladderCalls(fs.readFileSync(path.join(dir, f), 'utf8')).map(([key, en]) => [f, key, en] as const)),
    );

    it('finds the sheet’s sentences', () => {
        expect(mine.length).toBeGreaterThan(50);
    });

    it.each(mine)('%s says %s in the web’s English', (_file, key, en) => {
        expect([...(webWords.get(key) ?? [])]).toContain(en);
    });
});

describe('the outcome sentence and the Art. 50 disc', () => {
    const VERDICTS: Verdict[] = [
        outcome({ containsAi: false }),
        outcome({ containsAi: true }),
        outcome({ containsAi: true, art5: { answer: 'no' } }),
        outcome({ containsAi: true, art5: { answer: 'no' }, annexIii: { answer: 'no' } }),
        outcome({ containsAi: true, art5: { answer: 'no' }, annexIii: { answer: 'no' }, customerFacing: true, disclosurePresent: false }),
        outcome({ containsAi: true, art5: { answer: 'no' }, annexIii: { answer: 'yes' } }),
        outcome({ containsAi: true, art5: { answer: 'yes' }, annexIii: { answer: 'no' } }),
        outcome({ containsAi: true, art5: { answer: 'no' }, annexIii: { answer: 'no' }, generatesContent: true, markingEnabled: true }),
        outcome({ containsAi: true, art5: { answer: 'no' }, annexIii: { answer: 'no' }, customerFacing: true, generatesContent: true, disclosurePresent: true, markingEnabled: false }),
    ];

    it.each(VERDICTS.map((v, i) => [i, v] as const))('agree with the web on case %i', (_i, verdict) => {
        for (const containsAi of [true, false]) {
            expect(outcomeText(verdict, containsAi, english)).toBe(web.outcomeText(verdict, containsAi, english));
        }
        expect(step2State(verdict.step2)).toBe(web.step2State(verdict.step2));
    });

    it('scores Art. 50 only when every check is known, and counts Annex III until it is answered', () => {
        expect(step2Verdict(VERDICTS[4] as Verdict, english)).toBe('0 of 1 in order');
        expect(step2Verdict(outcome({ containsAi: true, customerFacing: true }), english)).toBeNull();
        expect(step3Verdict(VERDICTS[2] as Verdict, 4, english)).toBe('4 of 10 answered');
        expect(step3Verdict(VERDICTS[5] as Verdict, 10, english)).toBe('Yes');
        expect(MODAL).toContain('verdict.step2.checks > 0 && verdict.step2.passed + verdict.step2.failures.length === verdict.step2.checks');
    });
});

describe('the state rules', () => {
    it('answers Art. 5 "no" only with all eight ticked', () => {
        expect(art5FromDenied([...ART5_PRACTICES])).toEqual({ answer: 'no', practices: [] });
        expect(art5FromDenied(ART5_PRACTICES.slice(1))).toEqual({ answer: null, practices: [] });
        expect(toggleDenied(toggleDenied([], 'social_scoring'), 'social_scoring')).toEqual([]);
        expect(MODAL).toContain("answer: art5Denied.size === ART5_PRACTICES.length ? 'no' : null,");
    });

    it('takes an Annex III answer back when it is pressed again', () => {
        const once = answerDomain({}, 'credit', 'yes');
        expect(once).toEqual({ credit: 'yes' });
        expect(answerDomain(once, 'credit', 'no')).toEqual({ credit: 'no' });
        expect(answerDomain(once, 'credit', 'yes')).toEqual({});
        expect(MODAL).toContain('if (next[id] === value) delete next[id]; else next[id] = value;');
    });

    it('starts from the saved declaration; a pre-ten-question "no" fills all ten, a "yes" only the area it named', () => {
        const none = { art5: null, annexIii: null, annexCategory: null, annexDomains: {} };
        expect(prefill(null)).toEqual({ denied: [], domains: {}, legacyYes: false });
        expect(prefill({ ...none, art5: 'no', annexIii: 'no', annexDomains: { credit: 'yes', made_up: 'no' } })).toEqual({ denied: [...ART5_PRACTICES], domains: { credit: 'yes' }, legacyYes: false });
        expect(prefill({ ...none, art5: 'yes', annexIii: 'no' })).toEqual({ denied: [], domains: Object.fromEntries(ANNEX_III_CATEGORIES.map((id) => [id, 'no'])), legacyYes: false });
        // Never 'yes' to all ten: that would attest biometrics and migration for an insurance quote.
        expect(prefill({ ...none, annexIii: 'yes', annexCategory: 'insurance' })).toEqual({ denied: [], domains: { insurance: 'yes' }, legacyYes: true });
        expect(prefill({ ...none, annexIii: 'yes', annexCategory: 'made_up' })).toEqual({ denied: [], domains: {}, legacyYes: true });
        expect(prefill(none)).toEqual({ denied: [], domains: {}, legacyYes: false });
        expect(MODAL).toContain("setArt5Denied(a.art5?.answer === 'no' ? new Set(ART5_PRACTICES) : new Set());");
        expect(MODAL).toContain("if (stored && typeof stored === 'object' && ANNEX_III_CATEGORIES.some(id => stored[id] === 'yes' || stored[id] === 'no')) {");
        expect(MODAL).toContain('setAnnexAnswers(legacyAnnexAnswers(a.annex_iii));');
        expect(MODAL).toContain("setLegacyYes(a.annex_iii?.answer === 'yes');");
    });

    it('puts the questions the wording mentions first, never answering them', () => {
        expect(orderByHints(ANNEX_QUESTIONS, ['credit', 'biometrics']).map((q) => q.id).slice(0, 3)).toEqual(['biometrics', 'credit', 'critical_infrastructure']);
        expect(MODAL).toContain('[...ANNEX_QUESTIONS].sort((a, b) => (annexHints.has(b.id) ? 1 : 0) - (annexHints.has(a.id) ? 1 : 0))');
    });

    it('records with AI only once steps 1 and 3 are answered', () => {
        const open = outcome({ containsAi: true, art5: { answer: 'no' } });
        expect(canRecord(open, true)).toBe(false);
        expect(canRecord(open, false)).toBe(true);
        expect(canRecord(outcome({ containsAi: true, art5: { answer: 'no' }, annexIii: { answer: 'yes' } }), true)).toBe(true);
        expect(MODAL).toContain('!containsAi || (verdict.step1.answered && verdict.step3.answered)');
    });
});

describe('what the checks see', () => {
    it('says which steps are AI, or that none is', () => {
        expect(containsAiWords(sig({ aiStepLabels: ['Classify'] }), english).body).toBe('yes — step "Classify" is an AI step.');
        expect(containsAiWords(sig({ aiStepLabels: ['A', 'B'] }), english).body).toBe('yes — "A", "B" are AI steps.');
        expect(containsAiWords(sig({ containsAi: false }), english).note).toMatch(/^Without AI only the GDPR applies/);
        expect(containsAiWords(null, english).body).toBe('reading the definition…');
    });

    it('paints a sub-card only from a known signal, as the web does', () => {
        expect(disclosureCard(sig({ customerFacing: false }), english).tone).toBe('neutral');
        expect(disclosureCard(sig({ customerFacing: true, disclosurePresent: true }), english).tone).toBe('success');
        expect(disclosureCard(sig({ customerFacing: true, disclosurePresent: false }), english).tone).toBe('error');
        expect(disclosureCard(sig({ customerFacing: true }), english).tone).toBe('neutral');
        expect(markingCard(sig({ generatesContent: false }), english).tone).toBe('neutral');
        expect(markingCard(sig({ generatesContent: true, markingEnabled: true }), english).tone).toBe('success');
        expect(markingCard(sig({ generatesContent: true, markingEnabled: false }), english, new Date(2026, 8, 27)).detail).toBe(
            `AI text in a generated document without a marking · mandatory for existing systems from ${new Date(2026, 11, 2).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} (in 66 days)`,
        );
        expect(markingCard(sig({ generatesContent: true }), english).tone).toBe('neutral');
        for (const rule of ['if (talks !== true) {', 'if (disclosed === true) {', 'if (disclosed === false) {', 'if (generates !== true) {', 'if (marking === true) {', "const tone = marking === false ? 'error' : 'neutral';"]) {
            expect(MODAL).toContain(rule);
        }
    });
});
