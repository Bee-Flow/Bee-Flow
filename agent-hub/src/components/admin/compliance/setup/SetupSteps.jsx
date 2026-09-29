import React from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import UserPicker from '../shared/UserPicker';

/**
 * The four setup step bodies + validation, extracted from the legacy
 * OnboardingWizard (PLAN-FRONTEND C13). No shell, no modal, no footer: the
 * SetupCard renders one body inline and owns navigation and saving.
 *
 * Step data is one flat object (the wizard's `data`), see `initialSetupData`.
 */

export const LEGAL_BASES = [
    { id: 'consent', labelKey: 'compliance.lb_consent' },
    { id: 'contract', labelKey: 'compliance.lb_contract' },
    { id: 'legal_obligation', labelKey: 'compliance.lb_legal_obligation' },
    { id: 'vital_interests', labelKey: 'compliance.lb_vital_interests' },
    { id: 'public_task', labelKey: 'compliance.lb_public_task' },
    { id: 'legitimate_interests', labelKey: 'compliance.lb_legitimate_interests' },
];

// The wizard step keys are reused (compliance.wizard_step_<key> + _desc exist).
export const SETUP_STEPS = [
    { key: 'dpo', titleKey: 'compliance.wizard_step_dpo', fields: ['dpo_name', 'dpo_email', 'dpo_phone'] },
    { key: 'legal', titleKey: 'compliance.wizard_step_legal', fields: ['legal_bases'] },
    { key: 'residency', titleKey: 'compliance.wizard_step_residency', fields: ['data_residency', 'default_retention_days', 'privacy_notice_url'] },
    { key: 'breach', titleKey: 'compliance.wizard_step_breach', fields: ['breach_recipients'] },
];

export const SETUP_STEP_COUNT = SETUP_STEPS.length;

export function initialSetupData(settings) {
    return {
        dpo_name: settings?.dpo_name || '',
        dpo_email: settings?.dpo_email || '',
        dpo_phone: settings?.dpo_phone || '',
        legal_bases: Array.isArray(settings?.legal_bases) && settings.legal_bases.length
            ? settings.legal_bases : ['contract', 'legitimate_interests'],
        data_residency: settings?.data_residency || 'eu',
        default_retention_days: settings?.default_retention_days ?? 365,
        privacy_notice_url: settings?.privacy_notice_url || '',
        breach_recipients: Array.isArray(settings?.breach_recipients) ? settings.breach_recipients : [],
        newRecipient: '',
    };
}

/**
 * Merge an auto-detect result into the step data. Only fields the org has
 * never saved are touched — a stored setting always wins. Returns the patch
 * and the list of fields it filled (so tiles can say "from …").
 */
export function applyAutoDetect(detected, stored) {
    const patch = {};
    const hit = [];
    if (!detected || typeof detected !== 'object') return { patch, hit };
    if (!(stored?.legal_bases?.length) && Array.isArray(detected.legal_bases) && detected.legal_bases.length) {
        patch.legal_bases = detected.legal_bases; hit.push('legal_bases');
    }
    if (!stored?.data_residency && detected.data_residency) {
        patch.data_residency = detected.data_residency; hit.push('data_residency');
    }
    if (stored?.default_retention_days == null && detected.default_retention_days != null) {
        patch.default_retention_days = detected.default_retention_days; hit.push('default_retention_days');
    }
    if (!stored?.privacy_notice_url && detected.privacy_notice_url) {
        patch.privacy_notice_url = detected.privacy_notice_url; hit.push('privacy_notice_url');
    }
    if (!(stored?.breach_recipients?.length) && Array.isArray(detected.breach_recipients) && detected.breach_recipients.length) {
        patch.breach_recipients = detected.breach_recipients; hit.push('breach_recipients');
    }
    // DPO is never auto-detected, but "from Organisation details" style hints
    // may arrive as dpo_* on the detect payload; only fill when nothing stored.
    if (!stored?.dpo_email && detected.dpo_email && /@/.test(detected.dpo_email)) {
        patch.dpo_email = detected.dpo_email; hit.push('dpo_email');
        if (!stored?.dpo_name && detected.dpo_name) { patch.dpo_name = detected.dpo_name; hit.push('dpo_name'); }
    }
    return { patch, hit };
}

