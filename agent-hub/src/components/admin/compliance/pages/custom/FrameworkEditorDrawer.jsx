import React, { useEffect, useState } from 'react';
import { Archive, Save } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import SideDrawer, { DrawerSection } from '../../../../shared/SideDrawer';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { TONES } from '../../../../shared/statusTone';

/**
 * FrameworkEditorDrawer — create or edit one org-defined framework
 * (`POST /custom/frameworks`, `PUT /custom/frameworks/:id`,
 * `DELETE /custom/frameworks/:id` = archive).
 *
 * The CODE is the framework's identity: it is part of every result row id
 * (`CUSTOM-<CODE>-<REF>`), so the server refuses to change it after creation
 * and the field is read-only in edit mode — renaming it would orphan the whole
 * history rather than move it.
 */

export const CODE_RE = /^[A-Z0-9_]{2,24}$/;
export const STATUSES = Object.freeze(['draft', 'active']);

/** Pure: what the user typed, shaped as the server expects it. */
export function toBody(form, { isNew }) {
    const body = {
        name: form.name.trim(),
        reference: form.reference.trim() || null,
        description: form.description.trim() || null,
        attestation_valid_months: form.evergreen ? null : Number(form.months),
        status: form.status,
    };
    if (isNew) body.code = form.code.trim().toUpperCase();
    return body;
}

/** Pure: the first thing wrong with the form, or null. */
export function validate(form, { isNew }) {
    if (!form.name.trim()) return 'name';
    if (isNew && !CODE_RE.test(form.code.trim().toUpperCase())) return 'code';
    if (!form.evergreen) {
        const n = Number(form.months);
        if (!Number.isInteger(n) || n < 1 || n > 120) return 'months';
    }
    return null;
}

/** What the FORM refuses, before anything is sent. */
const ERROR_COPY = Object.freeze({
    name: { key: 'compliance.custom_err_name', fallback: 'Give the framework a name.' },
    code: { key: 'compliance.custom_err_code', fallback: 'A code is 2–24 characters: capitals, digits and _.' },
    months: { key: 'compliance.custom_err_months', fallback: 'Validity is a whole number of months, 1–120.' },
});

/**
 * What the ROUTE refuses. Longest code first: `custom_framework_code_taken`
 * contains `code`, so a plain "first key that appears in the message" walk over
 * one merged table would answer with the wrong sentence.
 */
const SERVER_ERRORS = Object.freeze([
    ['custom_framework_code_taken', { key: 'compliance.custom_err_code_taken', fallback: 'That code is already in use.' }],
    ['custom_framework_code_invalid', { key: 'compliance.custom_err_code', fallback: 'A code is 2–24 characters: capitals, digits and _.' }],
    ['feature_locked', { key: 'compliance.custom_err_locked', fallback: 'Own frameworks are not included in your plan.' }],
]);

export function editorErrorText(err, t) {
    const raw = String(typeof err === 'string' ? err : (err?.code || err?.error || err?.message || ''));
    for (const [code, copy] of SERVER_ERRORS) {
        if (raw.includes(code)) return t(copy.key, copy.fallback);
    }
    return t('compliance.custom_err_save', 'The framework could not be saved.');
}

const FIELD = 'w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]';
const SECONDARY_BUTTON = 'inline-flex items-center gap-1 px-[9px] py-1 rounded-lg border border-[var(--border-default)] text-[12px] font-medium text-[var(--text-primary)] bg-[var(--bg-card)] disabled:opacity-60';

const blank = { name: '', code: '', reference: '', description: '', months: '12', evergreen: false, status: 'draft' };

function formOf(framework) {
    if (!framework) return { ...blank };
    const months = framework.attestation_valid_months;
    return {
        name: framework.name || '',
        code: framework.code || '',
        reference: framework.reference || '',
        description: framework.description || '',
        months: months === null || months === undefined ? '12' : String(months),
        evergreen: months === null,
        status: framework.status === 'active' ? 'active' : 'draft',
    };
}

