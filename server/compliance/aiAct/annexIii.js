/**
 * EU AI Act — Annex III as TEN QUESTIONS, not a keyword regex.
 *
 * What was here before: `ANNEX_III_RE`, one alternation of thirteen words,
 * deciding whether an automation is a high-risk use of AI. That is a legal
 * qualification made by word recognition, and it was wrong in both
 * directions at once:
 *
 *   FALSE POSITIVE — an automation whose description happens to contain
 *   "verzekering" because it mails a policy number got a medium finding that
 *   said "this may be a high-risk use of AI".
 *
 *   FALSE NEGATIVE — and this is the worse half — the regex covered five of
 *   the ten domains. Biometrics, critical infrastructure, law enforcement,
 *   migration and the administration of justice were not in it at all. A
 *   automation doing facial recognition on visitors produced no signal whatever.
 *
 * Worse still, the ladder in the browser asked about FOUR domains and offered
 * them as one all-or-nothing denial: tick the four chips and the product
 * recorded `annex_iii.answer = 'no'` — a declaration that a system is not
 * high-risk, made by someone who was never asked about six of the ten things
 * that would make it one.
 *
 * So the catalogue below is the whole of Annex III, each domain carrying the
 * POINT of the annex that settles it, and each answer is its own tri-state.
 * `answerFromDomains` is where the all-or-nothing bug is closed structurally:
 *
 *     'yes'      any one domain answered yes         → high risk
 *     'no'       EVERY domain answered no            → declared not high risk
 *     'unknown'  anything still open                 → no declaration at all
 *
 * The keyword patterns survive, demoted to what they always were: a HINT that
 * puts a domain at the top of the list. A hint never answers. That is the same
 * rule the RoPA follows for the lawful basis — deriving is allowed, filling it
 * in on the customer's behalf is not, because a pre-ticked legal position is
 * the product taking one.
 *
 * Pure and dependency-free, so `signals.js` (which does IO) and `assess.js`
 * (which must stay pure) can both read it.
 *
 * Annex III points, as the regulation numbers them:
 *   1 biometrics · 2 critical infrastructure · 3 education ·
 *   4 employment · 5 essential services (a public, b credit, c insurance) ·
 *   6 law enforcement · 7 migration/asylum/border · 8 justice & democracy
 */

'use strict';

/**
 * The ten domains. `id` is the vocabulary the stored answers use, `article`
 * is what an answer cites, `hint` is the ordering pattern — never a verdict.
 *
 * The ids are the ones `assess.ANNEX_III_CATEGORIES` already stored, so rows
 * written before this file existed keep their meaning.
 */
const ANNEX_III_DOMAINS = Object.freeze([
    {
        id: 'biometrics',
        point: 1,
        article: 'Annex III(1)',
        labelKey: 'compliance.annex_q_biometrics',
        hint: /biometri|gezichtsherkenning|face recognition|facial recognition|vingerafdruk|fingerprint|irisscan|emotieherkenning|emotion recognition/i,
    },
    {
        id: 'critical_infrastructure',
        point: 2,
        article: 'Annex III(2)',
        labelKey: 'compliance.annex_q_critical_infrastructure',
        hint: /kritieke infrastructuur|critical infrastructure|waterleiding|water supply|elektriciteitsnet|power grid|gasnet|verkeersleiding|road traffic|spoorwegbeveiliging/i,
    },
    {
        id: 'education',
        point: 3,
        article: 'Annex III(3)',
        labelKey: 'compliance.annex_q_education',
        hint: /onderwijs|education|student|leerling|examen|tentamen|toelating tot (een )?opleiding|admission to (a )?(course|programme)/i,
    },
    {
        id: 'employment',
        point: 4,
        article: 'Annex III(4)',
        labelKey: 'compliance.annex_q_employment',
        hint: /werving|recruit|sollicit|vacature|cv[- ]?screening|personeelsbeoordeling|performance review|promotie|ontslag|dismissal/i,
    },
    {
        id: 'essential_services',
        point: 5,
        article: 'Annex III(5)(a)',
        labelKey: 'compliance.annex_q_essential_services',
        hint: /essenti[ëe]le|nutsvoorz|utility|uitkering|bijstand|social benefit|noodoproep|emergency call|triage/i,
    },
    {
        id: 'credit',
        point: 5,
        article: 'Annex III(5)(b)',
        labelKey: 'compliance.annex_q_credit',
        hint: /credit|krediet|kredietwaardig|creditworthin|hypothe|mortgage|leningaanvraag|loan application/i,
    },
    {
        id: 'insurance',
        point: 5,
        article: 'Annex III(5)(c)',
        labelKey: 'compliance.annex_q_insurance',
        hint: /verzeker|insurance|premiestelling|premium setting|levensverzekering|zorgverzekering|health insurance/i,
    },
    {
        id: 'law_enforcement',
        point: 6,
        article: 'Annex III(6)',
        labelKey: 'compliance.annex_q_law_enforcement',
        hint: /opsporing|politie|police|law enforcement|strafbaar feit|criminal offence|verdachte|recidive|recidivism|leugendetect/i,
    },
    {
        id: 'migration',
        point: 7,
        article: 'Annex III(7)',
        labelKey: 'compliance.annex_q_migration',
        hint: /asiel|asylum|visumaanvraag|visa application|grenscontrole|border control|verblijfsvergunning|residence permit|migratiebeheer|migration management/i,
    },
    {
        id: 'justice',
        point: 8,
        article: 'Annex III(8)',
        labelKey: 'compliance.annex_q_justice',
        hint: /rechtspraak|rechterlijke|judicial|vonnis|verdict|geschilbeslechting|dispute resolution|verkiezingsuitslag|election outcome|stemgedrag|voting behaviour/i,
    },
]);

