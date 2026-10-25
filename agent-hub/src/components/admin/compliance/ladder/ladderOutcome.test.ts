// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    outcome,
    toAnswers,
    inputFromSignals,
    daysUntilMarkingDeadline,
    OUTCOMES,
    BASE_ARTICLES,
    ART5_PRACTICES,
    ANNEX_III_CATEGORIES,
    ANNEX_III_ARTICLES,
    annexAnswerFromDomains,
    annexArticlesFor,
    annexAnsweredCount,
    MARKING_DEADLINE,
} from './ladderOutcome';

const NO = { answer: 'no', practices: [] };
const YES = { answer: 'yes', practices: ['social_scoring'] };
const OPEN = { answer: null, practices: [] };

describe('ladderOutcome.outcome — the matrix (PLAN-BACKEND §2.11 assess.outcome)', () => {
    it('no AI → not_applicable, no articles, even when the other answers say yes', () => {
        const v = outcome({ containsAi: false, art5: YES, annexIii: { answer: 'yes' }, customerFacing: true, generatesContent: true });
        expect(v.outcomeCode).toBe('not_applicable');
        expect(v.applies).toBe(false);
        expect(v.articles).toEqual([]);
        expect(v.prohibited).toBe(false);
        expect(v.highRisk).toBe(false);
    });

    it('unknown containsAi (null) reads as not applicable — never as an AI system', () => {
        expect(outcome({ containsAi: null }).outcomeCode).toBe('not_applicable');
        expect(outcome({}).outcomeCode).toBe('not_applicable');
        expect(outcome(null).outcomeCode).toBe('not_applicable');
    });

    it('Art. 5 yes → prohibited, before Annex III is even looked at', () => {
        const v = outcome({ containsAi: true, art5: YES, annexIii: { answer: 'yes', category: 'employment' } });
        expect(v.outcomeCode).toBe('prohibited');
        expect(v.prohibited).toBe(true);
        expect(v.highRisk).toBe(false);
        expect(v.applies).toBe(true);
    });

    it('Annex III yes → high_risk', () => {
        const v = outcome({ containsAi: true, art5: NO, annexIii: { answer: 'yes', category: 'credit' } });
        expect(v.outcomeCode).toBe('high_risk');
        expect(v.highRisk).toBe(true);
        expect(v.articles).toEqual(['4', '50']);
    });

    it('customer-facing or generating content → transparency (Art. 4 + Art. 50)', () => {
        expect(outcome({ containsAi: true, art5: NO, annexIii: NO, customerFacing: true }).outcomeCode).toBe('transparency');
        expect(outcome({ containsAi: true, art5: NO, annexIii: NO, generatesContent: true }).outcomeCode).toBe('transparency');
        expect(outcome({ containsAi: true, art5: NO, annexIii: NO, customerFacing: true, generatesContent: true }).articles).toEqual(BASE_ARTICLES);
    });

    it('internal, non-generating AI → minimal', () => {
        const v = outcome({ containsAi: true, art5: NO, annexIii: NO, customerFacing: false, generatesContent: false });
        expect(v.outcomeCode).toBe('minimal');
        expect(v.applies).toBe(true);
    });

    it('unanswered steps do not change the code but are reported as unanswered', () => {
        const v = outcome({ containsAi: true, art5: OPEN, annexIii: OPEN, customerFacing: true });
        expect(v.outcomeCode).toBe('transparency');
        expect(v.step1).toEqual({ answered: false, ok: false });
        expect(v.step3).toEqual({ answered: false, ok: false });
    });

    it('every code it can produce is one of the server OUTCOMES', () => {
        const codes = new Set([
            outcome({ containsAi: false }).outcomeCode,
            outcome({ containsAi: true, art5: YES }).outcomeCode,
            outcome({ containsAi: true, art5: NO, annexIii: { answer: 'yes' } }).outcomeCode,
            outcome({ containsAi: true, art5: NO, annexIii: NO, customerFacing: true }).outcomeCode,
            outcome({ containsAi: true, art5: NO, annexIii: NO }).outcomeCode,
        ]);
        expect(codes.size).toBe(5);
        for (const c of codes) expect(OUTCOMES).toContain(c);
    });
});

describe('ladderOutcome.outcome — step 2 (Art. 50) from the signals', () => {
    it('counts a check per applicable sub-card and a failure per false signal', () => {
        const v = outcome({ containsAi: true, customerFacing: true, disclosurePresent: false, generatesContent: true, markingEnabled: false });
        expect(v.step2).toEqual({ ok: false, failures: ['disclosure', 'marking'], checks: 2, passed: 0 });
    });

    it('1 of 2 in order — the artboard case: notice shown, marking missing', () => {
        const v = outcome({ containsAi: true, customerFacing: true, disclosurePresent: true, generatesContent: true, markingEnabled: false });
        expect(v.step2).toEqual({ ok: false, failures: ['marking'], checks: 2, passed: 1 });
        // …and the CODE is still transparency: a missing marking is a failing check, not a regime.
        expect(v.outcomeCode).toBe('transparency');
    });

    it('an unknown signal (null) is neither a pass nor a failure', () => {
        const v = outcome({ containsAi: true, customerFacing: true, disclosurePresent: null, generatesContent: true, markingEnabled: null });
        expect(v.step2).toEqual({ ok: true, failures: [], checks: 2, passed: 0 });
    });

    it('a sub-card that does not apply is not a check', () => {
        const v = outcome({ containsAi: true, customerFacing: false, disclosurePresent: false, generatesContent: false, markingEnabled: false });
        expect(v.step2).toEqual({ ok: true, failures: [], checks: 0, passed: 0 });
    });
});

