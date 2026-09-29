// @typecheck
/**
 * WHICH COLUMNS OF A TABLE HOLD PERSONAL DATA — asked once, answered in one
 * vocabulary, with a count behind every claim.
 *
 * The same question used to be answered in three places with three different
 * word lists, and they disagreed about the same table:
 *
 *   - `playbooks/phases/compliancePhase.js` matched COLUMN NAMES against its
 *     own patterns and spoke in kinds ('email', 'id_number', 'supplier').
 *   - `playbooks/phases/complianceFacts.js` asked the PII Guard about the
 *     VALUES and translated the guard's categories through a second, private
 *     table — one that had quietly stopped matching the guard. It keyed on the
 *     category squashed to snake_case, so of the twenty-one categories the
 *     guard actually returns only `Person`, `Email` and `Address` ever landed:
 *     'PhoneNumber' became 'phonenumber', which was in no table, so a column of
 *     nothing but telephone numbers — or IBANs, or BSNs, or dates of birth —
 *     came back "no personal data here". That is the worst possible direction
 *     for this product to be wrong in, and nothing failed to say so.
 *   - `playbooks/phases/designPhase.js` reached into the compliance phase for
 *     the name detector so the designer would redact the same columns the
 *     review flags.
 *
 * `playbooks/` and `compliance/` are both FEATURES, and one feature may never
 * require another (ARCHITECTURE.md, layering.test.js) — so the shared answer
 * belongs here, in core, next to the guard it asks and next to
 * `piiCategories.js`, whose canonical ids are now the only spelling of a
 * category this file understands. A category the guard adds tomorrow is either
 * mapped to a kind here or listed as deliberately-not-personal, and
 * `personalColumns.test.js` fails if it is neither.
 *
 * TWO WAYS OF ASKING, AND THEY DO NOT OUTRANK EACH OTHER BY ACCIDENT:
 *
 *   - VALUES WIN wherever the guard could read the column. A column called
 *     "supplier" holding company names is not personal data; a column called
 *     "notes" holding e-mail addresses is.
 *   - NAMES ANSWER for a column the guard could not read — a date column, a
 *     number column, an empty one, or every column when no guard is installed.
 *     Before, one readable text column made the value scan "the answer" for the
 *     whole table, and a `date` column called `dob` stopped being personal data
 *     the moment a notes column was scanned.
 *   - `null` (nobody looked) stays different from `[]` (the guard looked and
 *     found nothing). A review that reports "nothing found" precisely when it
 *     could not look is the one thing this surface must never do.
 *
 * AND A COUNT, WHICH IS THE POINT OF SCANNING VALUES AT ALL. The value scan
 * used to join every sampled value of a column into one blob and ask the guard
 * once, so one stray address in a free-text notes column read exactly like a
 * column of two hundred addresses: both came back "personal data", with no
 * rate, no denominator and nothing a reviewer could weigh. Every commercial
 * scanner (Macie, Cloud DLP) reports a count over a sample for that reason, and
 * now so does this one: `sampled`, `matched`, `byKind` and `rate` say what was
 * actually looked at.
 *
 * The count costs NO extra guard calls. The guard is a CPU-only sidecar and a
 * call per cell would be fifty calls per column; the cells are still sent as
 * ONE request per column, and each entity is attributed back to the cell it
 * came from by the offset the guard already returns (falling back to the
 * matched text). A guard that reports neither says `matched: null` — unknown,
 * never zero.
 *
 * Finally the two detectors stop ignoring each other: a column NAMED like the
 * kind its values hold is `confirmed`, and a kind found in a column named
 * nothing like it is weighed by how much of the column holds it — `likely` when
 * it is most of the column, `incidental` when it is a stray value in free text.
 * That grading rides along in the facts; it never silently adds or drops a
 * column, because inclusion is still the values' call.
 */

'use strict';

const { normalizeCategory } = require('./piiCategories');

