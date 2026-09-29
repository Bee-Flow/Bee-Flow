/**
 * What is ACTUALLY true about what the playbook built — the half of the
 * compliance review that does IO.
 *
 * `compliancePhase.js` stayed self-referential on purpose: it reasons about
 * facts and is a pure function of them. This module is where those facts come
 * from, and every one of them replaces a guess the review used to make:
 *
 *   - personal data was decided from COLUMN NAMES. A column called "supplier"
 *     holding company names was reported as personal data; a column called
 *     "notes" holding e-mail addresses was not. Now the values themselves are
 *     scanned by the PII Guard (core/privacy/piiDetection) — the same local
 *     GLiNER sidecar the Privacy Shield uses. No guard installed → the name
 *     patterns again, and the review SAYS which method answered.
 *   - the AI Act finding was hand-rolled ("Art. 10", which is data governance
 *     for high-risk systems — not what a data_extraction step is). The product
 *     already has a detector: compliance/aiAct/signals.js reads a definition
 *     for AI steps, generated content, customer-facing forms and a disclosure.
 *   - "no retention is recorded" was asserted without looking. The datatable
 *     row carries `lawful_basis`, `retention_days`, `retention_field` and
 *     `subject_column`; the organisation carries default retention, legal
 *     bases and a DPO in compliance_settings.
 *
 * The personal-data detector itself is NOT here any more. It was one of three
 * copies of the same question — this one reading values, `compliancePhase`
 * reading names, `designPhase` borrowing the second to redact a sample — and
 * the three had drifted into three vocabularies. It now lives once in
 * `core/privacy/personalColumns.js` (core, because `playbooks/` and
 * `compliance/` are both features and neither may require the other), together
 * with the counting this module could not do: it joined every sampled value of
 * a column into one blob and asked the guard once, so a single stray e-mail
 * address in a notes column read exactly like a column of two hundred of them.
 * What stays here is the WIRING: which guard, which rows, which priority.
 *
 * Its sibling, `core/privacy/dataFlow.js`, answers the question that follows
 * from this one — where the personal data these columns hold then TRAVELS —
 * and it needs nothing from this module, which is why there is nothing about
 * it here. The routine's steps are already in hand by the time the review runs
 * (routes/playbooks/complianceReview.js projects them as `{ type, tool }`), so
 * the flow is a pure reading and `compliancePhase.gatherFacts` does it itself.
 * The half of that analysis that DOES take IO — reading the egress ledger for
 * what a routine has really sent — deliberately lives on the other caller, the
 * after-the-fact check in compliance/checks/gdpr/, because a routine a
 * playbook finished building two minutes ago has sent nothing yet. Putting the
 * same query here as well would be a second copy of it, which is the thing
 * these two modules were split apart to stop.
 *
 * Nothing here writes. Every read is wrapped: a fact we cannot get is absent,
 * never invented, and never a reason for the phase to fail.
 */

'use strict';

const detector = require('../../core/privacy/personalColumns');

/** Rows sampled for the value scan — enough to be representative, small enough to be quick. */
const SAMPLE_ROWS = detector.SAMPLE_ROWS;
/** Per column, the characters handed to the guard. */
const SAMPLE_CHARS = detector.SAMPLE_CHARS;
/**
 * Guard categories that are personal data for our purposes, mapped to our own
 * words. Moved to core/privacy/personalColumns.js and keyed on the CANONICAL
 * category ids from core/privacy/piiCategories.js — the private copy that used
 * to live here keyed on the id squashed to snake_case, so 'PhoneNumber' landed
 * on nothing and a column of telephone numbers came back clean.
 */
const CATEGORY_KIND = detector.KIND_OF_CATEGORY;

/**
 * The real collaborators, with room for the caller to add or replace one.
 *
 * The AI Act detector is deliberately NOT wired here. It lives in
 * compliance/aiAct/signals.js, and playbooks/ may not require compliance/ —
 * one feature never requires another (layering.test.js; ARCHITECTURE.md: for
 * playbooks/ the route does that glue). routes/playbooks.js passes it in.
 * Without it the AI Act facts are null — "not detected", never "no AI".
 */
function defaultDeps(overrides = {}) {
    return {
        detectPii: (...a) => require('../../core/privacy/piiDetection').detectPii(...a),
        getSettings: (...a) => require('../../stores/complianceStore').getSettings(...a),
        signalsFromDefinition: null,
        ...overrides,
    };
}

