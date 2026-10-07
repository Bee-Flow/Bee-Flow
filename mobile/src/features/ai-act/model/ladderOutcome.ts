/**
 * The verdict of the AI Act three-step ladder — a port of the web's
 * ladderOutcome.js (agent-hub components/admin/compliance/ladder), which is
 * itself the client copy of the server's compliance/aiAct/assess.outcome: the
 * sheet shows the verdict live while the questions are answered, the server
 * recomputes it on save and stores its own word. Same rules, same order:
 *
 *   no AI                                  → not_applicable
 *   Art. 5 answer 'yes'                    → prohibited
 *   Annex III answer 'yes'                 → high_risk
 *   customer-facing or generates content   → transparency
 *   otherwise                              → minimal
 *
 * Step 2 (Art. 50) never changes the outcome code — a missing notice or
 * marking is a failing check, not a different regime — but it is reported in
 * `step2.failures`. An unknown signal is never a failure.
 *
 * One difference in shape, none in rules: the web reads the server's
 * snake_case signals, this reads them as the contract reader hands them over
 * (AiActSignals). Pure; pinned DIFFERENTIALLY by ladderOutcome.lockstep.test.ts,
 * which feeds the web module and this port the same raw rows.
 */

import type { AiActAnswersBody, AiActOutcome, AiActSignals, AiActYesNo } from '../api';

export type LadderAnswer = AiActYesNo | null;
export type DomainAnswers = Partial<Record<string, AiActYesNo>>;
export type Step2Failure = 'disclosure' | 'marking';

export const OUTCOMES: readonly AiActOutcome[] = ['not_applicable', 'prohibited', 'high_risk', 'transparency', 'minimal'];

/** Articles that apply once a system contains AI at all (literacy + transparency). */
export const BASE_ARTICLES: readonly string[] = ['4', '50'];

/** The eight Art. 5 practices, in the server's vocabulary (assess.ART5_PRACTICES). */
export const ART5_PRACTICES = [
    'subliminal_manipulation', 'exploiting_vulnerabilities', 'social_scoring', 'criminal_risk_profiling',
    'facial_scraping', 'emotion_recognition_work_education', 'biometric_categorisation', 'realtime_biometric_id',
] as const;

/** The ten Annex III domains, in the server's vocabulary (annexIii.ANNEX_III_IDS). */
export const ANNEX_III_CATEGORIES = [
    'biometrics', 'critical_infrastructure', 'education', 'employment', 'essential_services',
    'credit', 'insurance', 'law_enforcement', 'migration', 'justice',
] as const;

export type AnnexDomain = (typeof ANNEX_III_CATEGORIES)[number];

/** The point of Annex III each domain cites. */
export const ANNEX_III_ARTICLES: Readonly<Record<AnnexDomain, string>> = {
    biometrics: 'Annex III(1)',
    critical_infrastructure: 'Annex III(2)',
    education: 'Annex III(3)',
    employment: 'Annex III(4)',
    essential_services: 'Annex III(5)(a)',
    credit: 'Annex III(5)(b)',
    insurance: 'Annex III(5)(c)',
    law_enforcement: 'Annex III(6)',
    migration: 'Annex III(7)',
    justice: 'Annex III(8)',
};

/** The Art. 50(2) marking obligation for existing systems. */
export const MARKING_DEADLINE = '2026-12-02';
/** Art. 5 in force; Art. 50 in force; Annex III from. */
export const ART5_IN_FORCE = '2025-02-02';
export const ART50_IN_FORCE = '2026-08-02';
export const ANNEX_III_FROM = '2027-12-02';

const isAnswer = (v: unknown): v is AiActYesNo => v === 'yes' || v === 'no';
const yes = (v: unknown) => v === true || v === 'yes';
const no = (v: unknown) => v === false || v === 'no';
const domainsOf = (domains: DomainAnswers | null | undefined): DomainAnswers =>
    domains && typeof domains === 'object' ? domains : {};

/**
 * The ten Annex III answers for a row saved before the ten questions existed,
 * which carries one `{ answer, category }` for all of them (the web's
 * ladderOutcome.legacyAnnexAnswers). A 'no' covered every area, so it still
 * reads as ten noes. A 'yes' never did: copying it to all ten would have
 * "Record as self-declared" attest biometrics, law enforcement and migration
 * for an insurance quote. It sets only the area it named, when that is a
 * known one, and otherwise leaves all ten open.
 */
export function legacyAnnexAnswers(annexIii: { answer?: unknown; category?: unknown } | null | undefined): DomainAnswers {
    const answer = annexIii?.answer;
    if (answer === 'no') return Object.fromEntries(ANNEX_III_CATEGORIES.map((id) => [id, 'no']));
    const category = annexIii?.category;
    if (answer === 'yes' && typeof category === 'string' && (ANNEX_III_CATEGORIES as readonly string[]).includes(category)) return { [category]: 'yes' };
    return {};
}

/** 'yes' when any domain is yes, 'no' only when EVERY domain is no, else null — no declaration at all. */
export function annexAnswerFromDomains(domains: DomainAnswers | null | undefined): LadderAnswer {
    const d = domainsOf(domains);
    const values = ANNEX_III_CATEGORIES.map((id) => (isAnswer(d[id]) ? d[id] : 'unknown'));
    if (values.includes('yes')) return 'yes';
    return values.every((v) => v === 'no') ? 'no' : null;
}

/** The Annex III points a 'yes' rests on — what the outcome cites. */
export function annexArticlesFor(domains: DomainAnswers | null | undefined): string[] {
    const d = domainsOf(domains);
    return ANNEX_III_CATEGORIES.filter((id) => d[id] === 'yes').map((id) => ANNEX_III_ARTICLES[id]);
}

