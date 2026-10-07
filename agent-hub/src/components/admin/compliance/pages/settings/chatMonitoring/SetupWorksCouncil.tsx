import React from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { DateInput, Field, Select, TextInput, Toggle } from './formAtoms';
import {
    EMPLOYEE_SURFACES, SIGNALS, WORKS_COUNCIL, WORKS_COUNCIL_REASONS, isEmployeeSurface,
    type WorksCouncil, type WorksCouncilReason,
} from './chatMonitoringForm';
import { signalLabel, surfaceLabel, worksCouncilLabel, worksCouncilReasonLabel } from './chatMonitoringLabels';
import { HINT_CLASS, SECTION_TITLE_CLASS, type SetupSectionProps } from './setupTypes';

/**
 * The works council: consent, replacement consent from the court, not
 * applicable (with the reason), or pending, which blocks the employee chat
 * types. A decision carries its date and what it covers; counting more than
 * that needs a newer decision.
 */

const hasDecision = (wc: string): boolean => wc === 'consent' || wc === 'court_replacement';
function flip<T extends string>(list: T[], item: T, on: boolean): T[] {
    const rest = list.filter((x) => x !== item);
    return on ? [...rest, item] : rest;
}

function Scope({ form, patch }: SetupSectionProps) {
    const { t } = useTranslation();
    return (
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-1.5" data-testid="cm-wc-scope">
            <legend className="text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]">
                {t('chat_monitoring.works_council_scope', 'What the consent covers')}
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
                {EMPLOYEE_SURFACES.map((id) => (
                    <Toggle
                        key={id}
                        testId={`cm-wc-scope-${id}`}
                        checked={form.scope_surfaces.includes(id)}
                        onChange={(on: boolean) => patch({ scope_surfaces: flip(form.scope_surfaces, id, on) })}
                        label={surfaceLabel(t, id)}
                    />
                ))}
                {SIGNALS.map((id) => (
                    <Toggle
                        key={id}
                        testId={`cm-wc-scope-signal-${id}`}
                        checked={form.scope_signals.includes(id)}
                        onChange={(on: boolean) => patch({ scope_signals: flip(form.scope_signals, id, on) })}
                        label={signalLabel(t, id)}
                    />
                ))}
            </div>
            <Field label={t('chat_monitoring.works_council_max_retention', 'Longest retention covered (days)')}>
                <TextInput type="number" min={30} max={90} value={form.scope_max_retention} onChange={(v: string) => patch({ scope_max_retention: v })} className="max-w-[120px]" data-testid="cm-wc-scope-retention" />
            </Field>
            <p className={HINT_CLASS}>{t('chat_monitoring.works_council_scope_hint', 'Counting more than this needs new consent with a new date.')}</p>
        </fieldset>
    );
}

function Reason({ form, patch }: SetupSectionProps) {
    const { t } = useTranslation();
    return (
        <>
            <Field label={t('chat_monitoring.works_council_reason_label', 'Why not applicable')}>
                <Select
                    value={form.works_council_reason}
                    onChange={(v: string) => patch({ works_council_reason: v as WorksCouncilReason | '' })}
                    options={[{ value: '', label: t('chat_monitoring.choose', 'Choose…') }, ...WORKS_COUNCIL_REASONS.map((id) => ({ value: id, label: worksCouncilReasonLabel(t, id) }))]}
                    data-testid="cm-wc-reason"
                />
            </Field>
            {form.works_council_reason === 'outside_nl' && (
                <p className={HINT_CLASS} data-testid="cm-wc-outside-nl">
                    {t('chat_monitoring.works_council_outside_nl_hint', 'Codetermination is then handled under the law that applies to you. It does not mean no consent is needed.')}
                </p>
            )}
        </>
    );
}

export default function SetupWorksCouncil(props: SetupSectionProps) {
    const { form, patch } = props;
    const { t } = useTranslation();
    const choose = (value: string) => {
        const wc = value as WorksCouncil | '';
        // A first decision covers what is selected now, unless a scope was already set.
        const seedScope = hasDecision(wc) && form.scope_surfaces.length === 0
            ? { scope_surfaces: form.surfaces.filter(isEmployeeSurface), scope_signals: form.signals, scope_max_retention: form.retention_days }
            : {};
        patch({ works_council: wc, ...seedScope });
    };
    return (
        <div className="flex flex-col gap-2" data-testid="cm-works-council">
            <h4 className={SECTION_TITLE_CLASS}>{t('chat_monitoring.works_council_label', 'Works council')}</h4>
            <Select
                value={form.works_council}
                onChange={choose}
                options={[{ value: '', label: t('chat_monitoring.choose', 'Choose…') }, ...WORKS_COUNCIL.map((id) => ({ value: id, label: worksCouncilLabel(t, id) }))]}
                aria-label={t('chat_monitoring.works_council_label', 'Works council')}
                className="max-w-[320px]"
                data-testid="cm-wc"
            />
            {form.works_council === 'pending' && (
                <p className="m-0 text-[11px] text-[var(--warning-ink)]" data-testid="cm-wc-pending">
                    {t('chat_monitoring.works_council_pending_hint', 'Employee chats cannot be counted while consent is pending (WOR art. 27(1)(l)).')}
                </p>
            )}
            {form.works_council === 'not_applicable' && <Reason {...props} />}
            {hasDecision(form.works_council) && (
                <>
                    <Field label={t('chat_monitoring.works_council_at', 'Date of the decision')}>
                        <DateInput value={form.works_council_at} onChange={(v: string) => patch({ works_council_at: v })} className="max-w-[180px]" data-testid="cm-wc-at" />
                    </Field>
                    <Scope {...props} />
                </>
            )}
            <p className={HINT_CLASS}>{t('chat_monitoring.works_council_headcount_hint', 'Whether this applies depends on how many people work in your enterprise, not on how many use Bee Flow.')}</p>
        </div>
    );
}
