// The words of the AI Act check, shared by the automatic card
// (AiActAutoCard), the Activate dialog (AiActQuestionsDialog) and the full
// editor (AiActWizard): the questions, Bee's evidence lines, the outcomes.
// English fallbacks here; the catalogue keys are automations.aiact.*.

import type { useTranslation } from '../../../../hooks/useTranslation';
import type { AnnexDomainId, Tri } from '../../../../api/queries/automation/readiness';
import type { AiActCheckQuestion } from '../../../../api/queries/automation/aiActCheck';

type T = ReturnType<typeof useTranslation>['t'];

export interface QuestionText {
    title: string;
    hint: string;
    options: { value: Tri; label: string; hint?: string }[];
    why: { label: string; href: string };
}

/** One question: its title, hint, answers and the article behind it. */
export function questionText(q: AiActCheckQuestion, t: T): QuestionText {
    const yes = { value: 'yes' as Tri, label: t('automations.aiact.yes', 'Yes') };
    const no = { value: 'no' as Tri, label: t('automations.aiact.no', 'No') };
    const unknown = { value: 'unknown' as Tri, label: t('automations.aiact.unknown', 'I don\'t know') };
    if (q === 'usesAi') {
        return {
            title: t('automations.aiact.q1', 'Does this automation use AI?'),
            hint: t('automations.aiact.q1_hint', 'An AI step, an agent or a skill that writes, sorts or decides something.'),
            options: [yes, no],
            why: { label: 'Art. 3', href: 'https://artificialintelligenceact.eu/article/3/' },
        };
    }
    if (q === 'externalOutput') {
        return {
            title: t('automations.aiact.q2', 'Will people outside the organisation see anything from it?'),
            hint: t('automations.aiact.q2_hint', 'For example an email to a customer or a public web page. This decides whether you must say that something was made automatically.'),
            options: [
                { value: 'no', label: t('automations.aiact.q2_no', 'No, internal only'), hint: t('automations.aiact.q2_no_hint', 'Output stays in your own organisation\'s Nextcloud') },
                { value: 'yes', label: t('automations.aiact.q2_yes', 'Yes, customers or the public') },
                unknown,
            ],
            why: { label: 'Art. 50', href: 'https://artificialintelligenceact.eu/article/50/' },
        };
    }
    if (q === 'prohibitedUse') {
        return {
            title: t('automations.aiact.q4', 'Does it do something the AI Act forbids?'),
            hint: t('automations.aiact.q4_hint', 'For example manipulating people, social scoring, reading emotions at work or school, or sorting people by biometric data.'),
            options: [no, yes, unknown],
            why: { label: 'Art. 5', href: 'https://artificialintelligenceact.eu/article/5/' },
        };
    }
    return {
        title: t('automations.aiact.q3_areas', 'Does it help decide about people in one of these areas?'),
        hint: t('automations.aiact.q3_hint', 'For example who gets hired, a loan, a benefit or a place at school. Those uses count as high-risk.'),
        options: [no, yes, unknown],
        why: { label: t('automations.aiact.annex_iii', 'Annex III'), href: 'https://artificialintelligenceact.eu/annex/3/' },
    };
}

/** The ten Annex III areas as questions (the full editor and the "which area?" list). */
export const DOMAIN_FALLBACK: Record<AnnexDomainId, string> = {
    biometrics: 'Does it identify or categorise people by biometrics?',
    critical_infrastructure: 'Does it help run critical infrastructure (water, power, traffic)?',
    education: 'Does it decide on admission, assessment or monitoring in education?',
    employment: 'Does it select, assess or decide about people at work?',
    essential_services: 'Does it decide on access to essential public services or benefits?',
    credit: 'Does it judge creditworthiness or score credit?',
    insurance: 'Does it price or assess risk for life or health insurance?',
    law_enforcement: 'Is it used by or for law enforcement?',
    migration: 'Is it used for migration, asylum or border control?',
    justice: 'Does it support judicial decisions or democratic processes?',
};

/** The areas as short names, for a sentence. */
export const AREA_FALLBACK: Record<AnnexDomainId, string> = {
    biometrics: 'biometrics',
    critical_infrastructure: 'critical infrastructure',
    education: 'education',
    employment: 'work and hiring',
    essential_services: 'essential services and benefits',
    credit: 'credit',
    insurance: 'life and health insurance',
    law_enforcement: 'law enforcement',
    migration: 'migration and borders',
    justice: 'justice and elections',
};

/** The Art. 5 practices as short names. */
export const PRACTICE_FALLBACK: Record<string, string> = {
    subliminal_manipulation: 'manipulating people',
    exploiting_vulnerabilities: 'exploiting vulnerable people',
    social_scoring: 'social scoring',
    criminal_risk_profiling: 'predicting crime from profiles',
    facial_scraping: 'scraping faces for recognition',
    emotion_recognition_work_education: 'reading emotions at work or school',
    biometric_categorisation: 'sorting people by biometric data',
    realtime_biometric_id: 'live biometric identification in public',
};

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Bee's reason in words the catalogue can translate; the server's English is
 * the fallback. Step lists, areas and practices become names.
 */
export function reasonText(r: { code: string; params: Record<string, unknown>; text: string }, t: T): string {
    const steps = Array.isArray(r.params.steps) ? r.params.steps as { label?: unknown }[] : [];
    const params = {
        ...r.params,
        labels: steps.map(s => (typeof s?.label === 'string' ? `"${s.label}"` : '')).filter(Boolean).join(', '),
        domains: ids(r.params.domains).map(id => t(`automations.aiact.area.${id}`, AREA_FALLBACK[id as AnnexDomainId] || id)).join(', '),
        practices: ids(r.params.practices).map(id => t(`automations.aiact.practice.${id}`, PRACTICE_FALLBACK[id] || id)).join(', '),
    };
    return t(`automations.aiact.reason.${r.code.replace(/^ai_act\./, '').replace(/\./g, '_')}`, r.text, params);
}

/** The outcome in plain words. */
export function outcomeText(outcome: string | null, t: T): string {
    switch (outcome) {
        case 'not_applicable': return t('automations.aiact.outcome_not_applicable', 'Not applicable, no AI');
        case 'minimal': return t('automations.aiact.outcome_minimal', 'Minimal risk, no extra duties');
        case 'transparency': return t('automations.aiact.outcome_transparency', 'Tell people that AI was used');
        case 'high_risk': return t('automations.aiact.outcome_high_risk', 'High risk, extra duties apply');
        case 'prohibited': return t('automations.aiact.outcome_prohibited', 'Prohibited practice');
        default: return '';
    }
}

/** A question as a short label for the "What Bee found" list. */
export function findingLabel(q: AiActCheckQuestion, t: T): string {
    switch (q) {
        case 'usesAi': return t('automations.aiact.find_uses_ai', 'Uses AI');
        case 'externalOutput': return t('automations.aiact.find_external', 'Seen outside the organisation');
        case 'sensitiveUse': return t('automations.aiact.find_sensitive', 'High-risk area');
        default: return t('automations.aiact.find_prohibited', 'Prohibited practice');
    }
}

/** yes / no / not sure. */
export function answerWord(a: Tri, t: T): string {
    if (a === 'yes') return t('automations.aiact.yes', 'Yes');
    if (a === 'no') return t('automations.aiact.no', 'No');
    return t('automations.aiact.not_sure', 'Not sure');
}
