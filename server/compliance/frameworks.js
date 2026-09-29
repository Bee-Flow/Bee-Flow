/**
 * Framework catalogue — the static list of regulatory frameworks the
 * Compliance Center knows about, with time as an axis.
 *
 * Two identifiers per framework (PLAN.md §1.1):
 *   - `id`         lowercase slug used in the API, the UI, the per-org settings
 *                  and the `scores` JSONB on score snapshots ('gdpr', 'nis2', …;
 *                  org-defined frameworks are 'custom:<uuid>').
 *   - `regulation` uppercase code carried by every check module and persisted
 *                  in compliance_checks.regulation ('GDPR', 'NIS2', … 'CUSTOM').
 *
 * Every framework carries the date it started to apply (`in_force_since`), or
 * — when that date is still ahead of the product as shipped — `in_force_from`,
 * plus the phases of a staggered rollout. The AI Act additionally overrides the
 * date per article (Art. 4/5 → 2025-02-02, Art. 50 → 2026-08-02, …) so a check
 * can say from when *its* article applies: `inForceSince('AIA', '50')`.
 *
 * `core` frameworks (GDPR, AI Act, ISO 27001) are always enabled for an org;
 * the others are opt-in behind a per-framework licence capability and are
 * never hidden when locked (frameworkPolicy.js resolves that per org).
 *
 * Nothing in here touches the database or the licence layer; the file is safe
 * to require from a route, a store or a test without stubs.
 *
 * Dates and labels are the state of 14 Sep 2026 (BRIEF.md §1.4). Not legal
 * advice — the UI says so next to the calendar.
 */

