import { useReducer } from 'react';

import type {
    CustomDataType, Method, Quality, Sentence, Summary, SwitchCol, TypeTests,
} from './ownDataModel';
import {
    LIMITS, aiTypeCount, configFingerprint, markStale, resolveType, tokenKeyProblem,
} from './ownDataModel';
import { checkPattern, inferPattern } from './patternCheck';
import type { RunFindings } from './testBench';
import { emptyTests, summarise } from './testBench';

/**
 * The wizard's state, as a pure reducer.
 *
 * The draft lives HERE and nowhere else until "Add to the list": the shield
 * form (`f`) is not touched by a single keystroke in the wizard, so Cancel is
 * a plain unmount and there is nothing to roll back. `commitOf` is the one
 * way out, and it hands the caller exactly the three things the form needs:
 * the stored type, its tests, and the three switches.
 */

export type Step = 0 | 1 | 2;
export type Block = 'words' | 'pattern' | 'ai';

export interface TuneInfo {
    improved: boolean;
    method: Method;
    before: Summary;
    after: Summary;
    describe: { label: string | null; sensitivity: 'low' | 'medium' | 'high' | null; patternWords: string | null; wholeWord: boolean | null; caseSensitive: boolean | null };
}

export interface WizardState {
    mode: 'new' | 'edit';
    step: Step;
    type: CustomDataType;
    tests: TypeTests;
    methodChosen: boolean;
    /** The last test run's findings, rescored locally as marks change. */
    run: RunFindings | null;
    tune: TuneInfo | null;
    tuneUndo: { type: CustomDataType; run: RunFindings | null } | null;
    candidates: { patterns: string[]; aiLabels: string[] };
    suggestedMethod: Method | null;
    apply: Record<SwitchCol, boolean>;
    /** Anything changed since the wizard opened: Cancel asks first. */
    touched: boolean;
    /** What the type found with when it opened, to tell a stale test result from a fresh one. */
    openedFingerprint: string;
}

export interface WizardInit {
    mode: 'new' | 'edit';
    type: CustomDataType;
    tests?: TypeTests | null;
    apply: Record<SwitchCol, boolean>;
    methodChosen?: boolean;
    step?: Step;
}

export type WizardAction =
    | { type: 'go'; step: Step }
    | { type: 'patch'; patch: Partial<Pick<CustomDataType, 'name' | 'description' | 'tokenKey'>> }
    | { type: 'set_method'; method: Method }
    | { type: 'patch_block'; block: Block; patch: Record<string, unknown> }
    | { type: 'set_examples'; examples: string[] }
    | { type: 'set_keep_fixed'; keepFixed: string[] }
    | { type: 'add_sentences'; sentences: Sentence[] }
    | { type: 'replace_sentence'; sentence: Sentence }
    | { type: 'remove_sentence'; id: string }
    | { type: 'test_done'; run: RunFindings }
    | { type: 'assist_done'; sentences: Sentence[]; patterns: string[]; aiLabels: string[]; suggestedMethod: Method | null }
    | { type: 'dismiss_suggestion' }
    | { type: 'tune_done'; config: Pick<CustomDataType, 'words' | 'pattern' | 'ai'>; info: TuneInfo }
    | { type: 'undo_tune' }
    | { type: 'set_apply'; col: SwitchCol; on: boolean };

export function initWizard(init: WizardInit): WizardState {
    const tests = init.tests
        ? { ...init.tests, examples: [...init.tests.examples], sentences: [...init.tests.sentences] }
        : emptyTests();
    return {
        mode: init.mode,
        step: init.step ?? 0,
        type: init.type,
        tests,
        methodChosen: init.methodChosen ?? true,
        run: null,
        tune: null,
        tuneUndo: null,
        candidates: { patterns: [], aiLabels: [] },
        suggestedMethod: null,
        apply: { ...init.apply },
        touched: false,
        openedFingerprint: configFingerprint(init.type),
    };
}