/** Rows sampled per column — enough to be representative, small enough to be quick. */
const SAMPLE_ROWS = 50;
/** Per column, the characters handed to the guard in one request. */
const SAMPLE_CHARS = 2000;
/**
 * Per CELL, the characters that count toward that budget.
 *
 * Without it one 2000-character note eats the whole column budget, the
 * denominator of the rate is 1, and "100% of this column is personal data" is
 * said about a single cell. A truncated tail can hide a value, so this is a
 * trade — but a sample of one is not a sample.
 */
const MAX_CELL_CHARS = 400;
/**
 * Above this share of matched cells the column reads as "this is what the
 * column is for", below it as a stray value in free text. One in five is the
 * line; it only grades a finding, it never removes one.
 */
const MATCH_RATE_FLOOR = 0.2;
/** Column types whose values can be handed to the guard at all. */
const SCANNABLE_TYPES = Object.freeze(['text', 'richtext']);

/** Our own words for a kind of personal data, in the order a reviewer reads them. */
const KINDS = Object.freeze(['name', 'email', 'phone', 'address', 'id_number', 'financial', 'birth', 'health', 'online_id', 'supplier']);

/** How sure we are, and WHY — each value is one distinct situation, not a score. */
const CONFIDENCE = Object.freeze({
    /** The column's name says the same kind its values hold. */
    confirmed: 'confirmed',
    /** The values say so for a meaningful share of the column; the name does not. */
    likely: 'likely',
    /** A few cells in a column named nothing like it — a stray value in free text. */
    incidental: 'incidental',
    /** The guard flagged the column but could not say where, so there is no rate. */
    unweighed: 'unweighed',
    /** Nothing read the values here: no guard, or a column the guard cannot read. */
    name_only: 'name_only',
});

/** Column names that are personal data in any language we ship. */
const PERSONAL_PATTERNS = Object.freeze([
    { code: 'name', re: /\b(name|naam|voornaam|achternaam|surname|fullname|contact)\b/i },
    { code: 'email', re: /\b(e?mail|e-?mailadres)\b/i },
    { code: 'phone', re: /\b(phone|tel|telefoon|mobile|mobiel|gsm)\b/i },
    { code: 'address', re: /\b(address|adres|street|straat|postcode|zip|city|woonplaats)\b/i },
    { code: 'id_number', re: /\b(bsn|ssn|passport|paspoort|id_?number|identiteits)\b/i },
    { code: 'financial', re: /\b(iban|bank|rekening|account_?number|creditcard)\b/i },
    { code: 'birth', re: /\b(birth|geboorte|dob|age|leeftijd)\b/i },
    { code: 'health', re: /\b(health|gezondheid|medical|medisch|diagnos)\b/i },
    { code: 'supplier', re: /\b(supplier|leverancier|vendor|klant|customer|client)\b/i },
]);

/**
 * A canonical guard category (piiCategories.CANONICAL_IDS) → our kind.
 *
 * Every id in that list is either here or in NOT_PERSONAL_CATEGORIES below, and
 * the test asserts it: an id added to the guard that nobody maps would
 * otherwise be silently dropped, which is exactly how a column of telephone
 * numbers came to read as clean.
 */
const KIND_OF_CATEGORY = Object.freeze({
    Person: 'name',
    Email: 'email',
    PhoneNumber: 'phone',
    Address: 'address',
    DateOfBirth: 'birth',
    CreditCardNumber: 'financial',
    BankAccountNumber: 'financial',
    InternationalBankingAccountNumber: 'financial',
    USSocialSecurityNumber: 'id_number',
    PassportNumber: 'id_number',
    DriversLicenseNumber: 'id_number',
    NationalIdentificationNumber: 'id_number',
    TaxIdentificationNumber: 'id_number',
    LicensePlateNumber: 'id_number',
    HealthInsuranceNumber: 'health',
    MedicalCondition: 'health',
    Medication: 'health',
    IPAddress: 'online_id',
});

/**
 * Canonical categories that are NOT personal data on their own — listed, not
 * forgotten. `Organization` is the load-bearing one: it is why a "supplier"
 * column full of company names must not be reported as personal data, which is
 * the example this whole module was built around. A URL or an API key is a
 * secret worth finding, but it is not a person.
 */
const NOT_PERSONAL_CATEGORIES = Object.freeze(['Organization', 'URL', 'ApiKeyOrSecret']);