// Display strings for the copy that the i18n keys point at live in the
// dictionaries; only the regulation citation is literal here because it is a
// citation, not prose (the artboard renders it verbatim in every locale).
const FRAMEWORKS = Object.freeze([
    {
        id: 'gdpr',
        regulation: 'GDPR',
        core: true,
        capability: 'compliance_hub_gdpr',
        checks_dir: 'gdpr',
        regulation_code: 'Verordening (EU) 2016/679 · UAVG',
        in_force_since: '2018-05-25',
        in_force_from: null,
        phases: [
            { date: '2018-05-25', label_key: 'compliance.fw_gdpr_phase_in_force' },
        ],
        registers: ['dsr', 'incidents', 'ropa', 'dpia'],
        id_pattern: /^GDPR-Art[\w()-]+-[\w()-]+$/,
        relevance_gate: false,
    },
    {
        id: 'aia',
        regulation: 'AIA',
        core: true,
        capability: 'compliance_hub_aia',
        checks_dir: 'aia',
        regulation_code: 'Verordening (EU) 2024/1689',
        in_force_since: '2024-08-01',
        in_force_from: null,
        // Per-article application dates — the AI Act applies in stages, so a
        // check on Art. 50 must not claim to have been in force since 2024.
        // Keys are normalised refs (see _normaliseRef): article number with
        // optional paragraph, or 'annex_i' / 'annex_iii'.
        articles: {
            '4': '2025-02-02',
            '5': '2025-02-02',
            '53': '2025-08-02',
            '50': '2026-08-02',
            '50(2)': '2026-08-02',
            'annex_iii': '2027-12-02',
            'annex_i': '2028-08-02',
        },
        phases: [
            { date: '2025-02-02', label_key: 'compliance.fw_aia_phase_art4_art5' },
            { date: '2025-08-02', label_key: 'compliance.fw_aia_phase_gpai' },
            { date: '2026-08-02', label_key: 'compliance.fw_aia_phase_art50' },
            { date: '2026-12-02', label_key: 'compliance.fw_aia_phase_marking_transition_end' },
            { date: '2027-12-02', label_key: 'compliance.fw_aia_phase_annex_iii' },
            { date: '2028-08-02', label_key: 'compliance.fw_aia_phase_annex_i' },
        ],
        registers: [],
        id_pattern: /^AIA-Art[\w()-]+-[\w()-]+$/,
        relevance_gate: false,
    },
    {
        id: 'iso27001',
        regulation: 'ISO27001',
        core: true,
        capability: 'compliance_hub_iso27001',
        checks_dir: 'iso27001',
        regulation_code: 'ISO/IEC 27001:2022',
        // A standard, not a law: nothing "enters into force".
        in_force_since: null,
        in_force_from: null,
        phases: [],
        registers: ['risks', 'soa', 'policies', 'audits', 'training', 'access_log', 'connectors'],
        id_pattern: /^ISO27001-(A\.\d+\.\d+|cl\d+(\.\d+)*)-[\w()-]+$/,
        relevance_gate: false,
    },
    {
        id: 'nis2',
        regulation: 'NIS2',
        core: false,
        capability: 'compliance_hub_nis2',
        checks_dir: 'nis2',
        regulation_code: 'Richtlijn (EU) 2022/2555 · Cyberbeveiligingswet',
        in_force_since: '2026-08-15',
        in_force_from: null,
        phases: [
            { date: '2026-08-15', label_key: 'compliance.fw_nis2_phase_in_force' },
        ],
        registers: ['incidents'],
        id_pattern: /^NIS2-(Art[\w().-]+|AnnexI-[\w.]+)-[\w()-]+$/,
        relevance_gate: false,
    },
    {
        id: 'cra',
        regulation: 'CRA',
        core: false,
        capability: 'compliance_hub_cra',
        checks_dir: 'cra',
        // Art. 14 reporting applies from 2026-09-11; every Annex I product
        // requirement and Art. 13 only from 2027-12-11 (see _normaliseRef for the
        // key shape: 'annexi-ii1' style refs reduce to lower-case, no spaces).
        articles: {
            '14': '2026-09-11',
            '13': '2027-12-11',
            '13(8)': '2027-12-11',
            'annex_ipartii(1)': '2027-12-11',
            'annex_ipartii(5)': '2027-12-11',
            'annex_i': '2027-12-11',
        },
        regulation_code: 'Verordening (EU) 2024/2847',
        // The reporting duty (Art. 14) applies first; the product requirements,
        // conformity assessment and CE marking follow in Dec 2027.
        in_force_since: '2026-09-11',
        in_force_from: null,
        phases: [
            { date: '2026-09-11', label_key: 'compliance.fw_cra_phase_reporting' },
            { date: '2027-12-11', label_key: 'compliance.fw_cra_phase_full' },
        ],
        registers: ['vulnerabilities'],
        id_pattern: /^CRA-(Art[\w().-]+|AnnexI-[\w.]+)-[\w()-]+$/,
        relevance_gate: false,
    },
    {
        id: 'data_act',
        regulation: 'DATA_ACT',
        core: false,
        capability: 'compliance_hub_data_act',
        checks_dir: 'data-act',
        regulation_code: 'Verordening (EU) 2023/2854',
        in_force_since: '2025-09-12',
        in_force_from: null,
        phases: [
            { date: '2025-09-12', label_key: 'compliance.fw_data_act_phase_in_force' },
            { date: '2027-01-12', label_key: 'compliance.fw_data_act_phase_switching_charges' },
        ],
        registers: ['portability'],
        id_pattern: /^DATA_ACT-Art[\w().-]+-[\w()-]+$/,
        relevance_gate: false,
    },
    {
        id: 'pld',
        regulation: 'PLD',
        core: false,
        capability: 'compliance_hub_pld',
        checks_dir: 'pld',
        regulation_code: 'Richtlijn (EU) 2024/2853',
        // Applies to products placed on the market from this date — earlier
        // releases stay under the old regime, which is why the release date
        // becomes legally meaningful (BRIEF §1.4).
        in_force_since: null,
        in_force_from: '2026-12-09',
        phases: [
            { date: '2026-12-09', label_key: 'compliance.fw_pld_phase_in_force' },
        ],
        registers: [],
        id_pattern: /^PLD-Art[\w().-]+-[\w()-]+$/,
        relevance_gate: false,
    },
    {
        id: 'eaa',
        regulation: 'EAA',
        core: false,
        capability: 'compliance_hub_eaa',
        checks_dir: 'eaa',
        regulation_code: 'Richtlijn (EU) 2019/882',
        in_force_since: '2025-06-28',
        in_force_from: null,
        phases: [
            { date: '2025-06-28', label_key: 'compliance.fw_eaa_phase_in_force' },
            { date: '2030-06-28', label_key: 'compliance.fw_eaa_phase_legacy_contracts_end' },
        ],
        registers: [],
        id_pattern: /^EAA-Art[\w().-]+-[\w()-]+$/,
        relevance_gate: false,
    },
    {
        id: 'dora',
        regulation: 'DORA',
        core: false,
        capability: 'compliance_hub_dora',
        checks_dir: 'dora',
        regulation_code: 'Verordening (EU) 2022/2554',
        in_force_since: '2025-01-17',
        in_force_from: null,
        phases: [
            { date: '2025-01-17', label_key: 'compliance.fw_dora_phase_in_force' },
        ],
        registers: ['incidents'],
        id_pattern: /^DORA-Art[\w().-]+-[\w()-]+$/,
        // Only applies when the org serves financial entities — the card asks
        // before it scores (framework_relevance in compliance_settings).
        relevance_gate: true,
    },
    {
        id: 'machinery',
        regulation: 'MACHINERY',
        core: false,
        capability: 'compliance_hub_machinery',
        checks_dir: 'machinery',
        regulation_code: 'Verordening (EU) 2023/1230',
        in_force_since: null,
        in_force_from: '2027-01-20',
        phases: [
            { date: '2027-01-20', label_key: 'compliance.fw_machinery_phase_in_force' },
        ],
        registers: [],
        id_pattern: /^MACHINERY-Art[\w().-]+-[\w()-]+$/,
        // Relevant only when an integration drives a PLC or machine; the
        // industrial-integration detector derives it, an admin can override.
        relevance_gate: true,
    },
].map(f => Object.freeze({
    ...f,
    name_key: `compliance.fw_${f.id}_name`,
    description_key: `compliance.fw_${f.id}_desc`,
    affects_key: `compliance.fw_${f.id}_affects`,
    articles: Object.freeze(f.articles || {}),
    phases: Object.freeze(f.phases.map(p => Object.freeze(p))),
    registers: Object.freeze(f.registers),
})));