/** The guard's categories for one column's values, as our kinds. */
function kindsOf(entities) {
    return detector.kindsFromCategories(entities);
}

/** The guard call the value scan makes, with this product's priority on it. */
function scanWith(deps) {
    // 'bulk' keeps a table scan behind interactive chat traffic — a review is
    // never the thing a person is waiting on a token for.
    return (text) => deps.detectPii(text, null, undefined, { priority: 'bulk' });
}

/**
 * Which columns hold personal data, judged by their VALUES.
 *
 * → `null` when the guard cannot answer at all (not installed, unreachable, no
 * rows). Null means "ask the names instead", and is deliberately different
 * from `[]`, which means "the guard looked and found nothing".
 *
 * Each column it does return says how much of it was looked at: `sampled`
 * cells, `matched` cells, `byKind` and `rate`. See
 * core/privacy/personalColumns.js for why a count and not just a yes.
 */
async function personalColumnsByValue({ fields = [], rows = [] } = {}, deps = defaultDeps()) {
    const found = await detector.byValue({ fields, rows }, { scan: scanWith(deps) });
    return found ? found.columns : null;
}

/**
 * What the AI Act detector makes of each automation (compliance/aiAct/signals.js).
 *
 * Carries the `id` as well as the title: a playbook regularly builds two
 * automations both called "Untitled automation", and keying these signals by
 * title gave the second one the first one's answer.
 */
function aiActFacts(automations = [], deps = defaultDeps()) {
    const out = [];
    // No detector wired (see defaultDeps) reads the same as a detector that
    // cannot read the definition: null, a fact we do not have.
    const detect = typeof deps.signalsFromDefinition === 'function' ? deps.signalsFromDefinition : null;
    for (const a of (Array.isArray(automations) ? automations : [])) {
        const at = { id: (a && a.id) || null, title: a && a.title };
        if (!a || !a.definition || !detect) { out.push({ ...at, signals: null }); continue; }
        try {
            out.push({ ...at, signals: detect(a.definition, { title: a.title, description: a.description }) });
        } catch {
            out.push({ ...at, signals: null });
        }
    }
    return out;
}

/** The organisation's own compliance settings — legal bases, retention, a DPO. */
async function orgFacts(orgId, deps = defaultDeps()) {
    let settings = null;
    try { settings = await deps.getSettings(orgId); } catch { settings = null; }
    if (!settings) return null;
    const bases = Array.isArray(settings.legal_bases) ? settings.legal_bases
        : (Array.isArray(settings.legalBases) ? settings.legalBases : []);
    const retention = Number(settings.default_retention_days ?? settings.defaultRetentionDays);
    return {
        legalBases: bases,
        defaultRetentionDays: Number.isFinite(retention) && retention > 0 ? retention : null,
        hasDpo: !!(settings.dpo_name || settings.dpoName || settings.dpo_email || settings.dpoEmail),
        dataResidency: settings.data_residency || settings.dataResidency || null,
    };
}

/**
 * Everything the review could not know by itself, in one object.
 * `table.privacy` is the datatable row's own metadata as `datatableStore`
 * hands it back (camelCase).
 */
async function enrich({ table = null, rows = [], automations = [], orgId = null, privacy = null } = {}, deps = defaultDeps()) {
    const fields = (table && table.fields) || [];
    const [byValue, org] = await Promise.all([
        detector.byValue({ fields, rows }, { scan: scanWith(deps) }),
        orgFacts(orgId, deps),
    ]);
    return {
        personal: byValue ? byValue.columns : null,   // null → fall back to the names
        // WHICH columns the guard actually read. Without it the review cannot
        // tell "the guard looked at this column and it was clean" from "the
        // guard cannot read a date column", and a `dob` date column stopped
        // being personal data the moment any text column was scanned.
        scannedColumns: byValue ? byValue.scanned : null,
        personalMethod: byValue ? 'values' : 'names',
        privacy: privacy ? {
            lawfulBasis: privacy.lawfulBasis || null,
            retentionDays: Number.isFinite(Number(privacy.retentionDays)) ? Number(privacy.retentionDays) : null,
            retentionField: privacy.retentionField || null,
            subjectColumn: privacy.subjectColumn || null,
            rowScope: privacy.rowScope || null,
        } : null,
        aiAct: aiActFacts(automations, deps),
        org,
    };
}

module.exports = { enrich, defaultDeps, personalColumnsByValue, aiActFacts, orgFacts, kindsOf, SAMPLE_ROWS, SAMPLE_CHARS, CATEGORY_KIND };
