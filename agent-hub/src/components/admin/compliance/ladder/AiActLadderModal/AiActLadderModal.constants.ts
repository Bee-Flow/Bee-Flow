/**
 * Art. 5 — all EIGHT prohibited practices, in the server's vocabulary
 * (ladderOutcome.ART5_PRACTICES). Three of them were on screen before, under
 * ids the server did not use, and denying those three recorded "not a
 * prohibited practice" for a system nobody had asked about subliminal
 * manipulation, exploiting vulnerabilities, criminal risk profiling, facial
 * scraping or real-time biometric identification.
 */
export const ART5_CHIPS = Object.freeze([
    { id: 'subliminal_manipulation', key: 'compliance.ladder_art5_chip_subliminal', en: 'no subliminal manipulation' },
    { id: 'exploiting_vulnerabilities', key: 'compliance.ladder_art5_chip_vulnerabilities', en: 'no exploiting vulnerabilities' },
    { id: 'social_scoring', key: 'compliance.ladder_art5_chip_social', en: 'no social scoring' },
    { id: 'criminal_risk_profiling', key: 'compliance.ladder_art5_chip_criminal', en: 'no criminal risk profiling' },
    { id: 'facial_scraping', key: 'compliance.ladder_art5_chip_scraping', en: 'no untargeted facial scraping' },
    { id: 'emotion_recognition_work_education', key: 'compliance.ladder_art5_chip_emotion', en: 'no emotion recognition at work or school' },
    { id: 'biometric_categorisation', key: 'compliance.ladder_art5_chip_biometric', en: 'no biometric categorisation' },
    { id: 'realtime_biometric_id', key: 'compliance.ladder_art5_chip_realtime_id', en: 'no real-time biometric identification' },
]);

/**
 * Annex III — one QUESTION per domain, all ten, each naming the point of the
 * annex that settles it.
 *
 * It was four negation chips that had to be ticked together to mean "no". Two
 * things were wrong with that and both mattered:
 *
 *   - six domains were never on screen, so the declaration it recorded was
 *     about things nobody had been asked;
 *   - there was no way to answer YES. A genuinely high-risk system could not
 *     be recorded as one through the ladder at all.
 *
 * So each domain is its own question with its own Yes/No, `null` until
 * answered, and the answer cites `ANNEX_III_ARTICLES[id]` — the reader can
 * look the qualification up instead of taking ours.
 */
export const ANNEX_QUESTIONS = Object.freeze([
    { id: 'biometrics', key: 'compliance.ladder_annex_q_biometrics', en: 'Does it identify or categorise people by biometrics?' },
    { id: 'critical_infrastructure', key: 'compliance.ladder_annex_q_critical_infrastructure', en: 'Does it help run critical infrastructure (water, power, traffic)?' },
    { id: 'education', key: 'compliance.ladder_annex_q_education', en: 'Does it decide on admission, assessment or monitoring in education?' },
    { id: 'employment', key: 'compliance.ladder_annex_q_employment', en: 'Does it select, assess or decide about people at work?' },
    { id: 'essential_services', key: 'compliance.ladder_annex_q_essential_services', en: 'Does it decide on access to essential public services or benefits?' },
    { id: 'credit', key: 'compliance.ladder_annex_q_credit', en: 'Does it judge creditworthiness or score credit?' },
    { id: 'insurance', key: 'compliance.ladder_annex_q_insurance', en: 'Does it price or assess risk for life or health insurance?' },
    { id: 'law_enforcement', key: 'compliance.ladder_annex_q_law_enforcement', en: 'Is it used by or for law enforcement?' },
    { id: 'migration', key: 'compliance.ladder_annex_q_migration', en: 'Is it used for migration, asylum or border control?' },
    { id: 'justice', key: 'compliance.ladder_annex_q_justice', en: 'Does it support judicial decisions or democratic processes?' },
]);