/**
 * The older, looser spellings producers have written over the years, keyed on
 * the category squashed to bare letters and digits so 'phone_number',
 * 'PhoneNumber' and 'phone number' are one key. `normalizeCategory` catches
 * most of them first; these are the ones it does not know.
 */
const LOOSE_KIND = Object.freeze({
    personname: 'name', fullname: 'name',
    emailaddress: 'email',
    streetaddress: 'address', location: 'address', postcode: 'address',
    idnumber: 'id_number', nationalid: 'id_number',
    bankaccount: 'financial', creditcard: 'financial', financial: 'financial',
    dateofbirth: 'birth', dob: 'birth', age: 'birth',
    health: 'health', medical: 'health', medicalcondition: 'health',
    ipaddress: 'online_id', ip: 'online_id', macaddress: 'online_id',
});

const arr = (v) => (Array.isArray(v) ? v : []);
const squash = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The same two tables keyed on bare letters and digits, so 'PhoneNumber',
 * 'phone_number' and 'phone number' are one key. This is the layer that was
 * missing: the old map squashed the category and then looked it up in a table
 * written in snake_case, which no canonical id is.
 */
const SQUASHED = Object.freeze({
    ...Object.fromEntries(NOT_PERSONAL_CATEGORIES.map((id) => [squash(id), null])),
    ...Object.fromEntries(Object.entries(KIND_OF_CATEGORY).map(([id, kind]) => [squash(id), kind])),
    ...LOOSE_KIND,
});

/** One guard category, in any spelling any producer has used → our kind, or null. */
function kindOfCategory(category) {
    const canonical = normalizeCategory(category);
    if (canonical && KIND_OF_CATEGORY[canonical]) return KIND_OF_CATEGORY[canonical];
    if (canonical && NOT_PERSONAL_CATEGORIES.includes(canonical)) return null;
    return SQUASHED[squash(canonical || category)] || null;
}

/** Kinds in the order a reviewer reads them, `first` (the anchored kind) in front. */
function orderKinds(kinds, first = null) {
    const rest = [...new Set(kinds)].filter((k) => k !== first).sort((a, b) => KINDS.indexOf(a) - KINDS.indexOf(b));
    return first && kinds.includes(first) ? [first, ...rest] : rest;
}

/** The guard's categories for a set of entities, as our kinds. */
function kindsFromCategories(entities) {
    const out = [];
    for (const e of arr(entities)) {
        const kind = kindOfCategory(e && e.category);
        if (kind) out.push(kind);
    }
    return orderKinds(out);
}

/** What this column's NAME claims it holds, or null. */
function kindFromName(field) {
    const hay = `${(field && field.key) || ''} ${(field && field.name) || ''}`;
    const hit = PERSONAL_PATTERNS.find((p) => p.re.test(hay));
    return hit ? hit.code : null;
}

/**
 * Which value-kinds a column NAME vouches for.
 *
 * Mostly itself. `supplier` is the exception and deliberately so: a column
 * called "klant" or "customer" is exactly where person names live, so it
 * anchors 'name' too — while a company name in it still is not personal data,
 * because the guard reports that as `Organization` and nothing maps it.
 */
function anchorsFor(nameKind) {
    if (!nameKind) return [];
    return nameKind === 'supplier' ? ['supplier', 'name'] : [nameKind];
}

/** A column detected from its name alone — no values were read. */
function nameEntry(field) {
    const kind = kindFromName(field);
    if (!kind) return null;
    return {
        key: field.key,
        name: field.name || field.key,
        kind,
        kinds: [kind],
        by: 'names',
        nameKind: kind,
        sampled: 0,
        matched: null,
        byKind: null,
        rate: null,
        confidence: CONFIDENCE.name_only,
    };
}

/** Which columns read as personal data from their NAMES alone. */
function byName(fields) {
    const out = [];
    for (const f of arr(fields)) {
        if (!f) continue;
        const entry = nameEntry(f);
        if (entry) out.push(entry);
    }
    return out;
}

