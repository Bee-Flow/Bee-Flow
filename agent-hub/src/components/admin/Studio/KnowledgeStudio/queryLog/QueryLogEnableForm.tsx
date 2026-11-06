import { useState } from 'react';
import useTranslation, { type TranslateFn } from '@/hooks/useTranslation';
import Modal from '@/components/shared/Modal';
import { useDpiaChoices, type QueryLogAttestation, type QueryLogSettingsInput } from '@/api/queries/kbQueryLog';
import { WORKS_COUNCIL_REASONS } from '@/components/admin/compliance/pages/settings/chatMonitoring/chatMonitoringForm';
import { worksCouncilLabel, worksCouncilReasonLabel } from '@/components/admin/compliance/pages/settings/chatMonitoring/chatMonitoringLabels';
import { QueryLogEnableText } from './QueryLogCardParts';
import { dpiaLabel, retentionChoices } from './queryLogLabels';

/**
 * The form behind "turn logging on". The legal basis is the organisation's
 * legitimate interest, not consent of the people asking: the organisation
 * says here that the preconditions are met, and the server keeps that.
 */
export interface QueryLogEnableFormProps {
    open: boolean;
    retention: number;
    previous: QueryLogAttestation | null;
    error: string | null;
    onSubmit: (input: QueryLogSettingsInput) => Promise<void>;
    onCancel: () => void;
}

/** The works council answers that count as a decision for this log; "pending" is not one. */
const WORKS_COUNCIL_CHOICES = ['consent', 'court_replacement', 'not_applicable'] as const;
interface FormState {
    purpose: boolean; dpia: string; dpiaId: string; council: string; reason: string;
    notice: boolean; showNames: boolean; highRisk: boolean; days: number;
}
type Patch = (p: Partial<FormState>) => void;

/** Every precondition stated; the server wants the DPIA named when one is "done" . */
function isReady(f: FormState): boolean {
    const dpiaOk = f.dpia === 'not_required' || (f.dpia === 'done' && !!f.dpiaId);
    const councilOk = !!f.council && (f.council !== 'not_applicable' || !!f.reason);
    return f.purpose && f.notice && dpiaOk && councilOk;
}

function buildInput(f: FormState): QueryLogSettingsInput {
    const choices = retentionChoices(f.highRisk);
    return {
        enabled: true,
        retentionDays: choices.includes(f.days) ? f.days : choices[0],
        showNames: f.showNames,
        aiActHighRisk: f.highRisk,
        attestation: {
            purpose: 'ai_quality', dpia: f.dpia as 'done' | 'not_required', worksCouncil: f.council, privacyNoticeUpdated: true,
            ...(f.dpia === 'done' ? { dpiaId: f.dpiaId } : {}),
            ...(f.council === 'not_applicable' ? { worksCouncilReason: f.reason } : {}),
        },
    };
}

const FIELD = 'rounded-md border px-2 py-1 text-xs [background:var(--bg-secondary)] [border-color:var(--border-default)] text-[var(--text-primary)]';

