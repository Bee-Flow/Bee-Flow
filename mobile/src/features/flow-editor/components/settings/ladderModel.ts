/**
 * The ladder sheet's state rules — what the web's AiActLadderModal.jsx keeps
 * inline in its component, lifted out so it can be tested and pinned:
 *
 *   - Art. 5 is eight negation ticks; only all eight make the answer 'no'.
 *     There is no way to answer 'yes' by ticking — as on the web;
 *   - Annex III is ten questions, each yes/no/open; pressing the answer
 *     already given takes it back to open (a legal declaration needs a way
 *     out of an answer you did not mean);
 *   - re-assessing starts from what was declared: a stored Art. 5 'no' ticks
 *     all eight, the stored domains fill the questions, and a row saved
 *     before the ten questions existed reads through legacyAnnexAnswers: a
 *     'no' fills all ten, a 'yes' only the area it named (with a note to
 *     pick the rest), never all ten;
 *   - the automation's own wording puts a domain first, never answers it;
 *   - with AI in the automation, a declaration needs steps 1 and 3 answered.
 *
 * On the phone the ladder is asked one step at a time (LADDER_PAGES), the
 * outcome on a page of its own before anything is recorded. Pure; pinned by
 * ladderModel.lockstep.test.ts.
 */

import type { AiActAnswers, AiActYesNo } from '@/features/flow-editor/api';

import {
    ANNEX_III_CATEGORIES,
    annexAnswerFromDomains,
    ART5_PRACTICES,
    legacyAnnexAnswers,
    type AnnexInput,
    type Art5Input,
    type DomainAnswers,
    type Step2,
    type Verdict,
} from './ladderOutcome';

/** Art. 5 → Art. 50 → Annex III, then the outcome. */
export const LADDER_PAGES = ['art5', 'art50', 'annex', 'outcome'] as const;
export type LadderPage = (typeof LADDER_PAGES)[number];

export type StepState = 'done' | 'failing' | 'open';

/** The Art. 5 answer the ticks add up to. */
export function art5FromDenied(denied: readonly string[]): Art5Input {
    return { answer: denied.length === ART5_PRACTICES.length ? 'no' : null, practices: [] };
}

/** The Annex III answer the ten add up to, with the ten themselves. */
export function annexFromDomains(domains: DomainAnswers): AnnexInput {
    return { answer: annexAnswerFromDomains(domains), category: null, domains };
}

const answered = (v: unknown): v is AiActYesNo => v === 'yes' || v === 'no';

/**
 * Where re-assessing starts: the saved declaration, or nothing. `legacyYes`:
 * the row said 'yes' before the ten questions existed, so the sheet asks to
 * pick the area(s) to confirm (the web's `legacyYes` note).
 */
export function prefill(answers: AiActAnswers | null | undefined): { denied: string[]; domains: DomainAnswers; legacyYes: boolean } {
    const denied = answers?.art5 === 'no' ? [...ART5_PRACTICES] : [];
    const stored = answers?.annexDomains ?? {};
    if (ANNEX_III_CATEGORIES.some((id) => answered(stored[id]))) {
        const domains: DomainAnswers = {};
        for (const id of ANNEX_III_CATEGORIES) if (answered(stored[id])) domains[id] = stored[id];
        return { denied, domains, legacyYes: false };
    }
    // A row from before the ten questions: one answer (and at most one area).
    const legacy = { answer: answers?.annexIii ?? null, category: answers?.annexCategory ?? null };
    return { denied, domains: legacyAnnexAnswers(legacy), legacyYes: legacy.answer === 'yes' };
}

/** Tick or untick one Art. 5 practice. */
export function toggleDenied(denied: readonly string[], id: string): string[] {
    return denied.includes(id) ? denied.filter((d) => d !== id) : [...denied, id];
}

/** Answer one Annex III question; the answer already given takes it back to open. */
export function answerDomain(domains: DomainAnswers, id: string, value: AiActYesNo): DomainAnswers {
    const next = { ...domains };
    if (next[id] === value) delete next[id];
    else next[id] = value;
    return next;
}

/** Hinted questions first, catalogue order within each half. */
export function orderByHints<Q extends { id: string }>(questions: readonly Q[], hints: readonly string[]): Q[] {
    const hinted = new Set(hints);
    return [...questions].sort((a, b) => (hinted.has(b.id) ? 1 : 0) - (hinted.has(a.id) ? 1 : 0));
}

/** With AI in it, the outcome waits for steps 1 and 3. */
export function isPending(verdict: Verdict, containsAi: boolean): boolean {
    return containsAi && !(verdict.step1.answered && verdict.step3.answered);
}

/** Whether a declaration may be recorded (the web's canRecord, less its busy flag). */
export function canRecord(verdict: Verdict, containsAi: boolean): boolean {
    return !isPending(verdict, containsAi);
}

/** The Art. 50 step's disc: failing on any failure, done when every applicable check passed. */
export function step2State(step2: Step2): StepState {
    if (step2.failures.length) return 'failing';
    if (step2.checks > 0 && step2.passed === step2.checks) return 'done';
    return 'open';
}