export default function FrameworkEditorDrawer({
    open = false,
    framework = null,
    onClose,
    onSave,
    onArchive = null,
    busy = false,
    mode = 'overlay',
    width = 400,
    testId = 'custom-editor',
}) {
    const { t } = useTranslation();
    const isNew = !framework?.id;
    const [form, setForm] = useState(() => formOf(framework));
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => { if (open) { setForm(formOf(framework)); setError(null); } }, [open, framework]);

    const set = (key) => (e) => {
        const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
        setForm(prev => ({ ...prev, [key]: value }));
    };

    const submit = async () => {
        const problem = validate(form, { isNew });
        if (problem) { setError(t(ERROR_COPY[problem].key, ERROR_COPY[problem].fallback)); return; }
        setSaving(true);
        setError(null);
        try {
            await onSave?.(toBody(form, { isNew }), framework || null);
            onClose?.();
        } catch (e) {
            setError(editorErrorText(e, t));
        } finally {
            setSaving(false);
        }
    };

    const working = saving || busy;

    return (
        <SideDrawer
            open={open}
            onClose={onClose}
            mode={mode}
            width={width}
            testId={testId}
            ariaLabel={isNew ? t('compliance.custom_new_title', 'New framework') : t('compliance.custom_edit_title', 'Edit framework')}
            header={(
                <span className="font-semibold text-[13px]" data-testid={`${testId}-title`}>
                    {isNew ? t('compliance.custom_new_title', 'New framework') : t('compliance.custom_edit_title', 'Edit framework')}
                </span>
            )}
            footer={(
                <div className="flex items-center gap-2 flex-wrap">
                    {error && <span className="text-[11px] font-medium w-full" style={{ color: TONES.error.ink }} data-testid={`${testId}-error`}>{error}</span>}
                    {!isNew && onArchive && (
                        <button type="button" className={SECONDARY_BUTTON} onClick={() => onArchive(framework)} disabled={working} data-testid={`${testId}-archive`}>
                            <Archive size={12} aria-hidden="true" />{t('compliance.custom_archive', 'Archive')}
                        </button>
                    )}
                    <button type="button" className={`ml-auto ${SECONDARY_BUTTON}`} onClick={onClose} disabled={saving}>
                        {t('common.cancel', 'Cancel')}
                    </button>
                    <button
                        type="button"
                        className="inline-flex items-center gap-1 px-[9px] py-1 rounded-lg text-[12px] font-semibold disabled:opacity-60"
                        style={PRIMARY_ACTION_STYLE}
                        onClick={submit}
                        disabled={working}
                        data-testid={`${testId}-save`}
                    >
                        <Save size={12} aria-hidden="true" />{t('common.save', 'Save')}
                    </button>
                </div>
            )}
        >
            <DrawerSection label={t('compliance.custom_field_name', 'Name')}>
                <input className={FIELD} value={form.name} onChange={set('name')} data-testid={`${testId}-name`}
                    placeholder={t('compliance.custom_field_name_ph', "Customer NIS2 questionnaire 2026")} />
            </DrawerSection>

            <DrawerSection
                label={t('compliance.custom_field_code', 'Code')}
                hint={isNew ? t('compliance.custom_field_code_hint', 'capitals, digits and _ — fixed once saved') : t('compliance.custom_field_code_locked', 'part of every result id, cannot change')}
            >
                <input
                    className={`${FIELD} font-mono uppercase disabled:opacity-60`}
                    value={form.code}
                    onChange={set('code')}
                    disabled={!isNew}
                    readOnly={!isNew}
                    data-testid={`${testId}-code`}
                    placeholder="NIS2_KLANT"
                />
            </DrawerSection>

            <DrawerSection label={t('compliance.custom_field_reference', 'Reference')} hint={t('compliance.custom_field_reference_hint', 'the standard or contract this comes from')}>
                <input className={FIELD} value={form.reference} onChange={set('reference')} data-testid={`${testId}-reference`} />
            </DrawerSection>

            <DrawerSection label={t('compliance.custom_field_description', 'Description')}>
                <textarea className={FIELD} rows={3} value={form.description} onChange={set('description')} data-testid={`${testId}-description`} />
            </DrawerSection>

            <DrawerSection label={t('compliance.custom_field_months', 'Attestation valid for')} hint={t('compliance.custom_field_months_hint', 'after this, an item asks to be attested again')}>
                <div className="flex items-center gap-2 flex-wrap">
                    <input
                        className={`${FIELD} w-24 disabled:opacity-60`}
                        type="number"
                        min="1"
                        max="120"
                        value={form.months}
                        onChange={set('months')}
                        disabled={form.evergreen}
                        data-testid={`${testId}-months`}
                    />
                    <span className="text-[11px] text-[var(--text-secondary)]">{t('compliance.custom_field_months_unit', 'months')}</span>
                    <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] ml-auto">
                        <input type="checkbox" checked={form.evergreen} onChange={set('evergreen')} data-testid={`${testId}-evergreen`} />
                        {t('compliance.custom_field_evergreen', 'does not expire')}
                    </label>
                </div>
            </DrawerSection>

            <DrawerSection label={t('compliance.custom_field_status', 'Status')} hint={t('compliance.custom_field_status_hint', 'only an active framework is scored')}>
                <select className={FIELD} value={form.status} onChange={set('status')} data-testid={`${testId}-status`}
                    aria-label={t('compliance.custom_field_status', 'Status')}>
                    {STATUSES.map(s => (
                        <option key={s} value={s}>{t(`compliance.custom_status_fw_${s}`, s === 'active' ? 'Active' : 'Draft')}</option>
                    ))}
                </select>
            </DrawerSection>
        </SideDrawer>
    );
}