/** Validation per step (the wizard's canNext). Steps 2 and 3 are always valid. */
export function canProceed(stepIndex, data) {
    if (stepIndex === 0) return !!(data?.dpo_email && /@/.test(data.dpo_email) && data?.dpo_name);
    if (stepIndex === 1) return Array.isArray(data?.legal_bases) && data.legal_bases.length > 0;
    return true;
}

/** True when a step already holds a complete answer (used for "done" tiles before the user visits it). */
export function stepIsComplete(stepIndex, data) {
    if (stepIndex === 0 || stepIndex === 1) return canProceed(stepIndex, data);
    if (stepIndex === 2) return !!data?.data_residency;
    if (stepIndex === 3) return Array.isArray(data?.breach_recipients) && data.breach_recipients.length > 0;
    return false;
}

/** First step that is not complete (0-based); SETUP_STEP_COUNT when all are. */
export function firstOpenStep(data) {
    for (let i = 0; i < SETUP_STEPS.length; i += 1) if (!stepIsComplete(i, data)) return i;
    return SETUP_STEPS.length;
}

/** The body finishSetup(body) receives — an explicit allow-list, never the raw form state. */
export function setupBody(data) {
    return {
        dpo_name: data.dpo_name,
        dpo_email: data.dpo_email,
        dpo_phone: data.dpo_phone,
        legal_bases: data.legal_bases,
        data_residency: data.data_residency,
        default_retention_days: data.default_retention_days !== '' && data.default_retention_days != null
            ? Number(data.default_retention_days) : null,
        privacy_notice_url: data.privacy_notice_url,
        breach_recipients: data.breach_recipients,
    };
}

const INPUT = 'w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--kind-compliance)]';

function Field({ label, children }) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-[.08em] text-[var(--text-tertiary)]">{label}</span>
            {children}
        </label>
    );
}

/**
 * One step's body. `step` = index 0..3 (or a SETUP_STEPS record).
 * `onChange(patch)` merges into the flat data object.
 */
