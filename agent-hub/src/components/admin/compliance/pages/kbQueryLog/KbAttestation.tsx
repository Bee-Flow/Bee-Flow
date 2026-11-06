import type { TranslateFn } from '@/hooks/useTranslation';
import type { KqlKbRow } from '@/api/kbQueryLog.types';
import { worksCouncilLabel, worksCouncilReasonLabel } from '../settings/chatMonitoring/chatMonitoringLabels';
import { fmtStamp } from '../audits/auditForms';

/** The organisation's attestation for one base as short facts: DPIA, works council, privacy notice, who and when, names and AI Act flag. */
function attestationFacts(t: TranslateFn, k: KqlKbRow, locale: string): string[] {
    const a = k.attestation;
    const facts: string[] = [];
    if (a) {
        facts.push(a.dpia === 'done'
            ? t('compliance.kql_att_dpia_done', 'DPIA: done')
            : t('compliance.kql_att_dpia_not_required', 'DPIA: not required'));
        const council = a.worksCouncil === 'not_applicable' && a.worksCouncilReason
            ? `${worksCouncilLabel(t, 'not_applicable')}, ${worksCouncilReasonLabel(t, a.worksCouncilReason)}`
            : worksCouncilLabel(t, a.worksCouncil ?? '');
        facts.push(t('compliance.kql_att_council', 'Works council: {value}', { value: council }));
        facts.push(a.privacyNoticeUpdated
            ? t('compliance.kql_att_notice_yes', 'Privacy notice: updated')
            : t('compliance.kql_att_notice_no', 'Privacy notice: not confirmed'));
        if (k.attestedAt) {
            facts.push(t('compliance.kql_att_by', 'Attested {when} by {who}', { when: fmtStamp(k.attestedAt, locale), who: k.attestedByName || k.attestedBy || '—' }));
        }
    } else if (k.enabled) {
        facts.push(t('compliance.kql_att_missing', 'No attestation on record'));
    }
    facts.push(k.showNames
        ? t('compliance.kql_att_names_shown', 'Managers see names')
        : t('compliance.kql_att_names_hidden', 'Managers see pseudonyms'));
    if (k.aiActHighRisk) facts.push(t('compliance.kql_att_high_risk', 'High-risk AI system (AI Act)'));
    return facts;
}

export default function KbAttestation({ t, k, locale }: { t: TranslateFn; k: KqlKbRow; locale: string }) {
    return (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[11px] text-[var(--text-secondary)]" data-testid={`kql-attestation-${k.id}`}>
            {attestationFacts(t, k, locale).map((f) => <li key={f}>{f}</li>)}
        </ul>
    );
}
