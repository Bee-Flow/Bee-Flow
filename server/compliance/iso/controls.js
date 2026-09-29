/**
 * ISO/IEC 27001:2022 Annex A — control catalog (93 controls).
 *
 * Control references (A.5.1 … A.8.34) and short control titles are factual
 * identifiers from the standard. ALL descriptive prose (objective texts,
 * inherited-justification templates, labels) is original Bee Flow wording —
 * nothing is reproduced from the ISO normative text, which stays behind
 * the `copyright: 'https://www.iso.org/standard/27001'` pointer convention:
 * anywhere the product needs to reference the standard itself, link to
 * iso.org instead of quoting it.
 *
 * The `bucket` field drives the SoA seed and the two-number score:
 *   - 'auto'      — continuously verifiable from Bee Flow's own DB/config
 *   - 'connector' — verifiable once an external system (GitHub, MDM, IdP,
 *                   cloud API, …) is coupled
 *   - 'attest'    — policy / attestation + document or URL reference
 *   - 'physical'  — physical control, typically inherited from the IaaS
 *                   provider for SaaS orgs (pre-filled SoA exclusion or
 *                   inheritance template via `inheritedJustificationKey`)
 *
 * The honest "continuously verified" score counts only 'auto' (plus
 * 'connector' where a connector is live); 'attest' and 'physical' rows feed
 * SoA completeness, never the automated-health number.
 */

const THEMES = { 5: 'organizational', 6: 'people', 7: 'physical', 8: 'technological' };

function c(ref, key, theme, bucket) {
    const entry = {
        ref,
        key,
        theme,
        bucket,
        titleKey: `compliance.iso.${key}.title`,
        objectiveKey: `compliance.iso.${key}.objective`,
    };
    if (bucket === 'physical') {
        entry.inheritedJustificationKey = `compliance.iso.${key}.inherited`;
    }
    return entry;
}