/** How many of the ten have an answer — the "4 of 10". */
export function annexAnsweredCount(domains: DomainAnswers | null | undefined): number {
    const d = domainsOf(domains);
    return ANNEX_III_CATEGORIES.filter((id) => isAnswer(d[id])).length;
}

export interface Art5Input {
    answer?: LadderAnswer;
    practices?: string[];
}

export interface AnnexInput {
    answer?: LadderAnswer;
    category?: string | null;
    domains?: DomainAnswers;
}

export interface LadderInput {
    containsAi?: boolean | null;
    art5?: Art5Input | null;
    customerFacing?: boolean | null;
    disclosurePresent?: boolean | null;
    generatesContent?: boolean | null;
    markingEnabled?: boolean | null;
    annexIii?: AnnexInput | null;
}

export interface Step2 {
    ok: boolean;
    failures: Step2Failure[];
    checks: number;
    passed: number;
}

export interface Verdict {
    applies: boolean;
    articles: string[];
    prohibited: boolean;
    highRisk: boolean;
    step1: { answered: boolean; ok: boolean };
    step2: Step2;
    step3: { answered: boolean; ok: boolean };
    outcomeCode: AiActOutcome;
}

/** Only the sub-cards that apply are checks; an unknown signal is neither a pass nor a failure. */
function step2Of(input: LadderInput): Step2 {
    const cards: [unknown, unknown, Step2Failure][] = [
        [input.customerFacing, input.disclosurePresent, 'disclosure'],
        [input.generatesContent, input.markingEnabled, 'marking'],
    ];
    const failures: Step2Failure[] = [];
    let checks = 0;
    let passed = 0;
    for (const [applies, value, failure] of cards) {
        if (!yes(applies)) continue;
        checks += 1;
        if (no(value)) failures.push(failure);
        else if (yes(value)) passed += 1;
    }
    return { ok: failures.length === 0, failures, checks, passed };
}

function codeOf(input: LadderInput, prohibited: boolean, highRisk: boolean): AiActOutcome {
    if (prohibited) return 'prohibited';
    if (highRisk) return 'high_risk';
    return yes(input.customerFacing) || yes(input.generatesContent) ? 'transparency' : 'minimal';
}

export function outcome(input?: LadderInput | null): Verdict {
    const i = input ?? {};
    const art5Answer = i.art5?.answer ?? null;
    const annexAnswer = i.annexIii?.answer ?? null;
    const step1 = { answered: isAnswer(art5Answer), ok: art5Answer === 'no' };
    const step3 = { answered: isAnswer(annexAnswer), ok: annexAnswer === 'no' };
    const step2 = step2Of(i);
    if (!yes(i.containsAi)) {
        return { applies: false, articles: [], prohibited: false, highRisk: false, step1, step2, step3, outcomeCode: 'not_applicable' };
    }
    const prohibited = art5Answer === 'yes';
    const highRisk = !prohibited && annexAnswer === 'yes';
    return { applies: true, articles: [...BASE_ARTICLES], prohibited, highRisk, step1, step2, step3, outcomeCode: codeOf(i, prohibited, highRisk) };
}

function art5Body(art5: Art5Input | null | undefined): AiActAnswersBody['art5'] {
    return { answer: art5?.answer ?? null, practices: Array.isArray(art5?.practices) ? [...art5.practices] : [] };
}

function annexBody(annexIii: AnnexInput | null | undefined): AiActAnswersBody['annex_iii'] {
    const domains = annexIii?.domains;
    return {
        answer: annexIii?.answer ?? null,
        category: annexIii?.category ?? null,
        // The ten answers themselves: the server re-derives `answer` from them.
        domains: domains && typeof domains === 'object' ? { ...domains } : {},
    };
}

/** The PUT body from the sheet's state. `art50` is what the checks see, never answered by hand. */
export function toAnswers({ art5, annexIii, signals }: { art5?: Art5Input | null; annexIii?: AnnexInput | null; signals?: AiActSignals | null }): AiActAnswersBody {
    const s: Partial<AiActSignals> = signals ?? {};
    return {
        art5: art5Body(art5),
        art50: {
            interacts: s.customerFacing ?? null,
            disclosure: s.disclosurePresent ?? null,
            generates: s.generatesContent ?? null,
            marking: s.markingEnabled ?? null,
        },
        annex_iii: annexBody(annexIii),
    };
}

/** The signals plus the person's two answers, as `outcome()` takes them. */
export function inputFromSignals(signals: AiActSignals | null | undefined, answers: { art5?: Art5Input; annexIii?: AnnexInput } = {}): LadderInput {
    const s: Partial<AiActSignals> = signals ?? {};
    return {
        containsAi: s.containsAi ?? null,
        customerFacing: s.customerFacing ?? null,
        disclosurePresent: s.disclosurePresent ?? null,
        generatesContent: s.generatesContent ?? null,
        markingEnabled: s.markingEnabled ?? null,
        art5: answers.art5 || { answer: null, practices: [] },
        annexIii: answers.annexIii || { answer: null, category: null },
    };
}

/** Whole days from `now` to MARKING_DEADLINE (negative once passed). Local-midnight arithmetic. */
export function daysUntilMarkingDeadline(now: Date | number | string = new Date()): number {
    const [y, m, d] = MARKING_DEADLINE.split('-').map(Number) as [number, number, number];
    const deadline = new Date(y, m - 1, d).getTime();
    const n = now instanceof Date ? now : new Date(now);
    const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    return Math.round((deadline - today) / 86400000);
}