export default function SetupStepBody({ step, data, onChange, orgUsers = null, testId = 'setup-step' }) {
    const { t } = useTranslation();
    const index = typeof step === 'number' ? step : SETUP_STEPS.findIndex(s => s.key === step?.key);
    const update = (patch) => onChange?.(patch);
    const recipients = Array.isArray(data?.breach_recipients) ? data.breach_recipients : [];
    const bases = Array.isArray(data?.legal_bases) ? data.legal_bases : [];

    const addRecipient = () => {
        const v = String(data?.newRecipient || '').trim();
        if (!v) return;
        if (recipients.includes(v)) { update({ newRecipient: '' }); return; }
        update({ breach_recipients: [...recipients, v], newRecipient: '' });
    };

    if (index === 0) {
        return (
            <div className="flex flex-col gap-3" data-testid={`${testId}-dpo`}>
                <UserPicker
                    users={orgUsers}
                    mode="single"
                    label={t('compliance.pick_org_user', 'Pick from your organisation')}
                    placeholder={t('compliance.pick_org_user_placeholder', 'Search by name or e-mail')}
                    onSelect={u => update({ dpo_name: u.displayName, dpo_email: u.email || '', dpo_phone: u.phone || '' })}
                />
                <Field label={t('compliance.dpo_name', 'Name')}>
                    <input value={data?.dpo_name || ''} onChange={e => update({ dpo_name: e.target.value })} className={INPUT} autoFocus data-testid={`${testId}-dpo-name`} />
                </Field>
                <Field label={t('compliance.dpo_email', 'E-mail')}>
                    <input type="email" value={data?.dpo_email || ''} onChange={e => update({ dpo_email: e.target.value })} className={INPUT} data-testid={`${testId}-dpo-email`} />
                </Field>
                <Field label={t('compliance.dpo_phone', 'Phone')}>
                    <input value={data?.dpo_phone || ''} onChange={e => update({ dpo_phone: e.target.value })} className={INPUT} />
                </Field>
            </div>
        );
    }

    if (index === 1) {
        return (
            <div className="flex flex-wrap gap-2" data-testid={`${testId}-legal`} role="group" aria-label={t('compliance.wizard_step_legal', 'Legal bases')}>
                {LEGAL_BASES.map(lb => {
                    const active = bases.includes(lb.id);
                    return (
                        <button
                            key={lb.id}
                            type="button"
                            aria-pressed={active}
                            data-testid={`${testId}-lb-${lb.id}`}
                            onClick={() => {
                                const s = new Set(bases);
                                if (s.has(lb.id)) s.delete(lb.id); else s.add(lb.id);
                                update({ legal_bases: Array.from(s) });
                            }}
                            className="inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold"
                            style={active
                                ? { background: 'color-mix(in srgb, var(--kind-compliance) 14%, transparent)', borderColor: 'var(--kind-compliance)', color: 'var(--kind-compliance)' }
                                : { background: 'transparent', borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                        >
                            {active && <Check size={12} />}
                            {t(lb.labelKey)}
                        </button>
                    );
                })}
            </div>
        );
    }

    if (index === 2) {
        return (
            <div className="flex flex-col gap-3" data-testid={`${testId}-residency`}>
                <Field label={t('compliance.data_residency', 'Data residency')}>
                    <select value={data?.data_residency || 'eu'} onChange={e => update({ data_residency: e.target.value })} className={INPUT} data-testid={`${testId}-residency-select`}>
                        <option value="eu">{t('compliance.residency_eu', 'EU only')}</option>
                        <option value="internal">{t('compliance.residency_internal', 'Internal only')}</option>
                        <option value="hybrid">{t('compliance.residency_hybrid', 'Hybrid')}</option>
                    </select>
                </Field>
                <Field label={t('compliance.default_retention_days', 'Default retention (days)')}>
                    <input type="number" min={0} value={data?.default_retention_days ?? ''}
                        onChange={e => update({ default_retention_days: e.target.value })} className={INPUT} data-testid={`${testId}-retention`} />
                </Field>
                <Field label={t('compliance.privacy_notice_url', 'Privacy notice URL')}>
                    <input value={data?.privacy_notice_url || ''}
                        onChange={e => update({ privacy_notice_url: e.target.value })}
                        placeholder="https://yourcompany.com/privacy" className={INPUT} />
                </Field>
            </div>
        );
    }

    if (index === 3) {
        return (
            <div className="flex flex-col gap-2" data-testid={`${testId}-breach`}>
                <UserPicker
                    users={orgUsers}
                    mode="multi"
                    label={t('compliance.add_org_recipient', 'Add a recipient from your organisation')}
                    placeholder={t('compliance.pick_org_user_placeholder', 'Search by name or e-mail')}
                    excludeEmails={recipients}
                    onSelect={u => { if (u?.email && !recipients.includes(u.email)) update({ breach_recipients: [...recipients, u.email] }); }}
                />
                {recipients.map((r, i) => (
                    <div key={`${r}-${i}`} className="flex items-center gap-1.5" data-testid={`${testId}-recipient`}>
                        <span className="flex-1 rounded-md bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-[13px] text-[var(--text-primary)]">{r}</span>
                        <button
                            type="button"
                            aria-label={t('common.remove', 'Remove')}
                            onClick={() => update({ breach_recipients: recipients.filter((_, idx) => idx !== i) })}
                            className="rounded-md px-1.5 text-base leading-none"
                            style={{ color: 'var(--error-ink)' }}
                        >×</button>
                    </div>
                ))}
                <div className="flex gap-1.5">
                    <input
                        value={data?.newRecipient || ''}
                        onChange={e => update({ newRecipient: e.target.value })}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addRecipient(); } }}
                        placeholder="security@example.com"
                        className={`${INPUT} flex-1`}
                        data-testid={`${testId}-recipient-input`}
                    />
                    <button
                        type="button"
                        onClick={addRecipient}
                        className="rounded-lg border border-[var(--border-default)] px-3 py-2 text-[13px] font-semibold text-[var(--text-primary)]"
                        data-testid={`${testId}-recipient-add`}
                    >{t('compliance.add', 'Add')}</button>
                </div>
            </div>
        );
    }

    return null;
}