// Regulation code for org-defined frameworks (rows in compliance_custom_*,
// evaluated by attestation — see compliance/custom/runner.js). It has no
// catalogue entry: there is one per org, not one per product.
const CUSTOM_REGULATION = 'CUSTOM';
const CUSTOM_ID_PREFIX = 'custom:';

const CORE_IDS = Object.freeze(FRAMEWORKS.filter(f => f.core).map(f => f.id));

/**
 * The regulatory calendar: every dated milestone across the catalogue, plus
 * the two things still uncertain on 14 Sep 2026 (kind 'uncertain', date null,
 * `expected` names the quarter). `affects_kind` says which org objects a
 * milestone touches so the calendar route can count them:
 *   'marking'  → automations/agents that generate content (Art. 50(2))
 *   'a11y'     → published webpages and public forms
 *   'releases' → the platform's own release record (CRA / PLD)
 */
const MILESTONES = Object.freeze([
    { id: 'dora_in_force', date: '2025-01-17', framework_id: 'dora', kind: 'in_force', affects_kind: null },
    { id: 'aia_art4_art5', date: '2025-02-02', framework_id: 'aia', kind: 'phase', affects_kind: null },
    { id: 'eaa_in_force', date: '2025-06-28', framework_id: 'eaa', kind: 'in_force', affects_kind: 'a11y' },
    { id: 'aia_gpai', date: '2025-08-02', framework_id: 'aia', kind: 'phase', affects_kind: null },
    { id: 'data_act_in_force', date: '2025-09-12', framework_id: 'data_act', kind: 'in_force', affects_kind: null },
    { id: 'aia_art50_enforcement', date: '2026-08-02', framework_id: 'aia', kind: 'phase', affects_kind: 'marking' },
    { id: 'nis2_in_force', date: '2026-08-15', framework_id: 'nis2', kind: 'in_force', affects_kind: null },
    { id: 'cra_reporting_duty', date: '2026-09-11', framework_id: 'cra', kind: 'in_force', affects_kind: 'releases' },
    // End of the transition for marking AI-generated content from systems
    // that predate Art. 50 — and the new ban on AI-generated NCII/CSAM.
    { id: 'aia_marking_transition_end', date: '2026-12-02', framework_id: 'aia', kind: 'transition_end', affects_kind: 'marking' },
    { id: 'pld_in_force', date: '2026-12-09', framework_id: 'pld', kind: 'in_force', affects_kind: 'releases' },
    { id: 'data_act_switching_charges', date: '2027-01-12', framework_id: 'data_act', kind: 'phase', affects_kind: null },
    { id: 'machinery_in_force', date: '2027-01-20', framework_id: 'machinery', kind: 'in_force', affects_kind: null },
    { id: 'aia_annex_iii', date: '2027-12-02', framework_id: 'aia', kind: 'phase', affects_kind: null },
    { id: 'cra_full', date: '2027-12-11', framework_id: 'cra', kind: 'phase', affects_kind: 'releases' },
    { id: 'aia_annex_i', date: '2028-08-02', framework_id: 'aia', kind: 'phase', affects_kind: null },
    { id: 'eaa_legacy_contracts_end', date: '2030-06-28', framework_id: 'eaa', kind: 'transition_end', affects_kind: 'a11y' },
    // Not dated: the data/privacy/NIS2 part of the Digital Omnibus, and the
    // Dutch AI Act implementation act (consultation closed 1 Jun 2026, bill
    // not yet before parliament). Listed so the calendar can say "still
    // uncertain" instead of staying silent.
    { id: 'omnibus_data_part', date: null, framework_id: 'gdpr', kind: 'uncertain', expected: '2026-Q4', affects_kind: null },
    { id: 'nl_uitvoeringswet_ai', date: null, framework_id: 'aia', kind: 'uncertain', expected: '2026-Q4', affects_kind: null },
].map(m => Object.freeze({
    ...m,
    expected: m.expected || null,
    label_key: `compliance.cal_ms_${m.id}_label`,
    detail_key: `compliance.cal_ms_${m.id}_detail`,
})));