/**
 * Leaving step 1 with a fixed-format type that has examples but no pattern:
 * infer one, so there is something to test. The advanced box shows it and
 * the admin can still change it.
 */
function ensurePattern(state: WizardState): WizardState {
    const t = state.type;
    if (t.method !== 'pattern' || t.pattern?.source) return state;
    const source = inferPattern(state.tests.examples);
    if (!source) return state;
    return { ...state, type: { ...t, pattern: { caseSensitive: false, ...t.pattern, source } } };
}

const touched = (state: WizardState, patch: Partial<WizardState>): WizardState => ({ ...state, ...patch, touched: true });

function withSentences(state: WizardState, sentences: Sentence[]): WizardState {
    return touched(state, { tests: { ...state.tests, sentences } });
}

function reduceSentences(state: WizardState, action: WizardAction): WizardState | null {
    const list = state.tests.sentences;
    switch (action.type) {
    case 'add_sentences':
        return withSentences(state, [...list, ...action.sentences].slice(0, LIMITS.sentences));
    case 'replace_sentence':
        return withSentences(state, list.map(s => (s.id === action.sentence.id ? action.sentence : s)));
    case 'remove_sentence': {
        const next = withSentences(state, list.filter(s => s.id !== action.id));
        if (!state.run) return next;
        const { [action.id]: _gone, ...found } = state.run.found;
        return { ...next, run: { ...state.run, found } };
    }
    case 'assist_done':
        return {
            ...withSentences(state, [...list, ...action.sentences].slice(0, LIMITS.sentences)),
            candidates: { patterns: action.patterns, aiLabels: action.aiLabels },
            suggestedMethod: action.suggestedMethod && action.suggestedMethod !== state.type.method ? action.suggestedMethod : null,
        };
    default:
        return null;
    }
}

/** Lay a tuned config over the draft block by block, so a partial answer keeps the rest. */
export function mergeConfig(type: CustomDataType, config: Pick<CustomDataType, 'words' | 'pattern' | 'ai'>): CustomDataType {
    const out = { ...type };
    if (config.words) out.words = { ...type.words!, ...config.words };
    if (config.pattern) out.pattern = { ...type.pattern!, ...config.pattern };
    if (config.ai) out.ai = { ...type.ai!, ...config.ai };
    return out;
}

function reduceTune(state: WizardState, action: WizardAction): WizardState | null {
    switch (action.type) {
    case 'tune_done': {
        if (!action.info.improved) return { ...state, tune: action.info };
        const type = mergeConfig(state.type, action.config);
        return touched(state, { type, tune: action.info, tuneUndo: { type: state.type, run: state.run } });
    }
    case 'undo_tune':
        if (!state.tuneUndo) return state;
        return touched(state, { type: state.tuneUndo.type, run: state.tuneUndo.run, tuneUndo: null, tune: null });
    default:
        return null;
    }
}

function reduceDraft(state: WizardState, action: WizardAction): WizardState | null {
    switch (action.type) {
    case 'patch':
        return touched(state, { type: { ...state.type, ...action.patch } });
    case 'set_method':
        return touched(state, {
            type: { ...state.type, method: action.method },
            methodChosen: true,
            suggestedMethod: state.suggestedMethod === action.method ? null : state.suggestedMethod,
        });
    case 'patch_block': {
        const prev = (state.type[action.block] || {}) as object;
        return touched(state, { type: { ...state.type, [action.block]: { ...prev, ...action.patch } } });
    }
    case 'set_examples':
        return touched(state, { tests: { ...state.tests, examples: action.examples.slice(0, LIMITS.examples) } });
    case 'set_keep_fixed':
        return touched(state, { tests: { ...state.tests, keepFixed: action.keepFixed } });
    default:
        return null;
    }
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
    const next = reduceSentences(state, action) || reduceTune(state, action) || reduceDraft(state, action);
    if (next) return next;
    switch (action.type) {
    case 'go':
        return { ...(state.step === 0 && action.step > 0 ? ensurePattern(state) : state), step: action.step };
    case 'test_done':
        return { ...state, run: action.run };
    case 'dismiss_suggestion':
        return { ...state, suggestedMethod: null };
    case 'set_apply':
        return touched(state, { apply: { ...state.apply, [action.col]: action.on } });
    default:
        return state;
    }
}