const CONTROLS = [
    // ── Theme 5 — Organizational (37) ───────────────────────────────
    c('A.5.1', 'a5_1', 5, 'attest'),
    c('A.5.2', 'a5_2', 5, 'auto'),
    c('A.5.3', 'a5_3', 5, 'auto'),
    c('A.5.4', 'a5_4', 5, 'attest'),
    c('A.5.5', 'a5_5', 5, 'attest'),
    c('A.5.6', 'a5_6', 5, 'attest'),
    c('A.5.7', 'a5_7', 5, 'connector'),
    c('A.5.8', 'a5_8', 5, 'attest'),
    c('A.5.9', 'a5_9', 5, 'auto'),
    c('A.5.10', 'a5_10', 5, 'auto'),
    c('A.5.11', 'a5_11', 5, 'attest'),
    c('A.5.12', 'a5_12', 5, 'attest'),
    c('A.5.13', 'a5_13', 5, 'attest'),
    c('A.5.14', 'a5_14', 5, 'auto'),
    c('A.5.15', 'a5_15', 5, 'auto'),
    c('A.5.16', 'a5_16', 5, 'auto'),
    c('A.5.17', 'a5_17', 5, 'auto'),
    c('A.5.18', 'a5_18', 5, 'auto'),
    c('A.5.19', 'a5_19', 5, 'attest'),
    c('A.5.20', 'a5_20', 5, 'auto'),
    c('A.5.21', 'a5_21', 5, 'auto'),
    c('A.5.22', 'a5_22', 5, 'auto'),
    c('A.5.23', 'a5_23', 5, 'auto'),
    c('A.5.24', 'a5_24', 5, 'auto'),
    c('A.5.25', 'a5_25', 5, 'auto'),
    c('A.5.26', 'a5_26', 5, 'auto'),
    c('A.5.27', 'a5_27', 5, 'auto'),
    c('A.5.28', 'a5_28', 5, 'auto'),
    c('A.5.29', 'a5_29', 5, 'attest'),
    c('A.5.30', 'a5_30', 5, 'attest'),
    c('A.5.31', 'a5_31', 5, 'attest'),
    c('A.5.32', 'a5_32', 5, 'auto'),
    c('A.5.33', 'a5_33', 5, 'auto'),
    c('A.5.34', 'a5_34', 5, 'auto'),
    c('A.5.35', 'a5_35', 5, 'attest'),
    c('A.5.36', 'a5_36', 5, 'auto'),
    c('A.5.37', 'a5_37', 5, 'attest'),

    // ── Theme 6 — People (8) ────────────────────────────────────────
    c('A.6.1', 'a6_1', 6, 'attest'),
    c('A.6.2', 'a6_2', 6, 'attest'),
    c('A.6.3', 'a6_3', 6, 'attest'),
    c('A.6.4', 'a6_4', 6, 'attest'),
    c('A.6.5', 'a6_5', 6, 'auto'),
    c('A.6.6', 'a6_6', 6, 'attest'),
    c('A.6.7', 'a6_7', 6, 'attest'),
    c('A.6.8', 'a6_8', 6, 'auto'),

    // ── Theme 7 — Physical (14) ─────────────────────────────────────
    c('A.7.1', 'a7_1', 7, 'physical'),
    c('A.7.2', 'a7_2', 7, 'physical'),
    c('A.7.3', 'a7_3', 7, 'physical'),
    c('A.7.4', 'a7_4', 7, 'physical'),
    c('A.7.5', 'a7_5', 7, 'physical'),
    c('A.7.6', 'a7_6', 7, 'physical'),
    c('A.7.7', 'a7_7', 7, 'attest'),
    c('A.7.8', 'a7_8', 7, 'physical'),
    c('A.7.9', 'a7_9', 7, 'connector'),
    c('A.7.10', 'a7_10', 7, 'connector'),
    c('A.7.11', 'a7_11', 7, 'physical'),
    c('A.7.12', 'a7_12', 7, 'physical'),
    c('A.7.13', 'a7_13', 7, 'physical'),
    c('A.7.14', 'a7_14', 7, 'attest'),

    // ── Theme 8 — Technological (34) ────────────────────────────────
    c('A.8.1', 'a8_1', 8, 'connector'),
    c('A.8.2', 'a8_2', 8, 'auto'),
    c('A.8.3', 'a8_3', 8, 'auto'),
    c('A.8.4', 'a8_4', 8, 'connector'),
    c('A.8.5', 'a8_5', 8, 'auto'),
    c('A.8.6', 'a8_6', 8, 'auto'),
    c('A.8.7', 'a8_7', 8, 'connector'),
    c('A.8.8', 'a8_8', 8, 'connector'),
    c('A.8.9', 'a8_9', 8, 'auto'),
    c('A.8.10', 'a8_10', 8, 'auto'),
    c('A.8.11', 'a8_11', 8, 'auto'),
    c('A.8.12', 'a8_12', 8, 'auto'),
    c('A.8.13', 'a8_13', 8, 'connector'),
    c('A.8.14', 'a8_14', 8, 'connector'),
    c('A.8.15', 'a8_15', 8, 'auto'),
    c('A.8.16', 'a8_16', 8, 'auto'),
    c('A.8.17', 'a8_17', 8, 'auto'),
    c('A.8.18', 'a8_18', 8, 'attest'),
    c('A.8.19', 'a8_19', 8, 'auto'),
    c('A.8.20', 'a8_20', 8, 'auto'),
    c('A.8.21', 'a8_21', 8, 'auto'),
    c('A.8.22', 'a8_22', 8, 'connector'),
    c('A.8.23', 'a8_23', 8, 'auto'),
    c('A.8.24', 'a8_24', 8, 'auto'),
    c('A.8.25', 'a8_25', 8, 'attest'),
    c('A.8.26', 'a8_26', 8, 'attest'),
    c('A.8.27', 'a8_27', 8, 'attest'),
    c('A.8.28', 'a8_28', 8, 'connector'),
    c('A.8.29', 'a8_29', 8, 'connector'),
    c('A.8.30', 'a8_30', 8, 'attest'),
    c('A.8.31', 'a8_31', 8, 'connector'),
    c('A.8.32', 'a8_32', 8, 'connector'),
    c('A.8.33', 'a8_33', 8, 'auto'),
    c('A.8.34', 'a8_34', 8, 'attest'),
];

function byRef(ref) {
    return CONTROLS.find((ctrl) => ctrl.ref === ref) || null;
}

function byTheme(theme) {
    return CONTROLS.filter((ctrl) => ctrl.theme === Number(theme));
}

module.exports = {
    THEMES,
    CONTROLS,
    byRef,
    byTheme,
    COPYRIGHT_NOTE: 'Control references and titles are factual identifiers from ISO/IEC 27001:2022 Annex A (https://www.iso.org). All descriptive text is original to Bee Flow.',
};