/** The domain ids, in catalogue order. The stored vocabulary. */
const ANNEX_III_IDS = Object.freeze(ANNEX_III_DOMAINS.map(d => d.id));

/** The one regex the old code exported, rebuilt from the catalogue so it cannot drift. */
const ANNEX_III_RE = new RegExp(ANNEX_III_DOMAINS.map(d => d.hint.source).join('|'), 'i');

const BY_ID = new Map(ANNEX_III_DOMAINS.map(d => [d.id, d]));

/** The ids whose keyword pattern the text touches. Ordering, never an answer. */
function hintsIn(text) {
    const t = String(text == null ? '' : text);
    if (!t) return [];
    return ANNEX_III_DOMAINS.filter(d => d.hint.test(t)).map(d => d.id);
}

/**
 * The ten questions for one target, hinted ones first.
 *
 * ALL TEN, always. A list that only shows what a pattern matched is the
 * false-negative half of the old regex wearing a different hat: the domains
 * nobody thought to write a word for are exactly the ones that need asking.
 */
function questionsFor(text) {
    const hinted = new Set(hintsIn(text));
    const q = ANNEX_III_DOMAINS.map(d => ({
        id: d.id, point: d.point, article: d.article, label_key: d.labelKey, hint: hinted.has(d.id),
    }));
    // Stable partition: hinted first, catalogue order within each half.
    return [...q.filter(x => x.hint), ...q.filter(x => !x.hint)];
}

/** yes | no | unknown, for one stored answer. Anything else is unknown. */
function tri(v) {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    const s = typeof v === 'string' ? v.toLowerCase() : '';
    return s === 'yes' || s === 'no' ? s : 'unknown';
}

/**
 * The per-domain answers as they are stored: every id present, every value a
 * tri-state. Keys the catalogue does not know are dropped — an allow-list, so
 * a client cannot smuggle free text into the JSONB.
 */
function normalizeDomainAnswers(input) {
    const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
    const out = {};
    for (const id of ANNEX_III_IDS) out[id] = tri(src[id]);
    return out;
}

/**
 * The single Annex III answer these ten add up to.
 *
 * `no` demands all ten. This is the whole point of the file: the ladder used
 * to reach `no` from four chips, which is a declaration about six domains
 * nobody was asked about.
 */
function answerFromDomains(domains) {
    const d = normalizeDomainAnswers(domains);
    const values = ANNEX_III_IDS.map(id => d[id]);
    if (values.includes('yes')) return 'yes';
    return values.every(v => v === 'no') ? 'no' : 'unknown';
}

/** Has anyone answered any of the ten? Distinguishes "not asked" from "answered no". */
function anyAnswered(domains) {
    const d = normalizeDomainAnswers(domains);
    return ANNEX_III_IDS.some(id => d[id] !== 'unknown');
}

/** The ids still open — what the drawer lists as "still to answer". */
function unansweredDomains(domains) {
    const d = normalizeDomainAnswers(domains);
    return ANNEX_III_IDS.filter(id => d[id] === 'unknown');
}

/**
 * The Annex III points an answer CITES: the articles of the domains answered
 * yes. This is the "answer that refers to the right article" — a high-risk
 * verdict says which point of the annex made it one, so the reader can look
 * it up instead of taking the product's word.
 */
function articlesFor(domains) {
    const d = normalizeDomainAnswers(domains);
    const out = [];
    for (const id of ANNEX_III_IDS) {
        if (d[id] === 'yes' && !out.includes(BY_ID.get(id).article)) out.push(BY_ID.get(id).article);
    }
    return out;
}

/** One domain's catalogue entry, or null. */
function domain(id) {
    const d = BY_ID.get(String(id || ''));
    return d ? { id: d.id, point: d.point, article: d.article, label_key: d.labelKey } : null;
}

module.exports = {
    ANNEX_III_DOMAINS,
    ANNEX_III_IDS,
    ANNEX_III_RE,
    hintsIn,
    questionsFor,
    normalizeDomainAnswers,
    answerFromDomains,
    anyAnswered,
    unansweredDomains,
    articlesFor,
    domain,
};
