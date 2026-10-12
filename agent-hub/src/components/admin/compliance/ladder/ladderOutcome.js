/**
 * ladderOutcome — the pure verdict of the AI Act three-step ladder
 * (Compliance Center redesign, Sep 2026; artboard frame 1f).
 *
 * The client copy of `server/compliance/aiAct/assess.outcome` (PLAN-BACKEND
 * §2.11): the modal shows the verdict live while the user ticks chips, the
 * server recomputes it on PUT and stores its own word. Both must agree, so
 * the rules are stated once here in the same order as the server:
 *
 *   no AI                      → not_applicable
 *   Art. 5 answer 'yes'        → prohibited
 *   Annex III answer 'yes'     → high_risk
 *   customer-facing or generates content → transparency
 *   otherwise                  → minimal
 *
 * Step 2 (Art. 50) never changes the outcome CODE — a missing disclosure or
 * marking is a failing check, not a different regime — but it is reported in
 * `step2.failures` so the modal can paint the sub-cards and the outcome box
 * can say what is still missing.
 *
 * Every input is tolerant: `null`/`undefined` means "unknown", and an unknown
 * signal never counts as a failure (a count that is unknown renders nothing).
 */

export const OUTCOMES = Object.freeze(['not_applicable', 'prohibited', 'high_risk', 'transparency', 'minimal']);

/** Articles that apply once a system contains AI at all (literacy + transparency). */
export const BASE_ARTICLES = Object.freeze(['4', '50']);

/**
 * Art. 5 practices the negation chips deny — the SERVER's vocabulary
 * (compliance/aiAct/assess.ART5_PRACTICES), all eight of them.
 *
 * It used to be three, spelled differently from the server's
 * ('emotion_recognition_at_work' against 'emotion_recognition_work_education'),
 * and the drift stayed invisible only because the modal sent `practices: []`.
 * Three chips reaching `answer: 'no'` meant the product recorded "this is not
 * a prohibited practice" for somebody who was never asked about subliminal
 * manipulation, exploiting vulnerabilities, criminal risk profiling, facial
 * scraping or real-time biometric identification.
 */
export const ART5_PRACTICES = Object.freeze([
    'subliminal_manipulation', 'exploiting_vulnerabilities', 'social_scoring', 'criminal_risk_profiling',
    'facial_scraping', 'emotion_recognition_work_education', 'biometric_categorisation', 'realtime_biometric_id',
]);

/**
 * The ten Annex III domains — the server's vocabulary again
 * (compliance/aiAct/annexIii.ANNEX_III_IDS), and the same story: four chips
 * here, ten domains there, spelled 'recruitment'/'credit_scoring' against
 * 'employment'/'credit'. Ticking everything on screen recorded "not
 * high-risk" on behalf of someone never asked about biometrics, critical
 * infrastructure, law enforcement, migration or the administration of justice.
 */
export const ANNEX_III_CATEGORIES = Object.freeze([
    'biometrics', 'critical_infrastructure', 'education', 'employment', 'essential_services',
    'credit', 'insurance', 'law_enforcement', 'migration', 'justice',
]);

/** The point of Annex III each domain cites — mirrors compliance/aiAct/annexIii.js. */
export const ANNEX_III_ARTICLES = Object.freeze({
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
});

/**
 * The ten Annex III answers for a row saved before the ten questions existed,
 * which carries one `{ answer, category }` for all of them. A 'no' covered
 * every area, so it still reads as ten noes. A 'yes' never did: copying it to
 * all ten would have "Record as self-declared" attest biometrics, law
 * enforcement and migration for an insurance quote. It sets only the area it
 * named, when that is a known one, and otherwise leaves all ten open.
 */
export function legacyAnnexAnswers(annexIii) {
    const answer = annexIii?.answer;
    if (answer === 'no') return Object.fromEntries(ANNEX_III_CATEGORIES.map(id => [id, 'no']));
    if (answer === 'yes' && ANNEX_III_CATEGORIES.includes(annexIii.category)) return { [annexIii.category]: 'yes' };
    return {};
}

/**
 * The single Annex III answer a per-domain map adds up to — the client copy of
 * `compliance/aiAct/annexIii.answerFromDomains`, and the one rule that makes
 * four answers unable to masquerade as a declaration:
 *
 *   'yes'   any one domain answered yes
 *   'no'    EVERY domain answered no
 *   null    anything still open — no declaration at all
 *
 * The server derives the same thing from the same map, so a client that
 * disagrees loses: it is the server's word that is stored.
 */
export function annexAnswerFromDomains(domains) {
    const d = domains && typeof domains === 'object' ? domains : {};
    const values = ANNEX_III_CATEGORIES.map((id) => (d[id] === 'yes' || d[id] === 'no' ? d[id] : 'unknown'));
    if (values.includes('yes')) return 'yes';
    return values.every((v) => v === 'no') ? 'no' : null;
}

/** The Annex III points a 'yes' rests on — what the outcome box cites. */
export function annexArticlesFor(domains) {
    const d = domains && typeof domains === 'object' ? domains : {};
    return ANNEX_III_CATEGORIES.filter((id) => d[id] === 'yes').map((id) => ANNEX_III_ARTICLES[id]);
}

/** How many of the ten have an answer — the "4 of 10" the step header prints. */
export function annexAnsweredCount(domains) {
    const d = domains && typeof domains === 'object' ? domains : {};
    return ANNEX_III_CATEGORIES.filter((id) => d[id] === 'yes' || d[id] === 'no').length;
}

