import { FileDown, RotateCcw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React, { useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import SideDrawerJs, { DrawerSection as DrawerSectionJs } from '../../../../shared/SideDrawer';
import { API } from '../../data/api';
import useResourceJs from '../../data/useResource';
import { formatDay as formatDayAt, useDateFormat } from '../../shared/formatDates';
import StatusPillJs from '../../shared/StatusPill';
import type { DrawerMode } from '../../shared/useDrawerMode';
import {
    ActionButton as ActionButtonJs, Fact as FactJs, Field as FieldJs, Select as SelectJs, TextArea as TextAreaJs,
    TextInput as TextInputJs, Toggle as ToggleJs,
} from '../audits/auditForms';

/**
 * DpiaDrawer: one high-risk agent's data-protection impact assessment
 * (GDPR Art. 35) in the DPIA register's SideDrawer.
 *
 *   on record   a read-only summary: the assessment in words (how and when it
 *               was made, until when it holds), the residual risk, the
 *               recorded answers and the measures. "Re-assess" opens the form
 *               pre-filled from them.
 *   none yet    the questionnaire. "Save assessment" stays disabled until the
 *               three Art. 35(7) answers in words are there (purpose, the
 *               personal data, the human oversight); the server refuses a blank
 *               questionnaire as well. "Assessed outside Bee Flow? Record an
 *               attestation" is the quiet way out for an assessment kept
 *               elsewhere.
 *
 * The drawer used to open an empty form for an agent that HAD a DPIA, and one
 * click on Save recorded an empty one and turned Art. 35 green.
 *
 * The register list carries no answers (dpiaStore.listForOrg), so the summary
 * reads the full record (`GET /dpia/:agentId`). The host keys the drawer on
 * the agent and the record's approval stamp: another agent, or a save that
 * landed, mounts a fresh drawer (fresh read, fresh form); a failed save leaves
 * the form as it was. Only the admin's own answers and the stamps go out.
 */

// .jsx/.js exports: their `= null` defaults would type the props as null-only.
const SideDrawer = SideDrawerJs as unknown as ComponentType<{
    open?: boolean; onClose?: () => void; mode?: DrawerMode; width?: number; ariaLabel?: string; testId?: string;
    header?: ReactNode; footer?: ReactNode; children?: ReactNode;
}>;
const DrawerSection = DrawerSectionJs as unknown as ComponentType<{ label?: ReactNode; hint?: ReactNode; testId?: string; children?: ReactNode }>;
const StatusPill = StatusPillJs as unknown as ComponentType<{ tone?: PillTone; title?: string; testId?: string; children: ReactNode }>;
const ActionButton = ActionButtonJs as unknown as ComponentType<{
    variant?: string; icon?: LucideIcon; disabled?: boolean; onClick?: () => void; title?: string;
    className?: string; children?: ReactNode; 'data-testid'?: string;
}>;
const Fact = FactJs as unknown as ComponentType<{ label: ReactNode; testId?: string; children?: ReactNode }>;
const Field = FieldJs as unknown as ComponentType<{ label: ReactNode; hint?: ReactNode; testId?: string; children: ReactNode }>;
type InputProps = { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; 'data-testid'?: string };
const TextInput = TextInputJs as unknown as ComponentType<InputProps>;
const TextArea = TextAreaJs as unknown as ComponentType<InputProps>;
const Select = SelectJs as unknown as ComponentType<InputProps & { options: Array<{ value: string; label: string }> }>;
const Toggle = ToggleJs as unknown as ComponentType<{ checked: boolean; onChange: (v: boolean) => void; label: ReactNode; testId?: string }>;
const useResource = useResourceJs as unknown as <T>(url: string | null, options?: {
    enabled?: boolean; parse?: (body: unknown) => T | null; onError?: (e: unknown) => T | null;
}) => { data: T | null; failed: boolean };

type PillTone = 'success' | 'warning' | 'error' | 'neutral';

export interface DpiaRecord {
    agent_id?: string;
    mode?: string | null;
    risk_level?: string | null;
    approved_at?: string | null;
    expires_at?: string | null;
    answers?: Record<string, unknown> | null;
    mitigations?: unknown;
}

export interface DpiaRow {
    agentId: string;
    agentName: string;
    riskReason: string | null;
    status?: string;
    dpia: DpiaRecord | null;
}

export interface DpiaForm {
    purpose: string;
    data_categories: string;
    automated_decisions: boolean;
    human_oversight: string;
    mitigations: string;
    risk_level: string;
}

export const EMPTY_FORM: Readonly<DpiaForm> = Object.freeze({
    purpose: '', data_categories: '', automated_decisions: false,
    human_oversight: '', mitigations: '', risk_level: 'medium',
});

/** Twelve months from `now`: the validity of an assessment and of an attestation. */
export function defaultExpiry(now: Date = new Date()): string {
    const d = new Date(now.getTime());
    d.setMonth(d.getMonth() + 12);
    return d.toISOString();
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The recorded measures as a list: the server stores an array, one measure per line. */
export function mitigationList(value: unknown): string[] {
    const lines = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : [];
    return lines.map(v => text(v).trim()).filter(Boolean);
}

/** The form, pre-filled from a recorded assessment ("Re-assess"). */
export function formFromRecord(record: DpiaRecord | null | undefined): DpiaForm {
    const answers = record?.answers && typeof record.answers === 'object' ? record.answers : {};
    return {
        purpose: text(answers.purpose),
        data_categories: text(answers.data_categories),
        automated_decisions: answers.automated_decisions === true,
        human_oversight: text(answers.human_oversight),
        mitigations: mitigationList(record?.mitigations).join('\n'),
        risk_level: ['low', 'medium', 'high'].includes(text(record?.risk_level)) ? text(record?.risk_level) : 'medium',
    };
}

/** The three answers a questionnaire cannot do without (the server checks the same). */
export function formReady(form: DpiaForm): boolean {
    return [form.purpose, form.data_categories, form.human_oversight].every(v => v.trim() !== '');
}

export function questionnaireBody(form: DpiaForm, now: Date = new Date()): Record<string, unknown> {
    return {
        mode: 'questionnaire',
        risk_level: form.risk_level,
        expires_at: defaultExpiry(now),
        answers: {
            purpose: form.purpose.trim(),
            data_categories: form.data_categories.trim(),
            automated_decisions: !!form.automated_decisions,
            human_oversight: form.human_oversight.trim(),
        },
        mitigations: mitigationList(form.mitigations),
    };
}

export function isExpired(dpia: DpiaRecord | null | undefined, now = Date.now()): boolean {
    const at = dpia?.expires_at ? new Date(dpia.expires_at).getTime() : NaN;
    return Number.isFinite(at) && at <= now;
}

/** "Assessed 14 Jul" (success), "Expired 3 Mar" or "No DPIA" (error); how and until when in `title`. */
export function dpiaPill(dpia: DpiaRecord | null | undefined, t: TranslateFn, locale = 'en', now = Date.now()): { tone: PillTone; label: string; title?: string } {
    if (!dpia) return { tone: 'error', label: t('compliance.dpia_none', 'No DPIA') };
    const day = (v: string | null | undefined) => formatDayAt(v, locale, now);
    const mode = dpia.mode === 'attestation'
        ? t('compliance.dpia_mode_attestation', 'attestation')
        : t('compliance.dpia_mode_questionnaire', 'questionnaire');
    if (isExpired(dpia, now)) {
        return { tone: 'error', label: t('compliance.dpia_expired', 'Expired {date}', { date: day(dpia.expires_at) }), title: mode };
    }
    const until = dpia.expires_at ? t('compliance.dpia_expires', 'Expires {date}', { date: day(dpia.expires_at) }) : null;
    return {
        tone: 'success',
        label: t('compliance.dpia_assessed', 'Assessed {date}', { date: day(dpia.approved_at) }),
        title: [mode, until].filter(Boolean).join(' · '),
    };
}

/** The register's one DPIA pill: the table, the phone card and the drawer all draw this. */
export function DpiaPill({ dpia, testId }: { dpia: DpiaRecord | null | undefined; testId?: string }) {
    const { t } = useTranslation();
    const { locale } = useDateFormat();
    const pill = dpiaPill(dpia, t, locale);
    return <StatusPill tone={pill.tone} title={pill.title} testId={testId}>{pill.label}</StatusPill>;
}

const asRecord = (body: unknown): DpiaRecord | null => (body && typeof body === 'object' ? body as DpiaRecord : null);

function Summary({ dpia, record, failed }: { dpia: DpiaRecord; record: DpiaRecord | null; failed: boolean }) {
    const { t } = useTranslation();
    const { locale } = useDateFormat();
    const pill = dpiaPill(dpia, t, locale);
    const full = record || dpia;
    const answers = full.answers && typeof full.answers === 'object' ? full.answers : null;
    const measures = mitigationList(full.mitigations);
    const risk = text(full.risk_level);
    const riskLabel = { low: t('compliance.dpia_risk_low', 'Low'), medium: t('compliance.dpia_risk_medium', 'Medium'), high: t('compliance.dpia_risk_high', 'High') }[risk];
    const answered = (v: unknown) => (text(v).trim() ? text(v) : null);
    return (
        <div className="flex flex-col gap-3" data-testid="dpia-summary">
            <span className="flex items-center gap-2 flex-wrap">
                <StatusPill tone={pill.tone} testId="dpia-summary-pill">{pill.label}</StatusPill>
                {pill.title && <span className="text-[11px] text-[var(--text-tertiary)]" data-testid="dpia-summary-meta">{pill.title}</span>}
            </span>
            {riskLabel && <Fact label={t('compliance.dpia_q_risk', 'Residual risk')} testId="dpia-summary-risk">{riskLabel}</Fact>}
            {answers && Object.keys(answers).length > 0 && (
                <>
                    <DrawerSection label={t('compliance.dpia_q_purpose', 'Purpose of processing')} testId="dpia-answer-purpose">
                        <span className="text-xs text-[var(--text-primary)] [overflow-wrap:anywhere]">{answered(answers.purpose) ?? '—'}</span>
                    </DrawerSection>
                    <DrawerSection label={t('compliance.dpia_q_data', 'Personal data involved')} testId="dpia-answer-data">
                        <span className="text-xs text-[var(--text-primary)] [overflow-wrap:anywhere]">{answered(answers.data_categories) ?? '—'}</span>
                    </DrawerSection>
                    <DrawerSection label={t('compliance.dpia_q_automated', 'Makes or supports automated decisions about people')} testId="dpia-answer-automated">
                        <span className="text-xs text-[var(--text-primary)]">{answers.automated_decisions === true ? t('common.yes', 'Yes') : t('common.no', 'No')}</span>
                    </DrawerSection>
                    <DrawerSection label={t('compliance.dpia_q_oversight', 'Human oversight')} testId="dpia-answer-oversight">
                        <span className="text-xs text-[var(--text-primary)] [overflow-wrap:anywhere]">{answered(answers.human_oversight) ?? '—'}</span>
                    </DrawerSection>
                </>
            )}
            {measures.length > 0 && (
                <DrawerSection label={t('compliance.dpia_q_mitigations_short', 'Mitigations')} testId="dpia-answer-mitigations">
                    <ul className="m-0 pl-4 list-disc flex flex-col gap-0.5 text-xs text-[var(--text-primary)]">
                        {measures.map((m) => <li key={m} className="[overflow-wrap:anywhere]">{m}</li>)}
                    </ul>
                </DrawerSection>
            )}
            {failed && !answers && (
                <span className="text-[11px] text-[var(--text-tertiary)]" data-testid="dpia-answers-failed">
                    {t('compliance.dpia_answers_failed', 'The recorded answers could not be read.')}
                </span>
            )}
        </div>
    );
}

function Questionnaire({ form, set, onAttest, saving }: {
    form: DpiaForm;
    set: (patch: Partial<DpiaForm>) => void;
    onAttest: () => void;
    saving: boolean;
}) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-3" data-testid="dpia-form">
            <span className="text-[11px] text-[var(--text-tertiary)]">{t('compliance.dpia_questionnaire_hint', 'Art. 35(7): description and purposes, necessity and proportionality, risks to the rights and freedoms of the people concerned, measures.')}</span>
            <Field label={t('compliance.dpia_q_purpose', 'Purpose of processing')}>
                <TextInput value={form.purpose} onChange={v => set({ purpose: v })} data-testid="dpia-q-purpose" />
            </Field>
            <Field label={t('compliance.dpia_q_data', 'Personal data involved')}>
                <TextInput value={form.data_categories} onChange={v => set({ data_categories: v })} placeholder={t('compliance.dpia_q_data_ph', 'Names, e-mail addresses, case content…')} data-testid="dpia-q-data" />
            </Field>
            <Toggle checked={form.automated_decisions} onChange={v => set({ automated_decisions: v })}
                label={t('compliance.dpia_q_automated', 'Makes or supports automated decisions about people')} testId="dpia-q-automated" />
            <Field label={t('compliance.dpia_q_oversight', 'Human oversight')}>
                <TextInput value={form.human_oversight} onChange={v => set({ human_oversight: v })} placeholder={t('compliance.dpia_q_oversight_ph', 'Who checks the output, and when?')} data-testid="dpia-q-oversight" />
            </Field>
            <Field label={t('compliance.dpia_q_mitigations_short', 'Mitigations')} hint={t('compliance.dpia_q_mitigations_hint', 'One per line')}>
                <TextArea rows={3} value={form.mitigations} onChange={v => set({ mitigations: v })} placeholder={t('compliance.dpia_q_mitigations_ph', 'PII redaction before the model call')} data-testid="dpia-q-mitigations" />
            </Field>
            <Field label={t('compliance.dpia_q_risk', 'Residual risk')}>
                <Select value={form.risk_level} onChange={v => set({ risk_level: v })} data-testid="dpia-q-risk" options={[
                    { value: 'low', label: t('compliance.dpia_risk_low', 'Low') },
                    { value: 'medium', label: t('compliance.dpia_risk_medium', 'Medium') },
                    { value: 'high', label: t('compliance.dpia_risk_high', 'High') },
                ]} />
            </Field>
            <button type="button" onClick={onAttest} disabled={saving}
                title={t('compliance.dpia_attest_hint', 'You assessed this agent outside Bee Flow — record that attestation (valid 12 months).')}
                className="self-start p-0 border-0 bg-transparent text-[11px] text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] rounded"
                data-testid="dpia-attest">
                {t('compliance.dpia_attest_link', 'Assessed outside Bee Flow? Record an attestation')}
            </button>
        </div>
    );
}

export interface DpiaDrawerProps {
    row: DpiaRow;
    mode: DrawerMode;
    saving: boolean;
    pdfUrl: string | null;
    onSave: (agentId: string, body: Record<string, unknown>) => unknown;
    onClose: () => void;
}

export const DPIA_DRAWER_WIDTH = 420;

export default function DpiaDrawer({ row, mode, saving, pdfUrl, onSave, onClose }: DpiaDrawerProps) {
    const { t } = useTranslation();
    const onRecord = !!row.dpia;
    const detail = useResource<DpiaRecord>(onRecord ? `${API}/dpia/${encodeURIComponent(row.agentId)}` : null, {
        enabled: onRecord, parse: asRecord, onError: () => null,
    });
    const [reassessing, setReassessing] = useState(false);
    const [form, setForm] = useState<DpiaForm>(EMPTY_FORM);
    const set = (patch: Partial<DpiaForm>) => setForm(f => ({ ...f, ...patch }));
    const showForm = !row.dpia || reassessing;
    const ready = formReady(form);

    const reassess = () => { setForm(formFromRecord(detail.data || row.dpia)); setReassessing(true); };
    const submit = () => { if (ready) void onSave(row.agentId, questionnaireBody(form)); };
    const attest = () => { void onSave(row.agentId, { mode: 'attestation', risk_level: 'medium', expires_at: defaultExpiry() }); };
    const required = t('compliance.dpia_required', 'Fill in purpose, data and oversight to save');

    const footer = showForm ? (
        <div className="flex items-center gap-2 flex-wrap">
            <ActionButton variant="primary" disabled={saving || !ready} onClick={submit} title={ready ? undefined : required} data-testid="dpia-submit">
                {saving ? t('compliance.saving', 'Saving…') : t('compliance.dpia_submit', 'Save assessment')}
            </ActionButton>
            {reassessing && (
                <ActionButton disabled={saving} onClick={() => setReassessing(false)} data-testid="dpia-reassess-cancel">{t('common.cancel', 'Cancel')}</ActionButton>
            )}
            {!ready && <span className="text-[11px] text-[var(--text-tertiary)]" data-testid="dpia-required">{required}</span>}
        </div>
    ) : (
        <div className="flex items-center gap-2 flex-wrap">
            <ActionButton icon={RotateCcw} disabled={saving} onClick={reassess} data-testid="dpia-reassess">{t('compliance.dpia_reassess', 'Re-assess')}</ActionButton>
            {pdfUrl && (
                <a href={pdfUrl} download data-testid="dpia-pdf"
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-primary)] no-underline">
                    <FileDown size={13} aria-hidden="true" /> {t('compliance.dpia_download_pdf', 'Download PDF')}
                </a>
            )}
        </div>
    );

    return (
        <SideDrawer
            open
            onClose={onClose}
            mode={mode}
            width={DPIA_DRAWER_WIDTH}
            ariaLabel={row.agentName}
            testId="dpia-drawer"
            header={(
                <div className="flex flex-col gap-1 min-w-0">
                    <span className="text-sm font-bold text-[var(--text-primary)] truncate" title={row.agentId} data-testid="dpia-drawer-title">{row.agentName}</span>
                    {row.riskReason && <span className="text-[11px] text-[var(--text-tertiary)]">{row.riskReason}</span>}
                </div>
            )}
            footer={footer}
        >
            {showForm
                ? <Questionnaire form={form} set={set} onAttest={attest} saving={saving} />
                : <Summary dpia={row.dpia as DpiaRecord} record={detail.data} failed={detail.failed} />}
        </SideDrawer>
    );
}