const _byId = new Map(FRAMEWORKS.map(f => [f.id, f]));
const _byRegulation = new Map(FRAMEWORKS.map(f => [f.regulation, f]));

function listBuiltin() { return FRAMEWORKS.slice(); }
function byId(id) { return _byId.get(id) || null; }
function byRegulation(code) { return _byRegulation.get(code) || null; }

/** Every regulation code a check may carry — GDPR, AIA, ISO27001 first, then the rest, then CUSTOM. */
function regulationCodes() {
    return FRAMEWORKS.map(f => f.regulation).concat(CUSTOM_REGULATION);
}

function frameworkIdOf(regulation) {
    if (regulation === CUSTOM_REGULATION) return null; // one per org — resolve from the row's framework_code
    return _byRegulation.get(regulation)?.id || null;
}
function regulationOf(frameworkId) {
    if (isCustomId(frameworkId)) return CUSTOM_REGULATION;
    return _byId.get(frameworkId)?.regulation || null;
}
function capabilityOf(id) {
    if (isCustomId(id)) return 'compliance_hub_custom';
    return _byId.get(id)?.capability || null;
}
function isCustomId(id) {
    return typeof id === 'string' && id.startsWith(CUSTOM_ID_PREFIX);
}

/**
 * Article/control refs arrive in several spellings — '50', '50(2)', 'Art. 50',
 * 'Art 50(2)', 'Annex III'. Reduce them to the key shape the `articles` map
 * uses so a per-article date is found regardless of how a check wrote it.
 */
function _normaliseRef(ref) {
    if (ref == null) return '';
    let s = String(ref).trim().toLowerCase();
    s = s.replace(/^art(?:icle|\.)?\s*/, '');
    s = s.replace(/^annex\s+/, 'annex_').replace(/^bijlage\s+/, 'annex_');
    return s.replace(/\s+/g, '');
}

/**
 * From when does `ref` of `regulation` apply? A per-article override wins
 * (exact ref, then the bare article number: '26(6)' → '26'); otherwise the
 * framework's own date (`in_force_since`, or `in_force_from` for a framework
 * that is still ahead). null for a standard (ISO 27001) or an unknown code.
 */
function inForceSince(regulation, ref) {
    const fw = _byRegulation.get(regulation);
    if (!fw) return null;
    const key = _normaliseRef(ref);
    if (key && fw.articles) {
        if (fw.articles[key]) return fw.articles[key];
        const bare = key.match(/^(\d+)/)?.[1];
        if (bare && fw.articles[bare]) return fw.articles[bare];
    }
    return fw.in_force_since || fw.in_force_from || null;
}

module.exports = {
    FRAMEWORKS,
    MILESTONES,
    CORE_IDS,
    CUSTOM_REGULATION,
    listBuiltin,
    byId,
    byRegulation,
    regulationCodes,
    frameworkIdOf,
    regulationOf,
    capabilityOf,
    isCustomId,
    inForceSince,
    _normaliseRef,
};
