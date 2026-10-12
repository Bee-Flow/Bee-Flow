import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { refusalOf, useChatMonitoringRopa, useSaveChatMonitoring, type ChatMonitoringConfig } from '../../../data/useChatMonitoring';
import { ActionButton } from './formAtoms';
import { buildPutBody, classifyChange, dayOf, formFromSettings, isEmployeeSurface, type ChangeKind, type ChatMonitoringForm } from './chatMonitoringForm';
import { missingLabel } from './chatMonitoringLabels';
import { previewMissing } from './chatMonitoringPreview';
import { LegalCaveat } from './ChatMonitoringIntro';
import NoticeTemplate from './NoticeTemplate';
import SetupDpia from './SetupDpia';
import { NoticeFields, RegisterReview, StartDate } from './SetupNotice';
import SetupScope, { Retention } from './SetupScope';
import SetupWorksCouncil from './SetupWorksCouncil';
import { SECTION_CLASS, type SetupSectionProps } from './setupTypes';

/**
 * The set-up form, in the order of build spec 10: where and what to count,
 * the legal basis, the preconditions for employee chat types (DPIA, works
 * council, start date), the notice, retention, the register entry, the
 * small-groups text and a notice to copy. One button: "Switch on" when this
 * turns chat signals on, "Save" otherwise. It stays disabled while the
 * preview finds something missing, and while a widen is not this admin's to
 * make; the server's 422 list replaces the preview when they disagree.
 */

type Refusal = { kind: 'missing'; codes: string[] } | { kind: 'forbidden' } | { kind: 'generic' };

export interface ChatMonitoringSetupProps {
    config: ChatMonitoringConfig;
    orgName: string | null;
    onDone: () => void;
    onCancel: () => void;
}

function MissingList({ codes, testId }: { codes: string[]; testId: string }) {
    const { t } = useTranslation();
    return (
        <div role="status" className="flex flex-col gap-1 rounded-[10px] border border-[var(--warning)] px-3 py-2 text-[11px] text-[var(--text-secondary)]" data-testid={testId}>
            <p className="m-0 font-semibold text-[var(--warning-ink)]">{t('chat_monitoring.err_preconditions', 'This cannot be saved yet. Missing:')}</p>
            <ul className="m-0 pl-4 list-disc">
                {codes.map((code) => <li key={code} data-code={code}>{missingLabel(t, code)}</li>)}
            </ul>
        </div>
    );
}

function refusalFrom(e: unknown): Refusal {
    const r = refusalOf(e);
    if (r.status === 422 && r.missing.length) return { kind: 'missing', codes: r.missing };
    if (r.status === 403 || r.code === 'chat_monitoring_widen_forbidden') return { kind: 'forbidden' };
    return { kind: 'generic' };
}

interface SubmitRowProps {
    preview: string[];
    refusal: Refusal | null;
    forbidden: boolean;
    switchOn: boolean;
    disabled: boolean;
    saving: boolean;
    onSubmit: () => void;
    onCancel: () => void;
}

function SubmitRow({ preview, refusal, forbidden, switchOn, disabled, saving, onSubmit, onCancel }: SubmitRowProps) {
    const { t } = useTranslation();
    const label = switchOn ? t('chat_monitoring.switch_on', 'Switch on') : t('chat_monitoring.save', 'Save');
    return (
        <div className={SECTION_CLASS}>
            {refusal?.kind === 'missing' && <MissingList codes={refusal.codes} testId="cm-error-missing" />}
            {refusal?.kind !== 'missing' && preview.length > 0 && <MissingList codes={preview} testId="cm-missing" />}
            {(forbidden || refusal?.kind === 'forbidden') && (
                <p role="alert" className="m-0 text-[11px] text-[var(--error-ink)]" data-testid="cm-error-forbidden">
                    {t('chat_monitoring.err_forbidden', 'Only an organisation admin can switch this on or count more. You can switch it off or count less.')}
                </p>
            )}
            {refusal?.kind === 'generic' && (
                <p role="alert" className="m-0 text-[11px] text-[var(--error-ink)]" data-testid="cm-error-generic">{t('chat_monitoring.err_generic', 'Could not save. Try again.')}</p>
            )}
            <div className="flex items-center gap-2">
                <ActionButton variant="primary" onClick={onSubmit} disabled={disabled} data-testid="cm-submit">
                    {saving ? t('chat_monitoring.saving', 'Saving…') : label}
                </ActionButton>
                <ActionButton onClick={onCancel} disabled={saving} data-testid="cm-cancel">{t('chat_monitoring.cancel', 'Cancel')}</ActionButton>
            </div>
        </div>
    );
}

