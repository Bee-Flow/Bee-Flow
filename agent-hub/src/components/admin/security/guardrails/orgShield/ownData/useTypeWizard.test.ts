// @vitest-environment node
import { describe, it, expect } from 'vitest';

import type { CustomDataType } from './ownDataModel';
import { configFingerprint, emptyType, toDraft } from './ownDataModel';
import { makeSentence } from './testBench';
import type { WizardInit, WizardState } from './useTypeWizard';
import {
    assistExamples, commitOf, describeProblems, initWizard, isRunStale, wizardReducer,
} from './useTypeWizard';

/**
 * The wizard's state machine. The promise under test is the one the tab
 * relies on: the draft is the wizard's own until "Add to the list", so the
 * shield form is untouched by every step, and Cancel has nothing to undo.
 */

const APPLY = { detect: true, external: true, internal: false };

function start(over: Partial<WizardInit> = {}, typeOver: Partial<CustomDataType> = {}): WizardState {
    const type = { ...emptyType('words'), name: 'Codes', tokenKey: 'code', ...typeOver };
    return initWizard({ mode: 'new', type, apply: APPLY, ...over });
}

const run = (s: WizardState, ...actions: Parameters<typeof wizardReducer>[1][]) => actions.reduce(wizardReducer, s);

describe('the draft', () => {
    it('never mutates what it was opened with', () => {
        // Editing an existing type hands the wizard a draft of the stored one;
        // the stored object (still in the form) must come out untouched.
        const stored: CustomDataType = {
            ...emptyType('words'), name: 'Codes', tokenKey: 'code', words: { values: ['A'], caseSensitive: false, wholeWord: true },
        };
        const frozen = JSON.parse(JSON.stringify(stored));
        const tests = { examples: ['A'], sentences: [makeSentence('A b', 'own', [{ start: 0, end: 1 }])] };
        const testsFrozen = JSON.parse(JSON.stringify(tests));
        const s = run(
            initWizard({ mode: 'edit', type: toDraft(stored), tests, apply: APPLY }),
            { type: 'patch', patch: { name: 'Renamed' } },
            { type: 'patch_block', block: 'words', patch: { values: ['A', 'B'] } },
            { type: 'set_examples', examples: ['X'] },
            { type: 'add_sentences', sentences: [makeSentence('B c')] },
            { type: 'set_apply', col: 'internal', on: true },
        );
        expect(stored).toEqual(frozen);
        expect(tests).toEqual(testsFrozen);
        expect(s.type.name).toBe('Renamed');
        expect(s.touched).toBe(true);
    });

    it('is untouched until something is typed, so Cancel only asks when there is something to lose', () => {
        const s = start();
        expect(s.touched).toBe(false);
        expect(run(s, { type: 'go', step: 1 }).touched).toBe(false);
        expect(run(s, { type: 'patch', patch: { description: 'x' } }).touched).toBe(true);
    });

    it('keeps what was typed for each method when switching back and forth', () => {
        const s = run(
            start(),
            { type: 'patch_block', block: 'words', patch: { values: ['Falcon'] } },
            { type: 'set_method', method: 'pattern' },
            { type: 'set_method', method: 'words' },
        );
        expect(s.type.words?.values).toEqual(['Falcon']);
    });
});

describe('commitOf', () => {
    it('hands over only the chosen method, its tests and its switches', () => {
        const s = run(
            start({}, { method: 'pattern' }),
            { type: 'set_examples', examples: ['KL-12345', 'KL-83920'] },
            { type: 'set_keep_fixed', keepFixed: ['KL-'] },
            { type: 'go', step: 1 },
        );
        const c = commitOf(s, '2026-09-26T12:00:00.000Z');
        expect(c.type.pattern).toEqual({ source: '\\bKL-\\d{5}\\b', caseSensitive: false });
        expect(c.type.words).toBeUndefined();
        expect(c.type.ai).toBeUndefined();
        expect(c.tests).toMatchObject({ examples: ['KL-12345', 'KL-83920'], keepFixed: ['KL-'], updatedAt: '2026-09-26T12:00:00.000Z' });
        expect(c.apply).toEqual(APPLY);
    });

    it('drops "keep fixed" for a type that is not a fixed format', () => {
        const s = run(start(), { type: 'set_keep_fixed', keepFixed: ['KL-'] });
        expect(commitOf(s).tests).not.toHaveProperty('keepFixed');
    });

    it('records the last test as the type\'s quality, stale when it changed afterwards', () => {
        const sentence = makeSentence('Falcon is late', 'own', [{ start: 0, end: 6 }]);
        const base = run(
            start({}, { words: { values: ['Falcon'], caseSensitive: false, wholeWord: true } }),
            { type: 'add_sentences', sentences: [sentence] },
        );
        const tested = run(base, { type: 'test_done', run: { found: { [sentence.id]: [{ start: 0, end: 6 }] }, fingerprint: configFingerprint(base.type), engine: 'local' } });
        expect(commitOf(tested, 'now').type.quality).toEqual({ found: 1, total: 1, falseAlarms: 0, sentences: 1, at: 'now' });
        const changed = run(tested, { type: 'patch_block', block: 'words', patch: { wholeWord: false } });
        expect(isRunStale(changed)).toBe(true);
        expect(commitOf(changed, 'now').type.quality?.stale).toBe(true);
    });

    it('marks an untested edit of a tested type as changed since its last test', () => {
        const stored = { ...emptyType('words'), name: 'Codes', tokenKey: 'code', words: { values: ['A'], caseSensitive: false, wholeWord: true }, quality: { found: 2, total: 2, falseAlarms: 0, sentences: 2 } };
        const s = initWizard({ mode: 'edit', type: toDraft(stored), apply: APPLY });
        expect(commitOf(s).type.quality?.stale).toBeUndefined();
        const edited = run(s, { type: 'patch_block', block: 'words', patch: { values: ['A', 'B'] } });
        expect(commitOf(edited).type.quality?.stale).toBe(true);
    });
});