function Check({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
    return (
        <label className="flex items-start gap-2 text-xs text-[var(--text-primary)]">
            <input type="checkbox" data-testid={id} checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
            <span>{children}</span>
        </label>
    );
}

function Pick({ label, testId, value, onChange, children }: { label: string; testId: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
    return (
        <label className="flex flex-col gap-0.5 text-[11px] text-[var(--text-tertiary)]">
            {label}
            <select className={FIELD} value={value} data-testid={testId} onChange={(e) => onChange(e.target.value)}>{children}</select>
        </label>
    );
}

function Choose({ t }: { t: TranslateFn }) {
    return <option value="">{t('knowledge.query_log.choose', 'Choose…')}</option>;
}

function DpiaFields({ t, f, patch, open }: { t: TranslateFn; f: FormState; patch: Patch; open: boolean }) {
    const dpias = useDpiaChoices(open && f.dpia === 'done');
    const list = dpias.data ?? [];
    return (
        <>
            <Pick label={t('knowledge.query_log.attest_dpia', 'Data protection impact assessment (DPIA)')} testId="kql-enable-dpia" value={f.dpia} onChange={(dpia) => patch({ dpia })}>
                <Choose t={t} />
                <option value="done">{dpiaLabel(t, 'done')}</option>
                <option value="not_required">{dpiaLabel(t, 'not_required')}</option>
            </Pick>
            {f.dpia === 'done' && list.length === 0 && !dpias.isPending && (
                <p className="m-0 text-[11px] text-[var(--text-tertiary)]" data-testid="kql-enable-dpia-none">
                    {t('knowledge.query_log.attest_dpia_none', 'No DPIA is recorded for your organisation, or you may not see them. Ask a compliance officer to record it in the Compliance Center.')}
                </p>
            )}
            {f.dpia === 'done' && list.length > 0 && (
                <Pick label={t('knowledge.query_log.attest_dpia_pick', 'Which DPIA')} testId="kql-enable-dpia-id" value={f.dpiaId} onChange={(dpiaId) => patch({ dpiaId })}>
                    <Choose t={t} />
                    {list.map((d) => (
                        <option key={d.id} value={d.id}>{d.status === 'expired' ? `${d.title} · ${t('knowledge.query_log.dpia_expired', 'expired')}` : d.title}</option>
                    ))}
                </Pick>
            )}
        </>
    );
}

function CouncilFields({ t, f, patch }: { t: TranslateFn; f: FormState; patch: Patch }) {
    return (
        <>
            <Pick label={t('chat_monitoring.works_council_label', 'Works council')} testId="kql-enable-council" value={f.council} onChange={(council) => patch({ council })}>
                <Choose t={t} />
                {WORKS_COUNCIL_CHOICES.map((id) => <option key={id} value={id}>{worksCouncilLabel(t, id)}</option>)}
            </Pick>
            {f.council === 'not_applicable' && (
                <Pick label={t('chat_monitoring.works_council_reason_label', 'Why not applicable')} testId="kql-enable-reason" value={f.reason} onChange={(reason) => patch({ reason })}>
                    <Choose t={t} />
                    {WORKS_COUNCIL_REASONS.map((id) => <option key={id} value={id}>{worksCouncilReasonLabel(t, id)}</option>)}
                </Pick>
            )}
        </>
    );
}

function Choices({ t, f, patch }: { t: TranslateFn; f: FormState; patch: Patch }) {
    const choices = retentionChoices(f.highRisk);
    const term = choices.includes(f.days) ? f.days : choices[0];
    return (
        <>
            <Check id="kql-enable-names" checked={f.showNames} onChange={(showNames) => patch({ showNames })}>
                {t('knowledge.query_log.show_names', 'Show askers’ names to managers')}
                <span className="block text-[11px] text-[var(--text-tertiary)]">{t('knowledge.query_log.show_names_hint', 'Off: managers see a pseudonym such as “Employee 7F3K”, the same one every time. Compliance officers can still resolve it for a data request.')}</span>
            </Check>
            <Check id="kql-enable-high-risk" checked={f.highRisk} onChange={(highRisk) => patch({ highRisk })}>
                {t('knowledge.query_log.high_risk', 'High-risk AI system under the AI Act')}
                <span className="block text-[11px] text-[var(--text-tertiary)]">{t('knowledge.query_log.high_risk_hint', 'Logs must then be kept for at least 6 months (180 or 365 days).')}</span>
            </Check>
            <Pick label={t('knowledge.query_log.retention', 'Keep for')} testId="kql-enable-retention" value={String(term)} onChange={(v) => patch({ days: Number(v) })}>
                {choices.map((d) => <option key={d} value={d}>{t('knowledge.query_log.days', '{n} days', { n: d })}</option>)}
            </Pick>
        </>
    );
}

export default function QueryLogEnableForm({ open, retention, previous, error, onSubmit, onCancel }: QueryLogEnableFormProps) {
    const { t } = useTranslation();
    const [f, setF] = useState<FormState>({
        purpose: false, dpia: previous?.dpia ?? '', dpiaId: previous?.dpiaId ?? '', council: previous?.worksCouncil ?? '',
        reason: previous?.worksCouncilReason ?? '', notice: false, showNames: false, highRisk: false, days: retention,
    });
    const [busy, setBusy] = useState(false);
    const patch: Patch = (p) => setF((cur) => ({ ...cur, ...p }));
    const ready = isReady(f);

    const submit = async () => {
        if (!ready) return;
        setBusy(true);
        try { await onSubmit(buildInput(f)); } finally { setBusy(false); }
    };

    return (
        <Modal
            open={open}
            onClose={() => { if (!busy) onCancel(); }}
            title={t('knowledge.query_log.enable_title', 'Log questions and answers?')}
            size="md"
            footer={(
                <>
                    <button type="button" onClick={onCancel} disabled={busy} data-testid="kql-enable-cancel" className="px-4 py-2 rounded-lg text-sm text-[var(--text-primary)] bg-white/5 hover:bg-white/10 disabled:opacity-50">
                        {t('knowledge.query_log.cancel', 'Cancel')}
                    </button>
                    <button type="button" onClick={() => void submit()} disabled={!ready || busy} data-testid="kql-enable-submit" className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-[var(--accent-primary)] disabled:opacity-50 disabled:cursor-not-allowed">
                        {t('knowledge.query_log.enable_confirm', 'Turn logging on')}
                    </button>
                </>
            )}
        >
            <div className="flex flex-col gap-3 text-left text-xs text-[var(--text-secondary)]" data-testid="kql-enable-form">
                <QueryLogEnableText t={t} retention={buildInput(f).retentionDays ?? retention} />
                <p data-testid="kql-enable-basis">{t('knowledge.query_log.basis', 'The legal basis is your organisation’s legitimate interest. If questions can be traced to people, the works council may have a right of consent (Dutch WOR art. 27). A data protection impact assessment (DPIA) may be required.')}</p>
                <Check id="kql-enable-purpose" checked={f.purpose} onChange={(purpose) => patch({ purpose })}>
                    {t('knowledge.query_log.attest_purpose', 'We use the log only to check AI answers and improve the knowledge base, not to assess employees.')}
                </Check>
                <DpiaFields t={t} f={f} patch={patch} open={open} />
                <CouncilFields t={t} f={f} patch={patch} />
                <Check id="kql-enable-notice" checked={f.notice} onChange={(notice) => patch({ notice })}>
                    {t('knowledge.query_log.attest_notice', 'Our privacy notice says that questions to knowledge bases can be logged.')}
                </Check>
                <Choices t={t} f={f} patch={patch} />
                {error && <p className="text-xs text-[var(--error)]" role="alert">{error}</p>}
            </div>
        </Modal>
    );
}