function useSetupState(config: ChatMonitoringConfig) {
    const [now] = useState(() => new Date());
    const [form, setForm] = useState<ChatMonitoringForm>(() => formFromSettings(config.settings, now));
    const [refusal, setRefusal] = useState<Refusal | null>(null);
    const patch = useCallback((next: Partial<ChatMonitoringForm>) => {
        setRefusal(null);
        setForm((prev) => ({ ...prev, ...next }));
    }, []);
    const body = useMemo(() => buildPutBody(form, { enabled: true, now }), [form, now]);
    const change = useMemo(() => classifyChange(config.settings, body), [config.settings, body]);
    const preview = useMemo(() => previewMissing(form, {
        before: config.settings, dpia: config.dpia, dpoRecorded: config.dpoRecorded, privacyNoticeUrlSet: config.privacyNoticeUrlSet, now,
    }), [form, config, now]);
    return { now, form, patch, body, change, preview, refusal, setRefusal };
}

/** What the button and the notice template need from the change: dirty, forbidden, and the day counting starts. */
function deriveFlags(change: ChangeKind, config: ChatMonitoringConfig, form: ChatMonitoringForm) {
    return {
        dirty: change.switchOn || change.widen || change.narrow || change.maintain,
        forbidden: change.widen && !config.canWiden,
        startDay: change.employeeWidened ? form.start_date : dayOf(config.settings.effective_from) || form.start_date,
    };
}

export default function ChatMonitoringSetup({ config, orgName, onDone, onCancel }: ChatMonitoringSetupProps) {
    const { now, form, patch, body, change, preview, refusal, setRefusal } = useSetupState(config);
    const save = useSaveChatMonitoring();
    // The register knows the controller's name when the hub's overview has not loaded it.
    const ropa = useChatMonitoringRopa({ enabled: true });
    const { dirty, forbidden, startDay } = deriveFlags(change, config, form);
    const section: SetupSectionProps = { form, patch, config, change, now };

    const submit = async () => {
        setRefusal(null);
        try {
            await save.mutateAsync(body);
            onDone();
        } catch (e) {
            setRefusal(refusalFrom(e));
        }
    };

    return (
        <div className="flex flex-col gap-3" data-testid="cm-setup">
            <LegalCaveat />
            <SetupScope {...section} />
            {form.surfaces.some(isEmployeeSurface) && (
                <div className={`${SECTION_CLASS} gap-3`} data-testid="cm-preconditions">
                    <SetupDpia {...section} />
                    <SetupWorksCouncil {...section} />
                    {change.employeeWidened && <StartDate {...section} />}
                </div>
            )}
            {form.surfaces.length > 0 && <div className={SECTION_CLASS}><NoticeFields {...section} /></div>}
            <Retention {...section} />
            <RegisterReview {...section} />
            <div className={SECTION_CLASS}>
                <NoticeTemplate form={form} template={config.template} orgName={orgName || ropa.data?.controllerName || null} startDay={startDay} />
            </div>
            <SubmitRow
                preview={dirty ? preview : []}
                refusal={refusal}
                forbidden={forbidden}
                switchOn={change.switchOn}
                disabled={save.isPending || !dirty || preview.length > 0 || forbidden}
                saving={save.isPending}
                onSubmit={() => { void submit(); }}
                onCancel={onCancel}
            />
        </div>
    );
}