describe('sentences', () => {
    it('keeps at most 40', () => {
        const many = Array.from({ length: 45 }, (_, i) => makeSentence(`s ${i}`));
        expect(run(start(), { type: 'add_sentences', sentences: many }).tests.sentences).toHaveLength(40);
    });

    it('forgets a removed sentence\'s findings too', () => {
        const a = makeSentence('a');
        const s = run(
            start(),
            { type: 'add_sentences', sentences: [a] },
            { type: 'test_done', run: { found: { [a.id]: [] }, fingerprint: '', engine: 'local' } },
            { type: 'remove_sentence', id: a.id },
        );
        expect(s.run?.found).toEqual({});
    });

    it('takes the assistant\'s sentences and keeps its suggestion only if it differs', () => {
        const s = run(start(), {
            type: 'assist_done', sentences: [makeSentence('x', 'assistant', [])], patterns: ['KL-\\d{5}'], aiLabels: ['code'], suggestedMethod: 'pattern',
        });
        expect(s.tests.sentences).toHaveLength(1);
        expect(s.suggestedMethod).toBe('pattern');
        expect(s.candidates).toEqual({ patterns: ['KL-\\d{5}'], aiLabels: ['code'] });
        expect(run(start(), { type: 'assist_done', sentences: [], patterns: [], aiLabels: [], suggestedMethod: 'words' }).suggestedMethod).toBeNull();
    });
});

describe('tuning', () => {
    const info = (improved: boolean) => ({
        improved, method: 'words' as const,
        before: { found: 17, total: 20, falseAlarms: 3, sentences: 20 },
        after: { found: 20, total: 20, falseAlarms: 1, sentences: 20 },
        describe: { label: null, sensitivity: null, patternWords: null, wholeWord: true, caseSensitive: false },
    });

    it('applies an improvement with Undo, and Undo puts the old settings back', () => {
        const s0 = start({}, { words: { values: ['Falcon'], caseSensitive: true, wholeWord: false } });
        const tuned = run(s0, { type: 'tune_done', config: { words: { caseSensitive: false, wholeWord: true } as never }, info: info(true) });
        // A flags-only answer keeps the list.
        expect(tuned.type.words).toEqual({ values: ['Falcon'], caseSensitive: false, wholeWord: true });
        expect(tuned.tuneUndo).not.toBeNull();
        const undone = run(tuned, { type: 'undo_tune' });
        expect(undone.type.words).toEqual(s0.type.words);
        expect(undone.tune).toBeNull();
    });

    it('changes nothing when tuning found nothing better', () => {
        const s0 = start();
        const s = run(s0, { type: 'tune_done', config: { words: { values: [], caseSensitive: true, wholeWord: false } }, info: info(false) });
        expect(s.type).toBe(s0.type);
        expect(s.tuneUndo).toBeNull();
        expect(s.tune?.improved).toBe(false);
    });
});

describe('describeProblems', () => {
    it('asks for a name, a method and the method\'s input, in that order', () => {
        const blank = initWizard({ mode: 'new', type: emptyType('words'), apply: APPLY, methodChosen: false });
        expect(describeProblems(blank, { types: [], guardDown: false })).toEqual(['name_missing', 'method_missing']);
        const named = run(blank, { type: 'patch', patch: { name: 'Codes', tokenKey: 'code' } }, { type: 'set_method', method: 'words' });
        expect(describeProblems(named, { types: [], guardDown: false })).toEqual(['words_missing']);
    });

    it('refuses a reserved placeholder', () => {
        const s = start({}, { tokenKey: 'email' });
        expect(describeProblems(s, { types: [], guardDown: false })).toContain('token_reserved');
    });

    it('accepts a fixed format made from examples alone', () => {
        const s = run(start({}, { method: 'pattern' }), { type: 'set_examples', examples: ['KL-12345'] });
        expect(describeProblems(s, { types: [], guardDown: false })).toEqual([]);
        expect(describeProblems(start({}, { method: 'pattern' }), { types: [], guardDown: false })).toEqual(['pattern_missing']);
    });

    it('will not start an AI type while the detection service is down, or past six', () => {
        const ai = start({}, { method: 'ai' });
        expect(describeProblems(ai, { types: [], guardDown: true })).toContain('ai_unavailable');
        const six = Array.from({ length: 6 }, (_, i) => ({ ...emptyType('ai'), id: `cdt_000000000${i}`, tokenKey: `t${'abcdef'[i]}` }));
        expect(describeProblems(ai, { types: six, guardDown: false })).toContain('ai_limit');
    });

    it('masks the first words of a list, or the real examples otherwise', () => {
        const words = start({}, { words: { values: ['Falcon', 'Heron'], caseSensitive: false, wholeWord: true } });
        expect(assistExamples(words)).toEqual(['Falcon', 'Heron']);
        const pattern = run(start({}, { method: 'pattern' }), { type: 'set_examples', examples: ['KL-12345'] });
        expect(assistExamples(pattern)).toEqual(['KL-12345']);
    });
});
