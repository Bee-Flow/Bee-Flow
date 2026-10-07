/**
 * DIFFERENTIAL lockstep: the ladder's verdict against the web's
 * ladderOutcome.js, run side by side on the same fixtures. The web reads the
 * server's raw snake_case signals; the port reads them through the contract
 * reader (readAssessment), so each fixture is the raw row and both sides get
 * it in the form they take. The web file has no imports; it is evaluated
 * from its source (loadWebModule), like the other compliance lockstep tests
 * that read the ladder's web files.
 */

import { loadWebModule } from '@/shared/testing/webModule';

import { readAssessment, type AiActSignals } from '../api';
import * as port from './ladderOutcome';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const web: any = loadWebModule('components/admin/compliance/ladder/ladderOutcome.js');

const read = (raw: unknown): AiActSignals => readAssessment({ signals: raw }).signals;

const TRI = [true, false, null] as const;
const ANSWERS = [{ answer: 'yes' }, { answer: 'no' }, { answer: null }, {}] as const;

/** No signals at all, then every combination of the five (the server sends booleans). */
function signalRows(): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = [{}];
    for (const contains_ai of TRI)
        for (const customer_facing of TRI)
            for (const disclosure_present of TRI)
                for (const generates_content of TRI)
                    for (const marking_enabled of TRI) {
                        rows.push({ contains_ai, customer_facing, disclosure_present, generates_content, marking_enabled });
                    }
    return rows;
}

const DOMAINS: Record<string, unknown>[] = [
    {},
    { biometrics: 'no' },
    { credit: 'yes', employment: 'yes', justice: 'no' },
    Object.fromEntries(port.ANNEX_III_CATEGORIES.map((id) => [id, 'no'])),
    { ...Object.fromEntries(port.ANNEX_III_CATEGORIES.map((id) => [id, 'no'])), insurance: 'yes' },
    { ...Object.fromEntries(port.ANNEX_III_CATEGORIES.slice(1).map((id) => [id, 'no'])), biometrics: 'unknown' },
    { made_up: 'yes', law_enforcement: 'maybe' },
];

describe('the vocabulary', () => {
    it('is the web’s', () => {
        expect(port.OUTCOMES).toEqual(web.OUTCOMES);
        expect(port.BASE_ARTICLES).toEqual(web.BASE_ARTICLES);
        expect(port.ART5_PRACTICES).toEqual(web.ART5_PRACTICES);
        expect(port.ANNEX_III_CATEGORIES).toEqual(web.ANNEX_III_CATEGORIES);
        expect(port.ANNEX_III_ARTICLES).toEqual(web.ANNEX_III_ARTICLES);
        expect([port.MARKING_DEADLINE, port.ART5_IN_FORCE, port.ART50_IN_FORCE, port.ANNEX_III_FROM]).toEqual([
            web.MARKING_DEADLINE, web.ART5_IN_FORCE, web.ART50_IN_FORCE, web.ANNEX_III_FROM,
        ]);
    });
});

describe('legacyAnnexAnswers (a row from before the ten questions)', () => {
    it('agrees with the web on every answer and area', () => {
        for (const answer of ['yes', 'no', null, 'unknown', undefined])
            for (const category of [null, undefined, 'insurance', 'biometrics', 'made_up', 7]) {
                const row = { answer, category };
                expect([row, port.legacyAnnexAnswers(row)]).toEqual([row, web.legacyAnnexAnswers(row)]);
            }
        expect(port.legacyAnnexAnswers(null)).toEqual(web.legacyAnnexAnswers(null));
        expect(port.legacyAnnexAnswers(undefined)).toEqual(web.legacyAnnexAnswers(undefined));
    });
});

describe('outcome', () => {
    it('agrees on every signal combination and every pair of answers', () => {
        let cases = 0;
        for (const raw of signalRows())
            for (const art5 of ANSWERS)
                for (const annexIii of ANSWERS) {
                    const answers = { art5: { ...art5, practices: [] }, annexIii: { ...annexIii, category: null } } as never;
                    const mine = port.outcome(port.inputFromSignals(read(raw), answers));
                    const theirs = web.outcome(web.inputFromSignals(raw, answers));
                    expect(mine).toEqual(theirs);
                    cases += 1;
                }
        expect(cases).toBeGreaterThan(3000);
    });

    it('agrees on a missing or empty input', () => {
        expect(port.outcome()).toEqual(web.outcome());
        expect(port.outcome(null)).toEqual(web.outcome(null));
        expect(port.outcome({})).toEqual(web.outcome({}));
        expect(port.outcome({ containsAi: true, art5: null, annexIii: null })).toEqual(web.outcome({ containsAi: true, art5: null, annexIii: null }));
    });
});

describe('the Annex III helpers', () => {
    it.each(DOMAINS.map((d, i) => [i, d] as const))('agree on case %i', (_i, domains) => {
        expect(port.annexAnswerFromDomains(domains as never)).toEqual(web.annexAnswerFromDomains(domains));
        expect(port.annexArticlesFor(domains as never)).toEqual(web.annexArticlesFor(domains));
        expect(port.annexAnsweredCount(domains as never)).toEqual(web.annexAnsweredCount(domains));
    });

    it('agree on nothing at all', () => {
        for (const nothing of [null, undefined]) {
            expect(port.annexAnswerFromDomains(nothing)).toEqual(web.annexAnswerFromDomains(nothing));
            expect(port.annexArticlesFor(nothing)).toEqual(web.annexArticlesFor(nothing));
            expect(port.annexAnsweredCount(nothing)).toEqual(web.annexAnsweredCount(nothing));
        }
    });
});

describe('toAnswers — the PUT body', () => {
    const STATES = [
        { art5: { answer: 'no', practices: [] }, annexIii: { answer: 'no', category: null, domains: DOMAINS[3] } },
        { art5: { answer: null, practices: ['social_scoring'] }, annexIii: { answer: 'yes', category: 'credit', domains: DOMAINS[2] } },
        { art5: undefined, annexIii: undefined },
        { art5: { answer: 'yes' }, annexIii: { answer: null } },
    ] as { art5?: port.Art5Input; annexIii?: port.AnnexInput }[];
    const RAW = [
        {},
        { customer_facing: true, disclosure_present: false, generates_content: true, marking_enabled: true },
        { customer_facing: false, disclosure_present: null, generates_content: false, marking_enabled: false },
    ];

    it('is the web’s body for every state and signal row', () => {
        for (const state of STATES)
            for (const raw of RAW) {
                expect(port.toAnswers({ ...state, signals: read(raw) })).toEqual(web.toAnswers({ ...state, signals: raw }));
            }
        expect(port.toAnswers({ ...STATES[0], signals: null })).toEqual(web.toAnswers({ ...STATES[0], signals: null }));
    });

    it('copies the answers rather than sharing them', () => {
        const domains = { credit: 'yes' as const };
        const body = port.toAnswers({ annexIii: { answer: 'yes', domains }, signals: null });
        expect(body.annex_iii.domains).toEqual(domains);
        expect(body.annex_iii.domains).not.toBe(domains);
    });
});

describe('daysUntilMarkingDeadline', () => {
    it.each(['2026-09-27T10:00:00', '2026-12-01T23:59:00', '2026-12-02T00:00:00', '2026-12-03T08:00:00', '2027-03-01T12:00:00'])('agrees on %s', (iso) => {
        const now = new Date(iso);
        expect(port.daysUntilMarkingDeadline(now)).toBe(web.daysUntilMarkingDeadline(now));
        expect(port.daysUntilMarkingDeadline(now.getTime())).toBe(web.daysUntilMarkingDeadline(now.getTime()));
    });
});
