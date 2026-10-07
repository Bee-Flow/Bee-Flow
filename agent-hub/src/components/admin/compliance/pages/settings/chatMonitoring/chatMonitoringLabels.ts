/**
 * The words for every chat-signals code, each behind its own literal key in
 * the `chat_monitoring` namespace so the i18n guard can check it and the
 * Languages panel can reach it. A code this release does not know falls back
 * to the code itself rather than to a guess.
 */
import type { TranslateFn } from '../../../../../../hooks/useTranslation';

export function surfaceLabel(t: TranslateFn, id: string): string {
    switch (id) {
        case 'direct': return t('chat_monitoring.surface.direct', 'Direct chat');
        case 'agent': return t('chat_monitoring.surface.agent', 'Agent chat');
        case 'agent_public': return t('chat_monitoring.surface.agent_public', 'Embedded agents');
        case 'notebook': return t('chat_monitoring.surface.notebook', 'Notebook chat');
        default: return id;
    }
}

export function surfaceHint(t: TranslateFn, id: string): string | null {
    switch (id) {
        case 'direct': return t('chat_monitoring.surface.direct_hint', 'Including the Swarm tier and chats shared into a project. Only the web and desktop app count; the mobile app is not counted yet.');
        case 'agent': return t('chat_monitoring.surface.agent_hint', 'Only members of your own organisation using your agents.');
        case 'agent_public': return t('chat_monitoring.surface.agent_public_hint', 'Visitors of your website who chat with an embedded agent.');
        default: return null;
    }
}

export function populationLabel(t: TranslateFn, population: string): string {
    return population === 'visitors'
        ? t('chat_monitoring.population.visitors', 'Website visitors')
        : t('chat_monitoring.population.employees', 'Employees');
}

export function signalLabel(t: TranslateFn, id: string): string {
    return id === 'kinds'
        ? t('chat_monitoring.signal.kinds', 'Kinds of personal data')
        : t('chat_monitoring.signal.outcomes', 'Privacy Shield outcomes');
}

/** A contributor band as the server writes it ('<5', '5-9', '10-24', '25+'), or null for anything else. */
export function bandLabel(t: TranslateFn, band: string | null | undefined): string | null {
    switch (band) {
        case '<5': return t('chat_monitoring.band.lt5', 'Fewer than 5');
        case '5-9': return t('chat_monitoring.band.5_9', '5 to 9');
        case '10-24': return t('chat_monitoring.band.10_24', '10 to 24');
        case '25+': case '>=25': return t('chat_monitoring.band.25_plus', '25 or more');
        default: return null;
    }
}

export function legalBasisLabel(t: TranslateFn, id: string): string {
    switch (id) {
        case 'art6_1_f': return t('chat_monitoring.legal_basis.art6_1_f', 'Legitimate interest (Art. 6(1)(f))');
        case 'art6_1_e': return t('chat_monitoring.legal_basis.art6_1_e', 'Public task (Art. 6(1)(e))');
        case 'art6_1_c': return t('chat_monitoring.legal_basis.art6_1_c', 'Legal obligation (Art. 6(1)(c))');
        default: return id;
    }
}

export function worksCouncilLabel(t: TranslateFn, id: string): string {
    switch (id) {
        case 'consent': return t('chat_monitoring.works_council.consent', 'Consent obtained');
        case 'court_replacement': return t('chat_monitoring.works_council.court_replacement', 'Replacement consent from the court');
        case 'not_applicable': return t('chat_monitoring.works_council.not_applicable', 'Not applicable');
        case 'pending': return t('chat_monitoring.works_council.pending', 'Pending');
        default: return id;
    }
}

export function worksCouncilReasonLabel(t: TranslateFn, id: string): string {
    switch (id) {
        case 'no_works_council': return t('chat_monitoring.works_council_reason.no_works_council', 'We have no works council');
        case 'pvt_without_consent_right': return t('chat_monitoring.works_council_reason.pvt_without_consent_right', 'Staff representation without a consent right');
        case 'cao_regulates': return t('chat_monitoring.works_council_reason.cao_regulates', 'A collective agreement already regulates this');
        case 'outside_nl': return t('chat_monitoring.works_council_reason.outside_nl', 'Outside the Netherlands');
        default: return id;
    }
}

export function riskLabel(t: TranslateFn, id: string): string {
    switch (id) {
        case 'low': return t('chat_monitoring.risk.low', 'Low');
        case 'medium': return t('chat_monitoring.risk.medium', 'Medium');
        case 'high': return t('chat_monitoring.risk.high', 'High');
        default: return id;
    }
}

