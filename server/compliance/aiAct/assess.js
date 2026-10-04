/**
 * EU AI Act — turning detected signals + the admin's answers into a
 * classification outcome. Pure; the store (stores/aiActAssessmentStore.js)
 * persists what this returns and the route (routes/compliance/aiAct.js)
 * calls it.
 *
 * Outcome ladder (first match wins):
 *   not_applicable  no AI in the target (signals.contains_ai false)
 *   prohibited      art5.answer === 'yes'          — an Art. 5 practice
 *   high_risk       annex_iii.answer === 'yes'     — an Annex III use case
 *   transparency    customer-facing or content-generating (Art. 50 duties)
 *   minimal         everything else
 *
 * The admin's Art. 50 answers can widen "transparency" (they know the automation
 * mails the document to a customer even when the graph does not show a form)
 * but never narrow it: what the platform detected stands.
 *
 * ANNEX III IS TEN QUESTIONS, NOT ONE. `annex_iii.answer` used to be a single
 * yes/no the ladder set by counting chips, and the ladder only ever showed
 * four of the ten domains — so ticking everything on screen recorded "not
 * high-risk" on behalf of someone who had not been asked about biometrics,
 * critical infrastructure, law enforcement, migration or the administration of
 * justice. The answers now carry `annex_iii.domains`, one tri-state per
 * domain, and `answer` is DERIVED from them: `no` needs all ten. A row stored
 * before this (domains all unknown) keeps its own `answer` — the derivation
 * only takes over once somebody has actually answered a domain.
 * See compliance/aiAct/annexIii.js.
 */

const annexIii = require('./annexIii');

const OUTCOMES = Object.freeze(['not_applicable', 'prohibited', 'high_risk', 'transparency', 'minimal']);
const YES = new Set(['yes', 'true', true]);
/** Attestations expire after this many months (aiActAssessmentStore.VALID_MONTHS agrees). */
const VALID_MONTHS = 12;

const ART5_PRACTICES = Object.freeze([
    'subliminal_manipulation', 'exploiting_vulnerabilities', 'social_scoring', 'criminal_risk_profiling',
    'facial_scraping', 'emotion_recognition_work_education', 'biometric_categorisation', 'realtime_biometric_id',
]);
/** The ten Annex III domains, from the catalogue — the one vocabulary. */
const ANNEX_III_CATEGORIES = annexIii.ANNEX_III_IDS;

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function _yes(v) { return YES.has(typeof v === 'string' ? v.toLowerCase() : v); }
function _str(v, max = 200) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function _strList(v, allowed, max = 20) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const x of v) {
        if (typeof x !== 'string') continue;
        if (allowed && !allowed.includes(x)) continue;
        if (!out.includes(x)) out.push(x);
        if (out.length >= max) break;
    }
    return out;
}
function _tri(v) {
    // yes | no | unknown — the questionnaire's three-state answer
    if (v === true) return 'yes';
    if (v === false) return 'no';
    const s = typeof v === 'string' ? v.toLowerCase() : '';
    return s === 'yes' || s === 'no' ? s : 'unknown';
}

/**
 * The answers as the store gets them — an explicit allow-list so a client
 * cannot smuggle names, prompts or free text into the JSONB
 * ({ art5:{answer,practices[]}, art50:{interacts,disclosure,generates,marking},
 *    annex_iii:{answer,category,domains{<ten ids>: yes|no|unknown}} }).
 *
 * `annex_iii.domains` is itself an allow-list (annexIii.normalizeDomainAnswers
 * keeps the ten known ids and drops everything else), and `annex_iii.answer`
 * is derived from it the moment any domain has been answered.
 */
