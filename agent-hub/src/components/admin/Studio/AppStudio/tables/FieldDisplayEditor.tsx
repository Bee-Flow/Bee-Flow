import useTranslation from '@/hooks/useTranslation';
import { NumberField, SelectField, TextField } from '../inspector/panels/kit';
import { COMMON_CURRENCIES, DATE_STYLES, DISPLAY_BY_TYPE, TEXT_FORMATS, displayOf, withDisplay, withFormat } from './fieldDisplay';
import type { ModelField } from './tablesManagerModel';

/**
 * The schema-3 parts of one field in the table editor: the kind of text a text field holds
 * (field.format, checked on every write), how a number or a date is meant to be shown
 * (field.display: stored and validated; the runtime cells do not read it yet, the hint says so),
 * and one line on what an autonumber, json or user field is. A field type without any of these
 * shows nothing.
 */

interface Props {
    field: ModelField;
    update: (next: ModelField) => void;
    disabled: boolean;
}

function FormatPicker({ field, update, disabled }: Props) {
    const { t } = useTranslation();
    const labels: Record<string, string> = {
        email: t('studio_apps_fieldtypes.format_email', 'E-mail address'),
        url: t('studio_apps_fieldtypes.format_url', 'Web address'),
        phone: t('studio_apps_fieldtypes.format_phone', 'Phone number'),
    };
    return (
        <SelectField
            label={t('studio_apps_fieldtypes.format', 'Kind of text')}
            value={typeof field.format === 'string' ? field.format : ''}
            onChange={(v) => update(withFormat(field, v || null))}
            options={[
                { value: '', label: t('studio_apps_fieldtypes.format_none', 'Any text') },
                ...TEXT_FORMATS.map((f) => ({ value: f, label: labels[f] })),
            ]}
            hint={t('studio_apps_fieldtypes.format_hint', 'Every value saved in this field is checked.')}
            disabled={disabled}
        />
    );
}

function NumberDisplay({ field, update, disabled }: Props) {
    const { t } = useTranslation();
    const d = displayOf(field);
    const currencies = [...COMMON_CURRENCIES, ...(d.currency && !(COMMON_CURRENCIES as readonly string[]).includes(d.currency) ? [d.currency] : [])];
    return (
        <div className="grid grid-cols-3 gap-2">
            <SelectField
                label={t('studio_apps_fieldtypes.currency', 'Currency')}
                value={d.currency ?? ''}
                onChange={(v) => update(withDisplay(field, 'currency', v || null))}
                options={[{ value: '', label: t('studio_apps_fieldtypes.currency_none', 'None') }, ...currencies.map((c) => ({ value: c, label: c }))]}
                disabled={disabled}
            />
            <NumberField label={t('studio_apps_fieldtypes.decimals', 'Decimals')} value={d.decimals ?? null} step={1}
                onChange={(n) => update(withDisplay(field, 'decimals', n === null ? null : Math.max(0, Math.min(10, Math.round(n)))))} disabled={disabled} />
            <TextField label={t('studio_apps_fieldtypes.unit', 'Unit')} value={d.unit ?? ''} placeholder={t('studio_apps_fieldtypes.unit_placeholder', 'kg')}
                onChange={(v) => update(withDisplay(field, 'unit', v.slice(0, 16) || null))} disabled={disabled} />
        </div>
    );
}

function DateDisplay({ field, update, disabled }: Props) {
    const { t } = useTranslation();
    const labels: Record<string, string> = {
        short: t('studio_apps_fieldtypes.date_short', 'Short'),
        medium: t('studio_apps_fieldtypes.date_medium', 'Medium'),
        long: t('studio_apps_fieldtypes.date_long', 'Long'),
        full: t('studio_apps_fieldtypes.date_full', 'Full, with the weekday'),
    };
    return (
        <SelectField
            label={t('studio_apps_fieldtypes.date_style', 'Date style')}
            value={displayOf(field).dateStyle ?? ''}
            onChange={(v) => update(withDisplay(field, 'dateStyle', v || null))}
            options={[{ value: '', label: t('studio_apps_fieldtypes.date_default', 'Default') }, ...DATE_STYLES.map((s) => ({ value: s, label: labels[s] }))]}
            disabled={disabled}
        />
    );
}

function TypeNote({ type }: { type: string }) {
    const { t } = useTranslation();
    const notes: Record<string, string> = {
        autonumber: t('studio_apps_fieldtypes.autonumber_hint', 'Numbered by the app: 1, 2, 3 … in the order records are created. Rows that already exist are numbered when you save.'),
        json: t('studio_apps_fieldtypes.json_hint', 'Holds a JSON value. Text saved in this field must be valid JSON.'),
        user: t('studio_apps_fieldtypes.user_hint', 'Holds the user id of a member of the organisation.'),
    };
    return notes[type] ? <span className="text-[11px] text-[var(--text-tertiary)]">{notes[type]}</span> : null;
}

export default function FieldDisplayEditor({ field, update, disabled }: Props) {
    const { t } = useTranslation();
    const type = field.type || 'text';
    const keys = DISPLAY_BY_TYPE[type] || [];
    return (
        <>
            <TypeNote type={type} />
            {type === 'text' ? <FormatPicker field={field} update={update} disabled={disabled} /> : null}
            {keys.length ? (
                <fieldset className="flex flex-col gap-2 rounded-md border border-[var(--border-default)] p-2" data-field-display="true">
                    <legend className="px-1 text-xs font-medium text-[var(--text-secondary)]">{t('studio_apps_fieldtypes.display_heading', 'Display')}</legend>
                    <span className="text-[11px] text-[var(--text-tertiary)]">{t('studio_apps_fieldtypes.display_hint', 'Saved with the field to say how its value is meant to be shown. Grids and tables do not apply it yet, and the stored value never changes.')}</span>
                    {keys.includes('dateStyle')
                        ? <DateDisplay field={field} update={update} disabled={disabled} />
                        : <NumberDisplay field={field} update={update} disabled={disabled} />}
                </fieldset>
            ) : null}
        </>
    );
}