/** The Art. 50(2) marking obligation for existing systems (fixed date, PLAN-BACKEND §2.11 / art50-content-marking). */
export const MARKING_DEADLINE = '2026-12-02';

/** Art. 5 in force; Art. 50 in force; Annex III from (frameworks.js catalogue). */
export const ART5_IN_FORCE = '2025-02-02';
export const ART50_IN_FORCE = '2026-08-02';
export const ANNEX_III_FROM = '2027-12-02';

const yes = (v) => v === true || v === 'yes';
const no = (v) => v === false || v === 'no';

/**
 * @param {object} input
 * @param {boolean|null} input.containsAi
 * @param {{answer:'yes'|'no'|null, practices?:string[]}} [input.art5]
 * @param {boolean|null} [input.customerFacing]
 * @param {boolean|null} [input.disclosurePresent]   null = unknown client-side
 * @param {boolean|null} [input.generatesContent]
 * @param {boolean|null} [input.markingEnabled]
 * @param {{answer:'yes'|'no'|null, category?:string|null}} [input.annexIii]
 * @returns {{
 *   applies: boolean, articles: string[], prohibited: boolean, highRisk: boolean,
 *   step1: { answered: boolean, ok: boolean },
 *   step2: { ok: boolean, failures: Array<'disclosure'|'marking'>, checks: number, passed: number },
 *   step3: { answered: boolean, ok: boolean },
 *   outcomeCode: 'not_applicable'|'prohibited'|'high_risk'|'transparency'|'minimal'
 * }}
 */
export function outcome(input = {}) {
    const {
        containsAi = null,
        art5 = {},
        customerFacing = null,
        disclosurePresent = null,
        generatesContent = null,
        markingEnabled = null,
        annexIii = {},
    } = input || {};

    const art5Answer = art5?.answer ?? null;
    const annexAnswer = annexIii?.answer ?? null;

    const step1 = { answered: art5Answer === 'yes' || art5Answer === 'no', ok: art5Answer === 'no' };
    const step3 = { answered: annexAnswer === 'yes' || annexAnswer === 'no', ok: annexAnswer === 'no' };

    // Step 2: only the sub-cards that apply are "checks"; an unknown signal is
    // neither a pass nor a failure.
    const failures = [];
    let checks = 0;
    let passed = 0;
    if (yes(customerFacing)) {
        checks += 1;
        if (no(disclosurePresent)) failures.push('disclosure');
        else if (yes(disclosurePresent)) passed += 1;
    }
    if (yes(generatesContent)) {
        checks += 1;
        if (no(markingEnabled)) failures.push('marking');
        else if (yes(markingEnabled)) passed += 1;
    }
    const step2 = { ok: failures.length === 0, failures, checks, passed };

    if (!yes(containsAi)) {
        return {
            applies: false,
            articles: [],
            prohibited: false,
            highRisk: false,
            step1,
            step2,
            step3,
            outcomeCode: 'not_applicable',
        };
    }

    const prohibited = art5Answer === 'yes';
    const highRisk = !prohibited && annexAnswer === 'yes';
    let outcomeCode = 'minimal';
    if (prohibited) outcomeCode = 'prohibited';
    else if (highRisk) outcomeCode = 'high_risk';
    else if (yes(customerFacing) || yes(generatesContent)) outcomeCode = 'transparency';

    return {
        applies: true,
        articles: [...BASE_ARTICLES],
        prohibited,
        highRisk,
        step1,
        step2,
        step3,
        outcomeCode,
    };
}

/**
 * The server's `answers` body from the modal's state — the shape of
 * `PUT /ai-act/assessments/:kind/:id` (PLAN.md §1 routes table). `art50` is
 * derived from signals: the user does not answer it, the checks do.
 */
export function toAnswers({ art5, annexIii, signals = {} }) {
    const s = signals || {};
    return {
        art5: {
            answer: art5?.answer ?? null,
            practices: Array.isArray(art5?.practices) ? [...art5.practices] : [],
        },
        art50: {
            interacts: s.customer_facing ?? null,
            disclosure: s.disclosure_present ?? null,
            generates: s.generates_content ?? null,
            marking: s.marking_enabled ?? null,
        },
        annex_iii: {
            answer: annexIii?.answer ?? null,
            category: annexIii?.category ?? null,
            // The ten answers themselves, not just what they add up to. The
            // server re-derives `answer` from these and ignores ours the
            // moment one of them is answered, so a client that sends a 'no'
            // it did not earn does not get one.
            domains: annexIii?.domains && typeof annexIii.domains === 'object' ? { ...annexIii.domains } : {},
        },
    };
}

/** Server `signals` (snake_case) → `outcome()` input (camelCase) + the user's two answers. */
export function inputFromSignals(signals, { art5, annexIii } = {}) {
    const s = signals || {};
    return {
        containsAi: s.contains_ai ?? null,
        customerFacing: s.customer_facing ?? null,
        disclosurePresent: s.disclosure_present ?? null,
        generatesContent: s.generates_content ?? null,
        markingEnabled: s.marking_enabled ?? null,
        art5: art5 || { answer: null, practices: [] },
        annexIii: annexIii || { answer: null, category: null },
    };
}

/** Whole days from `now` to `MARKING_DEADLINE` (negative once passed). Local-midnight arithmetic. */
export function daysUntilMarkingDeadline(now = new Date()) {
    const [y, m, d] = MARKING_DEADLINE.split('-').map(Number);
    const deadline = new Date(y, m - 1, d).getTime();
    const n = now instanceof Date ? now : new Date(now);
    const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    return Math.round((deadline - today) / 86400000);
}

export default outcome;