export function kindLabel(t: TranslateFn, id: string): string {
    switch (id) {
        case 'name': return t('chat_monitoring.kind.name', 'Names');
        case 'email': return t('chat_monitoring.kind.email', 'E-mail addresses');
        case 'phone': return t('chat_monitoring.kind.phone', 'Phone numbers');
        case 'address': return t('chat_monitoring.kind.address', 'Addresses');
        case 'birth': return t('chat_monitoring.kind.birth', 'Dates of birth');
        case 'financial': return t('chat_monitoring.kind.financial', 'Bank and payment details');
        case 'online_id': return t('chat_monitoring.kind.online_id', 'Online identifiers');
        case 'id_number': return t('chat_monitoring.kind.id_number', 'Identification numbers');
        case 'credential': return t('chat_monitoring.kind.credential', 'Secrets and passwords');
        case 'other': return t('chat_monitoring.kind.other', 'Other personal data');
        default: return id;
    }
}

function globalMissingLabel(t: TranslateFn, code: string): string | null {
    switch (code) {
        case 'surfaces_required': return t('chat_monitoring.missing.surfaces_required', 'Choose at least one chat type');
        case 'surface_not_available': return t('chat_monitoring.missing.surface_not_available', 'A chat type that this version cannot count');
        case 'outcomes_required': return t('chat_monitoring.missing.outcomes_required', 'Privacy Shield outcomes must be counted');
        case 'signal_not_available': return t('chat_monitoring.missing.signal_not_available', 'Something to count that this version does not support');
        case 'legal_basis': return t('chat_monitoring.missing.legal_basis', 'A legal basis');
        case 'lia_documented': return t('chat_monitoring.missing.lia_documented', 'Confirmation that the legitimate-interest assessment is documented');
        case 'retention_days': return t('chat_monitoring.missing.retention_days', 'A retention of 30 to 90 days');
        case 'notice_published': return t('chat_monitoring.missing.notice_published', 'Confirmation that the published notice covers chat signals');
        case 'ropa_reviewed': return t('chat_monitoring.missing.ropa_reviewed', 'Confirmation that you reviewed the processing-register entry');
        case 'effective_from': return t('chat_monitoring.missing.effective_from', 'A start date that is not in the past');
        case 'informed_before_start': return t('chat_monitoring.missing.informed_before_start', 'Confirmation that people were informed before an earlier start date');
        case 'objection_unavailable': return t('chat_monitoring.missing.objection_unavailable', 'The "Don\'t count my chat turns" choice, which this version lacks');
        default: return null;
    }
}

function surfaceMissingLabel(t: TranslateFn, code: string): string | null {
    switch (code) {
        case 'default_bucket_has_orgs': return t('chat_monitoring.missing.default_bucket_has_orgs', 'Employee chats cannot be counted for users without an organisation on an installation with organisations');
        case 'dpia': return t('chat_monitoring.missing.dpia', 'A current DPIA');
        case 'dpia_risk_level': return t('chat_monitoring.missing.dpia_risk_level', 'The risk level of the external DPIA');
        case 'prior_consultation_at': return t('chat_monitoring.missing.prior_consultation_at', 'The date of the prior consultation (high-risk DPIA)');
        case 'dpo_advice_at': return t('chat_monitoring.missing.dpo_advice_at', 'The date of the DPO\'s advice');
        case 'works_council': return t('chat_monitoring.missing.works_council', 'Works-council consent, or why it does not apply');
        case 'works_council_reason': return t('chat_monitoring.missing.works_council_reason', 'Why the works council does not apply');
        case 'works_council_at': return t('chat_monitoring.missing.works_council_at', 'The date of the works-council decision');
        case 'works_council_scope': return t('chat_monitoring.missing.works_council_scope', 'Works-council consent that covers this, with a new date');
        case 'notice_url': return t('chat_monitoring.missing.notice_url', 'An https link to the staff notice');
        case 'notice_published_at': return t('chat_monitoring.missing.notice_published_at', 'The publication date of the notice, on or before the start date');
        case 'agent_public_notice': return t('chat_monitoring.missing.agent_public_notice', 'An https privacy notice for website visitors');
        default: return null;
    }
}

/** A missing code as a plain sentence, the same list for the 422, the paused chat types and the preview. */
export function missingLabel(t: TranslateFn, code: string): string {
    return globalMissingLabel(t, code) ?? surfaceMissingLabel(t, code) ?? code;
}
