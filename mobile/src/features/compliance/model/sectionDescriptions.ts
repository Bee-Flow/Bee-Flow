/**
 * The line under a section's row: the web rail's own description
 * (`compliance.nav_<id>_desc`; the ISO registers still carry their pre-
 * redesign `nav_iso_*` ids). A section the web gives no description has none.
 */

import type { Label } from './types';

export const SECTION_DESCRIPTIONS: Readonly<Record<string, Label>> = {
    gdpr: { i18nKey: 'compliance.nav_gdpr_desc', en: 'General Data Protection Regulation — one card per article.' },
    aia: { i18nKey: 'compliance.nav_aia_desc', en: 'EU Artificial Intelligence Act — transparency, risk and governance.' },
    iso: {
        i18nKey: 'compliance.nav_iso_overview_desc',
        en: 'Two honest numbers — continuously verified controls and Statement of Applicability progress — plus how long your ISMS has been operating.',
    },
    dsr: { i18nKey: 'compliance.nav_dsr_desc', en: 'Data-subject requests — answer within 30 days (Art. 12–22).' },
    incidents: { i18nKey: 'compliance.nav_incidents_desc', en: 'Breach registry with the 72-hour Art. 33 workflow.' },
    ropa: { i18nKey: 'compliance.nav_ropa_desc', en: 'Records of Processing Activities, generated from your live configuration (Art. 30).' },
    dpia: { i18nKey: 'compliance.nav_dpia_desc', en: 'Impact assessments for high-risk agents (Art. 35).' },
    risks: { i18nKey: 'compliance.nav_iso_risks_desc', en: 'Risk register with treatment plans and owner sign-off.' },
    soa: { i18nKey: 'compliance.nav_iso_soa_desc', en: 'Statement of Applicability — decide, justify and track all 93 Annex A controls.' },
    policies: { i18nKey: 'compliance.nav_iso_policies_desc', en: 'Your ISMS policy set — versioned, published and acknowledged by your people.' },
    audits: { i18nKey: 'compliance.nav_iso_audit_desc', en: 'Internal audits, management reviews and nonconformities with corrective actions.' },
    training: { i18nKey: 'compliance.nav_iso_training_desc', en: 'Security awareness and competence records per person.' },
    settings: { i18nKey: 'compliance.nav_settings_desc', en: 'DPO, legal bases, residency and breach recipients.' },
    connectors: {
        i18nKey: 'compliance.nav_iso_connectors_desc',
        en: 'Couple external systems — code hosting, cloud, identity, monitoring — for automatic evidence collection.',
    },
};