export function useTypeWizard(init: WizardInit) {
    return useReducer(wizardReducer, init, initWizard);
}

// ── Derived values ─────────────────────────────────────────────────────

/** Has the type changed since the last test run? Then its marks are old news. */
export function isRunStale(state: WizardState): boolean {
    return !!state.run && state.run.fingerprint !== configFingerprint(state.type);
}

/** The examples the assistant masks: the real examples, or the first words of a list. */
export function assistExamples(state: WizardState): string[] {
    const src = state.type.method === 'words' ? (state.type.words?.values || []) : state.tests.examples;
    return src.map(v => v.slice(0, LIMITS.example)).filter(Boolean).slice(0, LIMITS.examples);
}

export type DescribeProblem =
    | 'name_missing' | 'token_format' | 'token_reserved' | 'token_taken' | 'method_missing'
    | 'words_missing' | 'pattern_missing' | 'pattern_invalid' | 'ai_unavailable' | 'ai_limit';

/** Why "Next" is not available on step 1 yet, first problem first. */
export function describeProblems(
    state: WizardState,
    { types, guardDown }: { types: readonly CustomDataType[]; guardDown: boolean },
): DescribeProblem[] {
    const t = state.type;
    const out: DescribeProblem[] = [];
    if (!t.name.trim()) out.push('name_missing');
    const token = tokenKeyProblem(t.tokenKey, types, t);
    if (t.name.trim() && token) out.push(`token_${token}` as DescribeProblem);
    if (!state.methodChosen) return [...out, 'method_missing'];
    return [...out, ...methodProblems(state, types, guardDown)];
}

function methodProblems(state: WizardState, types: readonly CustomDataType[], guardDown: boolean): DescribeProblem[] {
    const t = state.type;
    if (t.method === 'words') {
        return (t.words?.values || []).some(v => v.trim()) ? [] : ['words_missing'];
    }
    if (t.method === 'pattern') {
        const source = t.pattern?.source || inferPattern(state.tests.examples);
        if (!source) return ['pattern_missing'];
        return checkPattern(source, [], !!t.pattern?.caseSensitive).ok ? [] : ['pattern_invalid'];
    }
    const out: DescribeProblem[] = [];
    if (guardDown) out.push('ai_unavailable');
    if (aiTypeCount(types, t.id) >= LIMITS.aiTypes) out.push('ai_limit');
    return out;
}

function qualityOf(state: WizardState, now: string): Quality | undefined {
    if (state.run) {
        const s = summarise(state.tests.sentences, state.run);
        if (s.sentences === 0) return undefined;
        return { ...s, at: now, ...(isRunStale(state) ? { stale: true } : {}) };
    }
    const changed = configFingerprint(state.type) !== state.openedFingerprint;
    const q = changed ? markStale(state.type).quality : state.type.quality;
    return q;
}

export interface WizardCommit {
    type: CustomDataType;
    tests: TypeTests;
    apply: Record<SwitchCol, boolean>;
}

/** The finished type, its tests and its switches, ready to lay over the form. */
export function commitOf(state: WizardState, now = new Date().toISOString()): WizardCommit {
    const ready = ensurePattern(state);
    const { quality: _q, ...base } = resolveType(ready.type);
    const quality = qualityOf(ready, now);
    // "Keep KL- as it is" only means something for a fixed format.
    const { keepFixed, ...tests } = ready.tests;
    return {
        type: { ...base, ...(quality ? { quality } : {}) },
        tests: { ...tests, ...(base.method === 'pattern' && keepFixed?.length ? { keepFixed } : {}), updatedAt: now },
        apply: { ...ready.apply },
    };
}