describe('ladderOutcome helpers', () => {
    it('toAnswers builds the PUT body: art50 from signals, the two human answers verbatim', () => {
        const body = toAnswers({
            art5: NO,
            annexIii: { answer: 'no', category: null },
            signals: { customer_facing: true, disclosure_present: false, generates_content: true, marking_enabled: true },
        });
        expect(body).toEqual({
            art5: { answer: 'no', practices: [] },
            art50: { interacts: true, disclosure: false, generates: true, marking: true },
            // The ten answers travel too, not just what they add up to: the
            // server re-derives `answer` from them and ignores ours the moment
            // one is answered, so a client cannot send a 'no' it did not earn.
            annex_iii: { answer: 'no', category: null, domains: {} },
        });
        // Missing signals → null, never false.
        expect(toAnswers({ art5: OPEN, annexIii: OPEN }).art50).toEqual({ interacts: null, disclosure: null, generates: null, marking: null });
    });

    it('inputFromSignals maps snake_case server signals onto the outcome input', () => {
        const input = inputFromSignals(
            { contains_ai: true, customer_facing: false, disclosure_present: null, generates_content: true, marking_enabled: false },
            { art5: NO, annexIii: NO },
        );
        expect(input).toEqual({
            containsAi: true, customerFacing: false, disclosurePresent: null, generatesContent: true, markingEnabled: false,
            art5: NO, annexIii: NO,
        });
        expect(inputFromSignals(null).containsAi).toBeNull();
        expect(inputFromSignals(null).art5).toEqual({ answer: null, practices: [] });
    });

    it('daysUntilMarkingDeadline counts whole days to 2 Dec 2026 (the artboard says 79 on 14 Sep 2026)', () => {
        expect(MARKING_DEADLINE).toBe('2026-12-02');
        expect(daysUntilMarkingDeadline(new Date(2026, 8, 14, 15, 30))).toBe(79);
        expect(daysUntilMarkingDeadline(new Date(2026, 11, 2, 9))).toBe(0);
        expect(daysUntilMarkingDeadline(new Date(2026, 11, 3))).toBe(-1);
    });

    it('exposes the chip vocabularies the modal and the server share — ALL of them', () => {
        // These counts were 3 and 8, and 4 and 10: the screen asked about a
        // subset and then recorded a declaration about the whole. Both lists
        // are now the server's own (assess.ART5_PRACTICES,
        // annexIii.ANNEX_III_IDS), and the ids are spelled the server's way —
        // 'employment' not 'recruitment', 'credit' not 'credit_scoring',
        // 'emotion_recognition_work_education' not 'emotion_recognition_at_work'.
        expect(ART5_PRACTICES).toHaveLength(8);
        expect(ANNEX_III_CATEGORIES).toHaveLength(10);
        expect(ART5_PRACTICES).toContain('emotion_recognition_work_education');
        expect(ANNEX_III_CATEGORIES).toEqual([
            'biometrics', 'critical_infrastructure', 'education', 'employment', 'essential_services',
            'credit', 'insurance', 'law_enforcement', 'migration', 'justice',
        ]);
        // Every domain cites a point of the annex, so a verdict can be looked up.
        expect(Object.keys(ANNEX_III_ARTICLES).sort()).toEqual([...ANNEX_III_CATEGORIES].sort());
        expect(ANNEX_III_ARTICLES.employment).toBe('Annex III(4)');
        expect([ANNEX_III_ARTICLES.essential_services, ANNEX_III_ARTICLES.credit, ANNEX_III_ARTICLES.insurance])
            .toEqual(['Annex III(5)(a)', 'Annex III(5)(b)', 'Annex III(5)(c)']);
    });

    it('a "no" needs all ten — four answers are not a declaration', () => {
        const four = { employment: 'no', credit: 'no', education: 'no', essential_services: 'no' };
        // This is exactly what the four-chip ladder used to send as `answer: 'no'`.
        expect(annexAnswerFromDomains(four)).toBeNull();
        expect(annexAnsweredCount(four)).toBe(4);

        const ten = Object.fromEntries(ANNEX_III_CATEGORIES.map((id) => [id, 'no']));
        expect(annexAnswerFromDomains(ten)).toBe('no');
        expect(annexAnsweredCount(ten)).toBe(10);

        // One yes decides without waiting for the rest, and names its point.
        expect(annexAnswerFromDomains({ law_enforcement: 'yes' })).toBe('yes');
        expect(annexArticlesFor({ law_enforcement: 'yes' })).toEqual(['Annex III(6)']);
        expect(annexAnswerFromDomains({ ...ten, migration: 'yes' })).toBe('yes');
        expect(annexAnswerFromDomains({})).toBeNull();
        expect(annexAnswerFromDomains(null)).toBeNull();
        expect(annexArticlesFor({ employment: 'no' })).toEqual([]);

        // …and the client agrees with the server, which is what actually gets
        // stored: the same map through outcome() is not high-risk on four.
        expect(outcome({ containsAi: true, annexIii: { answer: annexAnswerFromDomains(four) } }).outcomeCode)
            .toBe('minimal');
        expect(outcome({ containsAi: true, annexIii: { answer: annexAnswerFromDomains({ credit: 'yes' }) } }).outcomeCode)
            .toBe('high_risk');
    });
});
