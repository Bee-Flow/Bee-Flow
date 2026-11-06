import type { QueryLogAttestation } from '@/api/queries/kbQueryLog';
import type { TranslateFn } from '@/hooks/useTranslation';
import { worksCouncilLabel, worksCouncilReasonLabel } from '@/components/admin/compliance/pages/settings/chatMonitoring/chatMonitoringLabels';
import { dpiaLabel, retentionChoices } from './queryLogLabels';

const SWITCH_TRACK = 'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [outline-color:var(--accent-primary)]';

/** The switch and the retention term of the card. */
export function QueryLogControls({ t, enabled, retention, highRisk, busy, onToggle, onRetention }: { t: TranslateFn; enabled: boolean; retention: number; highRisk: boolean; busy: boolean; onToggle: () => void; onRetention: (days: number) => void }) {
    return (
        <div className="flex flex-wrap items-center gap-3">
            <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={t('knowledge.query_log.title', 'Log search queries and answers')}
                disabled={busy}
                onClick={onToggle}
                data-testid="kb-query-log-toggle"
                className={`${SWITCH_TRACK} ${enabled ? '[background:var(--accent-primary)] [border-color:var(--accent-primary)]' : '[background:var(--bg-secondary)] [border-color:var(--border-default)]'}`}
            >
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                {t('knowledge.query_log.retention', 'Keep for')}
                <select
                    value={retention}
                    disabled={busy}
                    onChange={(e) => onRetention(Number(e.target.value))}
                    data-testid="kb-query-log-retention"
                    className="rounded-md border px-2 py-1 text-xs [background:var(--bg-secondary)] [border-color:var(--border-default)] text-[var(--text-primary)]"
                >
                    {retentionChoices(highRisk).map((d) => (
                        <option key={d} value={d}>{t('knowledge.query_log.days', '{n} days', { n: d })}</option>
                    ))}
                </select>
            </label>
        </div>
    );
}

/** The privacy text of the "turn on" dialog: who reads what, and what the encryption does and does not mean. */
export function QueryLogEnableText({ t, retention }: { t: TranslateFn; retention: number }) {
    return (
        <div className="flex flex-col gap-2 text-left" data-testid="kb-query-log-privacy">
            <p>{t('knowledge.query_log.privacy_what', 'From now on this knowledge base keeps each question asked to it, the passages found, and the answer when there is one, together with who asked and where.')}</p>
            <p>{t('knowledge.query_log.privacy_who', 'The managers of this knowledge base and your compliance officers can read it. Everyone who asks a question first sees a notice and confirms it. Until then their questions are not logged.')}</p>
            <p>{t('knowledge.query_log.privacy_zk', 'The content is encrypted with an organisation key. That is not zero-knowledge encryption, even if your organisation uses zero-knowledge for its chats: the organisation can read this log.')}</p>
            <p>{t('knowledge.query_log.privacy_term', 'Entries are deleted after {n} days. You can change that, or delete everything, at any time.', { n: retention })}</p>
        </div>
    );
}

/** Keep what is there until the term ends, or delete it now. */
export function QueryLogDisableChoice({ t, retention, deleteNow, setDeleteNow }: { t: TranslateFn; retention: number; deleteNow: boolean; setDeleteNow: (v: boolean) => void }) {
    return (
        <fieldset className="flex flex-col gap-2 text-left border-0 p-0 m-0" data-testid="kb-query-log-disable-choice">
            <legend className="sr-only">{t('knowledge.query_log.disable_legend', 'What happens to the entries already logged')}</legend>
            <label className="flex items-start gap-2">
                <input type="radio" name="kb-query-log-disable" checked={!deleteNow} onChange={() => setDeleteNow(false)} />
                <span>{t('knowledge.query_log.disable_keep_option', 'Keep them until their retention period ends ({n} days after each question). Nothing new is logged.', { n: retention })}</span>
            </label>
            <label className="flex items-start gap-2">
                <input type="radio" name="kb-query-log-disable" checked={deleteNow} onChange={() => setDeleteNow(true)} />
                <span>{t('knowledge.query_log.disable_delete_option', 'Delete all entries now. This cannot be undone.')}</span>
            </label>
        </fieldset>
    );
}

/** Two settings of a base that logs: pseudonyms or names for managers, and the AI Act flag that fixes the term at 6 months or more. */
export function QueryLogOptions({ t, showNames, highRisk, busy, onShowNames, onHighRisk }: { t: TranslateFn; showNames: boolean; highRisk: boolean; busy: boolean; onShowNames: (v: boolean) => void; onHighRisk: (v: boolean) => void }) {
    return (
        <div className="flex flex-col gap-2" data-testid="kb-query-log-options">
            <label className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
                <input type="checkbox" data-testid="kb-query-log-show-names" checked={showNames} disabled={busy} onChange={(e) => onShowNames(e.target.checked)} className="mt-0.5" />
                <span>
                    {t('knowledge.query_log.show_names', 'Show askers’ names to managers')}
                    <span className="block text-[11px] text-[var(--text-tertiary)]">{t('knowledge.query_log.show_names_hint', 'Off: managers see a pseudonym such as “Employee 7F3K”, the same one every time. Compliance officers can still resolve it for a data request.')}</span>
                </span>
            </label>
            <label className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
                <input type="checkbox" data-testid="kb-query-log-high-risk" checked={highRisk} disabled={busy} onChange={(e) => onHighRisk(e.target.checked)} className="mt-0.5" />
                <span>
                    {t('knowledge.query_log.high_risk', 'High-risk AI system under the AI Act')}
                    <span className="block text-[11px] text-[var(--text-tertiary)]">{t('knowledge.query_log.high_risk_hint', 'Logs must then be kept for at least 6 months (180 or 365 days).')}</span>
                </span>
            </label>
        </div>
    );
}

/** What the organisation attested when it switched the log on, read-only. */
export function QueryLogAttestationView({ t, attestation }: { t: TranslateFn; attestation: QueryLogAttestation }) {
    const council = attestation.worksCouncil === 'not_applicable' && attestation.worksCouncilReason
        ? `${worksCouncilLabel(t, 'not_applicable')} (${worksCouncilReasonLabel(t, attestation.worksCouncilReason)})`
        : worksCouncilLabel(t, attestation.worksCouncil);
    return (
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-secondary)]" data-testid="kb-query-log-attestation">
            <dt className="text-[var(--text-tertiary)]">{t('knowledge.query_log.attest_dpia', 'Data protection impact assessment (DPIA)')}</dt>
            <dd className="m-0">{dpiaLabel(t, attestation.dpia)}</dd>
            <dt className="text-[var(--text-tertiary)]">{t('chat_monitoring.works_council_label', 'Works council')}</dt>
            <dd className="m-0">{council}</dd>
            <dt className="text-[var(--text-tertiary)]">{t('knowledge.query_log.attest_notice_short', 'Privacy notice')}</dt>
            <dd className="m-0">{attestation.privacyNoticeUpdated ? t('knowledge.query_log.attest_notice_yes', 'Updated') : '–'}</dd>
        </dl>
    );
}
