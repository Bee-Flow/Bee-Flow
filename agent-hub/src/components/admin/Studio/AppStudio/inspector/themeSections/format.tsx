import { useId, useMemo } from 'react';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import { inputCls } from '@/components/admin/product-website/fields';
import { cleanAppFormat, cleanCurrency, cleanLanguage, cleanTimeZone, DATE_STYLES } from '@shared/format/formatClean.mjs';
import { formatContext, formatDate, formatNumber } from '@shared/format/valueFormat.mjs';
import { SectionTitle } from '../AiBrowsingSettings';
import { DraftField, DecimalsSelect, cleanPatternText, patternHint } from '../panels/FormatOptionsFields';
import type { ThemeSectionEntry, ThemeSectionProps } from '../themeSections';
import type { AppDefinition } from '../appDefinition';

/**
 * App settings: "Value format" — definition.format (schema 3), how the whole app writes numbers,
 * amounts and dates. Every field starts empty and empty keeps each reader's own setting; a
 * definition whose format is emptied loses the key, so it is byte for byte what it was.
 */

type Obj = Record<string, unknown>;

const LANGUAGE_SUGGESTIONS = ['en-US', 'en-GB', 'nl-NL', 'nl-BE', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'pt-PT', 'pl-PL', 'sv-SE', 'da-DK', 'nb-NO', 'fi-FI'];
const SAMPLE_MOMENT = '2026-07-04T14:30:00Z';

/** The next definition with `format` cleaned, or without the key when nothing is left. */
export function withAppFormat(definition: AppDefinition, next: Obj): AppDefinition {
    const cleaned = cleanAppFormat(next);
    const { format: _drop, ...rest } = definition;
    return (cleaned ? { ...rest, format: cleaned } : rest) as AppDefinition;
}

function timeZones(): string[] {
    try {
        // Older engines (and some test environments) have no supportedValuesOf: no suggestions then.
        return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    } catch {
        return [];
    }
}

/** One line showing what the current settings write. */
function sampleLine(format: Obj) {
    const ctx = formatContext(format);
    return `${formatNumber(1234.5, 'currency', ctx)} · ${formatNumber(1234567.891, 'number', ctx)} · ${formatDate(SAMPLE_MOMENT, 'datetime', ctx) ?? ''}`;
}

function styleLabels(t: TranslateFn): Record<string, string> {
    return {
        short: t('studio_apps_format.date_short', 'Short'),
        medium: t('studio_apps_format.date_medium', 'Medium'),
        long: t('studio_apps_format.date_long', 'Long'),
        full: t('studio_apps_format.date_full', 'Full'),
    };
}

function DateFormatField({ t, value, onCommit, disabled }: { t: TranslateFn; value: unknown; onCommit: (v: unknown) => void; disabled: boolean }) {
    const isStyle = typeof value === 'string' && DATE_STYLES.includes(value);
    const isPattern = typeof value === 'string' && !isStyle;
    const labels = styleLabels(t);
    const text = t('studio_apps_format.date_format', 'Dates');
    return (
        <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
                <span>{text}</span>
                <select
                    className={inputCls}
                    value={isPattern ? 'pattern' : (isStyle ? String(value) : '')}
                    onChange={(e) => onCommit(e.target.value === 'pattern' ? 'dd-MM-yyyy' : (e.target.value || undefined))}
                    aria-label={text}
                    disabled={disabled}
                >
                    <option value="">{t('studio_apps_format.date_default', 'Reader’s own')}</option>
                    {DATE_STYLES.map((s) => <option key={s} value={s}>{labels[s]}</option>)}
                    <option value="pattern">{t('studio_apps_format.date_pattern', 'Own pattern')}</option>
                </select>
            </label>
            {isPattern ? (
                <DraftField
                    label={t('studio_apps_format.pattern', 'Date pattern')}
                    value={value}
                    clean={cleanPatternText}
                    onCommit={(v) => onCommit(v)}
                    placeholder={t('studio_apps_format.pattern_placeholder', 'dd-MM-yyyy')}
                    hint={patternHint(t)}
                    invalidText={t('studio_apps_format.pattern_invalid', 'A letter here is not a date part. Put text in single quotes.')}
                    disabled={disabled}
                />
            ) : null}
        </div>
    );
}

function FormatSection({ definition, onCommit, disabled }: ThemeSectionProps) {
    const { t } = useTranslation();
    const format: Obj = definition?.format && typeof definition.format === 'object' && !Array.isArray(definition.format) ? definition.format as Obj : {};
    const zones = useMemo(() => timeZones(), []);
    const listId = useId();
    const set = (key: string, value: unknown) => {
        const next: Obj = { ...format, [key]: value };
        if (value === undefined) delete next[key];
        onCommit(withAppFormat(definition, next));
    };
    return (
        <div data-theme-section="format">
            <SectionTitle>{t('studio_apps_format.title', 'Value format')}</SectionTitle>
            <div className="flex flex-col gap-3">
                <p className="text-xs text-[var(--text-muted)]">
                    {t('studio_apps_format.hint', 'How numbers, amounts and dates read in this app. Leave a field empty to keep each reader’s own setting.')}
                </p>
                <datalist id={`${listId}-languages`}>{LANGUAGE_SUGGESTIONS.map((l) => <option key={l} value={l} />)}</datalist>
                <datalist id={`${listId}-zones`}>{zones.map((z) => <option key={z} value={z} />)}</datalist>
                <DraftField
                    label={t('studio_apps_format.language', 'Language')}
                    value={format.language}
                    clean={cleanLanguage}
                    onCommit={(v) => set('language', v)}
                    placeholder={t('studio_apps_format.language_placeholder', 'Reader’s browser, e.g. en-US')}
                    invalidText={t('studio_apps_format.language_invalid', 'Not a language tag. Use one like en-US or nl-NL.')}
                    listId={`${listId}-languages`}
                    disabled={disabled}
                />
                <div className="grid grid-cols-2 gap-2">
                    <DraftField
                        label={t('studio_apps_format.currency', 'Currency')}
                        value={format.currency}
                        clean={cleanCurrency}
                        onCommit={(v) => set('currency', v)}
                        placeholder={t('studio_apps_format.currency_example', 'EUR')}
                        invalidText={t('studio_apps_format.currency_invalid', 'Use a three-letter code such as USD.')}
                        disabled={disabled}
                    />
                    <DecimalsSelect t={t} label={t('studio_apps_format.currency_decimals', 'Decimals in amounts')} value={format.currencyDecimals} onChange={(v) => set('currencyDecimals', v)} disabled={disabled} />
                </div>
                <DateFormatField t={t} value={format.dateFormat} onCommit={(v) => set('dateFormat', v)} disabled={disabled} />
                <DraftField
                    label={t('studio_apps_format.time_zone', 'Time zone')}
                    value={format.timeZone}
                    clean={cleanTimeZone}
                    onCommit={(v) => set('timeZone', v)}
                    placeholder={t('studio_apps_format.time_zone_placeholder', 'Reader’s clock, e.g. Europe/Amsterdam')}
                    invalidText={t('studio_apps_format.time_zone_invalid', 'Not a time zone this browser knows.')}
                    listId={`${listId}-zones`}
                    disabled={disabled}
                />
                <p className="text-xs text-[var(--text-secondary)] tabular-nums" data-app-format-sample="true">
                    {t('studio_apps_format.sample', 'Reads as: {text}', { text: sampleLine(format) })}
                </p>
            </div>
        </div>
    );
}

const entry: ThemeSectionEntry = { order: 40, Section: FormatSection };
export default entry;