/**
 * The cells of one column that fit in a single guard request, and where each
 * of them sits in the blob that is sent. The offsets are what lets one request
 * answer "how many CELLS", instead of "was there one anywhere".
 */
function sampleCells(rows, key, { sampleRows = SAMPLE_ROWS, sampleChars = SAMPLE_CHARS, maxCellChars = MAX_CELL_CHARS } = {}) {
    const cells = [];
    let blob = '';
    for (const r of arr(rows).slice(0, sampleRows)) {
        const raw = r && typeof r[key] === 'string' ? r[key].trim() : '';
        // An empty cell is not a cell that was looked at, so it stays out of
        // the denominator: a column that is 90% empty would otherwise read as
        // 10% personal data when every filled cell holds an e-mail address.
        if (!raw) continue;
        const value = raw.slice(0, maxCellChars);
        const sep = blob ? '\n' : '';
        if (blob.length + sep.length + value.length > sampleChars) break;
        const start = blob.length + sep.length;
        blob += sep + value;
        cells.push({ value, start, end: start + value.length });
    }
    return { blob, cells };
}

/**
 * WHICH cell this entity came out of.
 *
 * → an array of cell indexes, or `null` when the guard told us neither where
 * it was nor what it matched. `null` is not "nowhere": it is the difference
 * between a count and a guess.
 */
function placeEntity(cells, entity) {
    const offset = Number(entity && entity.offset);
    if (Number.isFinite(offset)) {
        const i = cells.findIndex((c) => offset >= c.start && offset < c.end);
        return i >= 0 ? [i] : [];
    }
    const matched = typeof (entity && entity.text) === 'string' ? entity.text.trim() : '';
    if (!matched) return null;
    const hits = [];
    cells.forEach((c, i) => { if (c.value.includes(matched)) hits.push(i); });
    return hits;
}

/** The guard's answer for one column, turned into a count over the cells it read. */
function weighColumn(cells, entities, nameKind) {
    const perKind = new Map();
    const seen = new Set();
    const all = new Set();
    let unplaced = 0;
    for (const e of arr(entities)) {
        const kind = kindOfCategory(e && e.category);
        if (!kind) continue;
        seen.add(kind);
        const at = placeEntity(cells, e);
        if (at === null) { unplaced += 1; continue; }
        if (!perKind.has(kind)) perKind.set(kind, new Set());
        for (const i of at) { perKind.get(kind).add(i); all.add(i); }
    }
    const anchors = anchorsFor(nameKind);
    const anchored = [...seen].find((k) => anchors.includes(k)) || null;
    const kinds = orderKinds([...seen], anchored);
    // Nothing could be placed, but the guard did flag something: say so as
    // "unknown". A zero here would read as "the guard found nothing".
    const blind = all.size === 0 && unplaced > 0;
    const matched = blind ? null : all.size;
    const sampled = cells.length;
    return {
        kinds,
        sampled,
        matched,
        // A kind that is in `kinds` but missing here was seen and could not be
        // placed — never read a missing key as zero cells.
        byKind: blind ? null : Object.fromEntries([...perKind].map(([k, s]) => [k, s.size])),
        rate: matched === null || !sampled ? null : Math.round((matched / sampled) * 100) / 100,
        confidence: confidenceOf({ anchored, matched, sampled }),
    };
}

function confidenceOf({ anchored, matched, sampled }) {
    // The name and the values agree — the strongest thing two detectors that
    // work differently can say, whatever the rate: a column called "email"
    // with three filled cells is still an e-mail column.
    if (anchored) return CONFIDENCE.confirmed;
    if (matched === null || !sampled) return CONFIDENCE.unweighed;
    return matched / sampled >= MATCH_RATE_FLOOR ? CONFIDENCE.likely : CONFIDENCE.incidental;
}

/**
 * Which columns hold personal data, judged by their VALUES.
 *
 * `scan(text)` is the guard call, injected — this module never reaches for
 * `piiDetection` itself, so a caller can hand it a stub, a different priority
 * or a budget without this file knowing about any of them.
 *
 * → `null` when the guard cannot answer at all (not installed, unreachable, no
 * rows, nothing scannable). Null means "ask the names instead", and is
 * deliberately different from `{ columns: [] }`, which means the guard looked
 * and found nothing.
 * → `{ columns, scanned }` otherwise, where `scanned` is every column the
 * guard really read — the list that lets the caller tell "clean" from
 * "never looked at" per column instead of per table.
 */