function normalizeAnswers(input) {
    const a = isObject(input) ? input : {};
    const art5 = isObject(a.art5) ? a.art5 : {};
    const art50 = isObject(a.art50) ? a.art50 : {};
    const annex = isObject(a.annex_iii) ? a.annex_iii : {};
    const domains = annexIii.normalizeDomainAnswers(annex.domains);
    // A stored row from before the ten questions existed has no domains at
    // all; its own `answer` is all there is, and dropping it would silently
    // un-declare every assessment already on file.
    const answer = annexIii.anyAnswered(domains) ? annexIii.answerFromDomains(domains) : _tri(annex.answer);
    return {
        art5: { answer: _tri(art5.answer), practices: _strList(art5.practices, ART5_PRACTICES) },
        art50: {
            interacts: _tri(art50.interacts),
            disclosure: _tri(art50.disclosure),
            generates: _tri(art50.generates),
            marking: _tri(art50.marking),
        },
        annex_iii: {
            answer,
            category: ANNEX_III_CATEGORIES.includes(annex.category) ? annex.category : _str(annex.category, 40) || null,
            domains,
        },
    };
}

/** The outcome for a signals/answers pair. Tolerates raw (un-normalised) answers. */
function outcome(signals, answers) {
    const s = isObject(signals) ? signals : {};
    const a = normalizeAnswers(answers);
    if (!s.contains_ai) return 'not_applicable';
    if (a.art5.answer === 'yes') return 'prohibited';
    if (a.annex_iii.answer === 'yes') return 'high_risk';
    const transparency = !!s.customer_facing || !!s.generates_content
        || a.art50.interacts === 'yes' || a.art50.generates === 'yes';
    return transparency ? 'transparency' : 'minimal';
}

/** attested_at + 12 months (UTC month arithmetic, like the store's default). */
function expiresAt(attestedAt = new Date(), months = VALID_MONTHS) {
    const d = new Date(attestedAt instanceof Date ? attestedAt.getTime() : new Date(attestedAt).getTime());
    if (Number.isNaN(d.getTime())) throw new Error('attested_at is not a date');
    d.setUTCMonth(d.getUTCMonth() + months);
    return d;
}

/**
 * The open Art. 50 duties for a target, from signals and answers — what the
 * drawer lists as "still to do". Pure hints; the checks decide pass/fail.
 */
function openDuties(signals, answers) {
    const s = isObject(signals) ? signals : {};
    const a = normalizeAnswers(answers);
    const out = [];
    if (!s.contains_ai) return out;
    const interacts = s.customer_facing || a.art50.interacts === 'yes';
    const generates = s.generates_content || a.art50.generates === 'yes';
    if (interacts && !s.disclosure_present && a.art50.disclosure !== 'yes') out.push('art50_1_disclosure');
    if (generates && !s.marking_enabled) out.push('art50_2_marking');
    return out;
}

/**
 * The full assessment the route stores: normalised answers, outcome, duties,
 * expiry — plus the two things the ten questions add.
 *
 * `annex_iii_articles` is the "answer that refers to the right article": a
 * high-risk verdict names the POINT of Annex III that made it one, so a reader
 * can look the qualification up instead of taking the product's word for it.
 * `annex_iii_open` is the other half of honesty — which of the ten are still
 * unanswered, so an `unknown` never reads like a `no`.
 */
function assess(signals, answers, { attestedAt = new Date() } = {}) {
    const normalized = normalizeAnswers(answers);
    const result = outcome(signals, normalized);
    return {
        answers: normalized,
        outcome: result,
        open_duties: openDuties(signals, normalized),
        annex_iii_articles: annexIii.articlesFor(normalized.annex_iii.domains),
        annex_iii_open: annexIii.unansweredDomains(normalized.annex_iii.domains),
        // a not_applicable verdict does not go stale — nothing to re-check yearly
        expires_at: result === 'not_applicable' ? null : expiresAt(attestedAt),
    };
}

module.exports = {
    OUTCOMES,
    VALID_MONTHS,
    ART5_PRACTICES,
    ANNEX_III_CATEGORIES,
    ANNEX_III_DOMAINS: annexIii.ANNEX_III_DOMAINS,
    normalizeAnswers,
    outcome,
    expiresAt,
    openDuties,
    assess,
};
