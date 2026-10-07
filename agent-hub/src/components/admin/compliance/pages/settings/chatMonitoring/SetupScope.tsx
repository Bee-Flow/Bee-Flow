import React from 'react';
import { useTranslation, type TranslateFn } from '../../../../../../hooks/useTranslation';
import { Field, TextInput, Toggle } from './formAtoms';
import { LEGAL_BASES, SURFACES, isEmployeeSurface, type LegalBasis, type Surface } from './chatMonitoringForm';
import { bandLabel, legalBasisLabel, populationLabel, surfaceHint, surfaceLabel } from './chatMonitoringLabels';
import { HINT_CLASS, SECTION_CLASS, SECTION_TITLE_CLASS, type SetupSectionProps } from './setupTypes';

/**
 * The first part of the set-up form: where to count, what to count, on
 * which legal basis, and for how long. Each employee chat type shows how
 * many people used it in the last four weeks, as a band, so a small group
 * is visible before anything is switched on.
 */

const TAG_CLASS = 'ml-1.5 inline-flex rounded-full border border-[var(--border-default)] px-1.5 text-[10px] font-medium text-[var(--text-tertiary)]';
const isSurface = (id: string): id is Surface => (SURFACES as readonly string[]).includes(id);

function SurfaceHint({ t, id, band }: { t: TranslateFn; id: string; band: string | null }) {
    const words = bandLabel(t, band);
    return (
        <>
            {surfaceHint(t, id)}
            {words && isEmployeeSurface(id) && (
                <span className="block" data-testid={`cm-contributors-${id}`}>
                    {t('chat_monitoring.contributors', '{band} active people in the last 4 weeks', { band: words })}
                </span>
            )}
        </>
    );
}

function Surfaces({ form, patch, config }: SetupSectionProps) {
    const { t } = useTranslation();
    const toggle = (id: Surface, on: boolean) => patch({ surfaces: on ? [...form.surfaces, id] : form.surfaces.filter((s) => s !== id) });
    return (
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-1.5" data-testid="cm-surfaces">
            <legend className={SECTION_TITLE_CLASS}>{t('chat_monitoring.surfaces_label', 'Where to count')}</legend>
            {config.catalogue.surfaces.map((s) => {
                const usable = s.available && isSurface(s.id);
                const label = (
                    <>
                        {surfaceLabel(t, s.id)}
                        <span className={TAG_CLASS}>{usable ? populationLabel(t, s.population) : t('chat_monitoring.surface.coming', 'Coming later')}</span>
                    </>
                );
                return (
                    <Toggle
                        key={s.id}
                        testId={`cm-surface-${s.id}`}
                        checked={usable && form.surfaces.includes(s.id as Surface)}
                        disabled={!usable}
                        onChange={(on: boolean) => usable && toggle(s.id as Surface, on)}
                        label={label}
                        hint={usable ? <SurfaceHint t={t} id={s.id} band={config.contributors[s.id] ?? null} /> : null}
                    />
                );
            })}
        </fieldset>
    );
}

function Signals({ form, patch }: SetupSectionProps) {
    const { t } = useTranslation();
    return (
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-1.5" data-testid="cm-signals">
            <legend className={SECTION_TITLE_CLASS}>{t('chat_monitoring.signals_label', 'What to count')}</legend>
            <Toggle
                testId="cm-signal-outcomes"
                checked
                disabled
                onChange={() => undefined}
                label={t('chat_monitoring.signal.outcomes', 'Privacy Shield outcomes')}
                hint={t('chat_monitoring.signal.outcomes_hint', 'Clean, protected, blocked, sent anyway, scan failed, not scanned. Always on.')}
            />
            <Toggle
                testId="cm-signal-kinds"
                checked={form.signals.includes('kinds')}
                onChange={(on: boolean) => patch({ signals: on ? ['outcomes', 'kinds'] : ['outcomes'] })}
                label={t('chat_monitoring.signal.kinds', 'Kinds of personal data')}
                hint={t('chat_monitoring.signal.kinds_hint', 'Which kinds were found, such as names, e-mail addresses or identification numbers, never the values. Health data is never counted.')}
            />
        </fieldset>
    );
}

function LegalBasisChoice({ form, patch }: SetupSectionProps) {
    const { t } = useTranslation();
    return (
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-1.5" data-testid="cm-legal-basis">
            <legend className={SECTION_TITLE_CLASS}>{t('chat_monitoring.legal_basis_label', 'Legal basis')}</legend>
            {LEGAL_BASES.map((id) => (
                <label key={id} className="flex items-center gap-2 text-xs cursor-pointer text-[var(--text-primary)]">
                    <input
                        type="radio"
                        name="cm-legal-basis"
                        value={id}
                        checked={form.legal_basis === id}
                        onChange={() => patch({ legal_basis: id as LegalBasis })}
                        data-testid={`cm-basis-${id}`}
                    />
                    <span>{legalBasisLabel(t, id)}</span>
                </label>
            ))}
            <p className={HINT_CLASS}>{t('chat_monitoring.legal_basis_hint', 'Public bodies cannot rely on legitimate interest for their tasks.')}</p>
            {form.legal_basis === 'art6_1_f' && (
                <Toggle
                    testId="cm-ack-lia"
                    checked={form.ack_lia_documented}
                    onChange={(on: boolean) => patch({ ack_lia_documented: on })}
                    label={t('chat_monitoring.ack_lia', 'We documented the legitimate-interest assessment (the balancing test).')}
                />
            )}
        </fieldset>
    );
}

export function Retention({ form, patch, config }: SetupSectionProps) {
    const { t } = useTranslation();
    const { min, max } = config.catalogue.retention;
    return (
        <div className={SECTION_CLASS}>
            <Field label={t('chat_monitoring.retention_days', 'Keep the counts for (days)')} hint={t('chat_monitoring.retention_hint', '30 to 90 days. Whole weeks are deleted once they are older.')}>
                <TextInput
                    type="number"
                    min={min}
                    max={max}
                    step={1}
                    value={form.retention_days}
                    onChange={(v: string) => patch({ retention_days: v })}
                    className="max-w-[120px]"
                    data-testid="cm-retention"
                />
            </Field>
        </div>
    );
}

export default function SetupScope(props: SetupSectionProps) {
    return (
        <div className="flex flex-col gap-3">
            <Surfaces {...props} />
            <Signals {...props} />
            <LegalBasisChoice {...props} />
        </div>
    );
}