async function byValue({ fields = [], rows = [] } = {}, { scan = null, sampleRows = SAMPLE_ROWS, sampleChars = SAMPLE_CHARS, maxCellChars = MAX_CELL_CHARS } = {}) {
    const textFields = arr(fields).filter((f) => f && f.key && SCANNABLE_TYPES.includes(f.type));
    if (!textFields.length || !arr(rows).length || typeof scan !== 'function') return null;
    const columns = [];
    const scanned = [];
    for (const f of textFields) {
        const { blob, cells } = sampleCells(rows, f.key, { sampleRows, sampleChars, maxCellChars });
        if (!blob.trim()) continue;
        let result = null;
        try { result = await scan(blob); } catch { result = null; }
        // null = no guard; degraded = installed but could not scan. Neither is
        // an answer, and neither may read as "no personal data here".
        if (!result || result.degraded) continue;
        scanned.push(f.key);
        const weighed = weighColumn(cells, result.entities, kindFromName(f));
        if (!weighed.kinds.length) continue;
        columns.push({
            key: f.key,
            name: f.name || f.key,
            kind: weighed.kinds[0],
            by: 'values',
            nameKind: kindFromName(f),
            ...weighed,
        });
    }
    return scanned.length ? { columns, scanned } : null;
}

/** An entry from any era (or any stub) in the shape every consumer expects. */
function normaliseEntry(c) {
    const kinds = arr(c && c.kinds).filter(Boolean);
    const kind = (c && c.kind) || kinds[0] || 'personal';
    return {
        key: c && c.key,
        name: (c && c.name) || (c && c.key),
        kind,
        kinds: kinds.length ? kinds : [kind],
        by: (c && c.by) || 'values',
        nameKind: c && 'nameKind' in c ? c.nameKind : null,
        sampled: c && Number.isFinite(c.sampled) ? c.sampled : null,
        matched: c && Number.isFinite(c.matched) ? c.matched : null,
        byKind: (c && c.byKind) || null,
        rate: c && Number.isFinite(c.rate) ? c.rate : null,
        confidence: (c && c.confidence) || CONFIDENCE.unweighed,
    };
}

/**
 * The two answers as one list, and which of them spoke for the table.
 *
 * Values win for every column the guard read; the names answer for the columns
 * it could not — a date, a number, an empty column — so those stop vanishing
 * from the review the moment one text column is scanned.
 *
 * `scanned` is what makes that possible, and an enrichment that does not carry
 * it (an older artifact, a caller that only has the hits) gets the old
 * behaviour: the values answered for everything. Assuming the opposite would
 * resurrect exactly the columns the value scan was built to clear.
 */
function mergeDetections({ fields = [], byValue: values = null, scanned = null } = {}) {
    if (!Array.isArray(values)) return { method: 'names', columns: byName(fields) };
    const columns = values.map(normaliseEntry);
    const known = Array.isArray(scanned) ? new Set(scanned) : null;
    if (known) {
        const already = new Set(columns.map((c) => c.key));
        for (const f of arr(fields)) {
            if (!f || !f.key || known.has(f.key) || already.has(f.key)) continue;
            const entry = nameEntry(f);
            if (entry) columns.push(entry);
        }
    }
    return { method: 'values', columns };
}

module.exports = {
    byName, byValue, mergeDetections, normaliseEntry,
    kindFromName, kindOfCategory, kindsFromCategories, anchorsFor, orderKinds,
    sampleCells, weighColumn, placeEntity,
    PERSONAL_PATTERNS, KIND_OF_CATEGORY, NOT_PERSONAL_CATEGORIES, LOOSE_KIND, SQUASHED,
    KINDS, CONFIDENCE, SCANNABLE_TYPES,
    SAMPLE_ROWS, SAMPLE_CHARS, MAX_CELL_CHARS, MATCH_RATE_FLOOR,
};
