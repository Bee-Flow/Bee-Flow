import React, { useState } from 'react';
import { ChevronDown, GraduationCap, CheckCircle2, Plus, X } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { FilterPill } from '../../../../shared/FilterPills';
import {
    Field, TextInput, DateInput, Select, UserSelect, Toggle, ActionButton, INPUT_CLASS, LABEL_CLASS,
} from '../audits/auditForms';
import { RELEVANCE_OPTIONS } from './settingsFields';

/**
 * SettingsGroup — one collapsible card of the compliance settings form.
 *
 * It renders the field table from `settingsFields.js`; the page owns the form
 * state and the save. A group whose framework is off renders collapsed with a
 * quiet "framework is off" note — never hidden, so an org can see what the
 * next framework would ask of it (locked ≠ invisible, PLAN §1.4).
 */
export default function SettingsGroup({
    group, form, onChange, orgUsers = null, open = true, onToggle = null,
    inactive = false, relevanceOf = () => 'unknown', onRelevance = null, footer = null,
}) {
    const { t } = useTranslation();
    const [selfOpen, setSelfOpen] = useState(open);
    const isOpen = onToggle ? open : selfOpen;
    const toggle = () => (onToggle ? onToggle(!isOpen) : setSelfOpen(v => !v));

    return (
        <section
            className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden"
            style={{ boxShadow: 'var(--shadow-sm)' }}
            data-testid={`settings-group-${group.id}`}
            data-inactive={inactive ? 'true' : 'false'}
        >
            <button
                type="button"
                onClick={toggle}
                aria-expanded={isOpen}
                className="w-full flex items-start gap-2 px-3.5 py-3 text-left"
                data-testid={`settings-group-${group.id}-toggle`}
            >
                <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span className="text-sm font-bold text-[var(--text-primary)]">{t(group.titleKey, group.titleEn)}</span>
                    <span className="text-xs text-[var(--text-secondary)]">{t(group.descKey, group.descEn)}</span>
                    {inactive && (
                        <span className="text-[11px] text-[var(--text-tertiary)]" data-testid={`settings-group-${group.id}-off`}>
                            {t('compliance.set_framework_off', 'This framework is off — the answers are kept and start counting when you turn it on.')}
                        </span>
                    )}
                </span>
                <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className="mt-1 shrink-0 text-[var(--text-tertiary)]"
                    style={{ transform: isOpen ? 'rotate(180deg)' : 'none' }}
                />
            </button>

            {isOpen && (
                <div className="px-3.5 pb-3.5 flex flex-col gap-3" data-testid={`settings-group-${group.id}-body`}>
                    {group.fields.map(f => (
                        <GroupField
                            key={f.name}
                            field={f}
                            form={form}
                            onChange={onChange}
                            orgUsers={orgUsers}
                            relevanceOf={relevanceOf}
                            onRelevance={onRelevance}
                            t={t}
                        />
                    ))}
                    {footer}
                </div>
            )}
        </section>
    );
}

function GroupField({ field, form, onChange, orgUsers, relevanceOf, onRelevance, t }) {
    const name = field.name;
    const value = form?.[name];
    const label = t(field.labelKey, field.labelEn);
    const hint = field.hintKey ? t(field.hintKey, field.hintEn) : null;
    const testId = `settings-f-${name}`;
    const set = (v) => onChange(name, v);

    if (field.dependsOn && form?.[field.dependsOn] !== true) return null;

    switch (field.kind) {
        case 'relevance':
            return <RelevanceField field={field} relevanceOf={relevanceOf} onRelevance={onRelevance} t={t} />;

        case 'toggle':
            return <Toggle checked={value === true} onChange={set} label={label} hint={hint} testId={testId} />;

        case 'select':
            return (
                <Field label={label} hint={hint} testId={`${testId}-field`}>
                    <Select
                        value={value ?? ''}
                        onChange={set}
                        data-testid={testId}
                        options={(field.options || []).map(o => ({ value: o.value, label: t(o.key, o.en) }))}
                    />
                </Field>
            );

        case 'date':
            return (
                <Field label={label} hint={hint} testId={`${testId}-field`}>
                    <DateInput value={value ?? ''} onChange={set} data-testid={testId} />
                </Field>
            );

        case 'number':
            return (
                <Field label={label} hint={hint} testId={`${testId}-field`}>
                    <TextInput type="number" min={field.min ?? 0} value={value ?? ''} onChange={set} placeholder={field.placeholder} data-testid={testId} />
                </Field>
            );

        case 'user':
            return (
                <Field label={label} hint={hint} testId={`${testId}-field`}>
                    <UserSelect
                        value={value ?? ''}
                        orgUsers={orgUsers}
                        noneLabel={t('compliance.set_no_user', 'Nobody selected')}
                        onChange={set}
                        data-testid={testId}
                    />
                </Field>
            );

        case 'userfill':
            return (
                <Field label={label} testId={`${testId}-field`}>
                    <UserSelect
                        value=""
                        orgUsers={orgUsers}
                        noneLabel={t('compliance.pick_org_user_placeholder', 'Select a member…')}
                        onChange={(id) => {
                            const u = (Array.isArray(orgUsers) ? orgUsers : []).find(x => String(x.id) === String(id));
                            if (u) onChange('__fill_dpo__', u);
                        }}
                        data-testid={testId}
                    />
                </Field>
            );

        case 'chips':
            return (
                <Field label={label} hint={hint} testId={`${testId}-field`}>
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label} data-testid={testId}>
                        {(field.options || []).map(o => {
                            const list = Array.isArray(value) ? value : [];
                            const active = list.includes(o.value);
                            return (
                                <FilterPill
                                    key={o.value}
                                    label={t(o.key, o.en)}
                                    active={active}
                                    onClick={() => set(active ? list.filter(x => x !== o.value) : [...list, o.value])}
                                    testId={`${testId}-${o.value}`}
                                />
                            );
                        })}
                    </div>
                </Field>
            );

        case 'emails':
            return <EmailList label={label} hint={hint} value={value} onChange={set} orgUsers={orgUsers} testId={testId} t={t} />;

        case 'strings':
            return <StringList label={label} hint={hint} value={value} onChange={set} placeholder={field.placeholder} testId={testId} t={t} />;

        case 'contacts':
            return <ContactList label={label} hint={hint} value={value} onChange={set} testId={testId} t={t} />;

        case 'stamp':
            return (
                <div className="flex flex-col gap-1.5" data-testid={`${testId}-field`}>
                    <span className={LABEL_CLASS}>{label}</span>
                    <div className="flex items-center gap-2 flex-wrap">
                        <ActionButton icon={GraduationCap} variant="success" onClick={() => set(new Date().toISOString())} data-testid={`${testId}-confirm`}>
                            {t(field.actionKey, field.actionEn)}
                        </ActionButton>
                        <span className="text-[11px] inline-flex items-center gap-1 text-[var(--text-tertiary)]" data-testid={`${testId}-state`}>
                            {value ? <CheckCircle2 size={12} aria-hidden="true" /> : null}
                            {value
                                ? t(field.setKey, field.setEn, { date: new Date(value).toLocaleDateString() })
                                : t(field.unsetKey, field.unsetEn)}
                        </span>
                    </div>
                </div>
            );

        case 'email':
        case 'url':
        case 'text':
        default:
            return (
                <Field label={label} hint={hint} testId={`${testId}-field`}>
                    <TextInput
                        type={field.kind === 'email' ? 'email' : 'text'}
                        value={value ?? ''}
                        onChange={set}
                        placeholder={field.placeholder}
                        data-testid={testId}
                    />
                </Field>
            );
    }
}

/* ── list editors ────────────────────────────────────────────────────────── */

function RemoveButton({ onClick, label, testId }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            className="h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--error-ink)]"
            data-testid={testId}
        >
            <X size={12} aria-hidden="true" />
        </button>
    );
}

function EmailList({ label, hint, value, onChange, orgUsers, testId, t }) {
    const list = Array.isArray(value) ? value : [];
    const [draft, setDraft] = useState('');
    const add = (v) => {
        const s = String(v || '').trim();
        if (!s || list.includes(s)) return;
        onChange([...list, s]);
        setDraft('');
    };
    return (
        <Field label={label} hint={hint} testId={`${testId}-field`}>
            <div className="flex flex-col gap-1.5" data-testid={testId}>
                <UserSelect
                    value=""
                    orgUsers={(Array.isArray(orgUsers) ? orgUsers : []).filter(u => !list.includes(u.email))}
                    noneLabel={t('compliance.add_org_recipient', 'Add an organisation member')}
                    onChange={(id) => {
                        const u = (Array.isArray(orgUsers) ? orgUsers : []).find(x => String(x.id) === String(id));
                        if (u?.email) add(u.email);
                    }}
                    data-testid={`${testId}-picker`}
                />
                {list.map((r, i) => (
                    <div key={`${r}-${i}`} className="flex items-center gap-1.5">
                        <span className="flex-1 min-w-0 truncate rounded-[8px] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]" data-testid={`${testId}-item`}>{r}</span>
                        <RemoveButton
                            onClick={() => onChange(list.filter((_, idx) => idx !== i))}
                            label={t('common.remove', 'Remove')}
                            testId={`${testId}-remove-${i}`}
                        />
                    </div>
                ))}
                <div className="flex items-center gap-1.5">
                    <input
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }}
                        placeholder="security@example.com"
                        aria-label={label}
                        className={INPUT_CLASS}
                        data-testid={`${testId}-input`}
                    />
                    <ActionButton icon={Plus} size="sm" onClick={() => add(draft)} data-testid={`${testId}-add`}>
                        {t('compliance.add', 'Add')}
                    </ActionButton>
                </div>
            </div>
        </Field>
    );
}

function StringList({ label, hint, value, onChange, placeholder, testId, t }) {
    const list = Array.isArray(value) ? value : [];
    const [draft, setDraft] = useState('');
    const add = () => {
        const s = draft.trim();
        if (!s) return;
        onChange([...list, s]);
        setDraft('');
    };
    /** A non-string entry (the detector's `{id,label,note}` shape) is shown, never rewritten. */
    const textOf = (x) => (typeof x === 'string' ? x : (x?.label || x?.id || ''));
    return (
        <Field label={label} hint={hint} testId={`${testId}-field`}>
            <div className="flex flex-col gap-1.5" data-testid={testId}>
                {list.map((x, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                        {typeof x === 'string' ? (
                            <input
                                value={x}
                                onChange={e => onChange(list.map((y, idx) => (idx === i ? e.target.value : y)))}
                                aria-label={`${label} ${i + 1}`}
                                className={INPUT_CLASS}
                                data-testid={`${testId}-item-${i}`}
                            />
                        ) : (
                            <span className="flex-1 min-w-0 truncate rounded-[8px] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]" data-testid={`${testId}-item-${i}`}>{textOf(x)}</span>
                        )}
                        <RemoveButton
                            onClick={() => onChange(list.filter((_, idx) => idx !== i))}
                            label={t('common.remove', 'Remove')}
                            testId={`${testId}-remove-${i}`}
                        />
                    </div>
                ))}
                <div className="flex items-center gap-1.5">
                    <input
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                        placeholder={placeholder}
                        aria-label={label}
                        className={INPUT_CLASS}
                        data-testid={`${testId}-input`}
                    />
                    <ActionButton icon={Plus} size="sm" onClick={add} data-testid={`${testId}-add`}>
                        {t('compliance.add', 'Add')}
                    </ActionButton>
                </div>
            </div>
        </Field>
    );
}

function ContactList({ label, hint, value, onChange, testId, t }) {
    const list = Array.isArray(value) ? value : [];
    const patch = (i, p) => onChange(list.map((c, idx) => (idx === i ? { ...c, ...p } : c)));
    return (
        <Field label={label} hint={hint} testId={`${testId}-field`}>
            <div className="flex flex-col gap-1.5" data-testid={testId}>
                {list.map((c, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                        <input value={c.name || ''} onChange={e => patch(i, { name: e.target.value })} placeholder={t('compliance.set_contact_name', 'Name')}
                            aria-label={t('compliance.set_contact_name', 'Name')} className={INPUT_CLASS} data-testid={`${testId}-name-${i}`} />
                        <input value={c.email || ''} onChange={e => patch(i, { email: e.target.value })} placeholder={t('compliance.set_contact_email', 'E-mail')}
                            aria-label={t('compliance.set_contact_email', 'E-mail')} className={INPUT_CLASS} data-testid={`${testId}-email-${i}`} />
                        <input value={c.entity || ''} onChange={e => patch(i, { entity: e.target.value })} placeholder={t('compliance.set_contact_entity', 'Financial entity')}
                            aria-label={t('compliance.set_contact_entity', 'Financial entity')} className={INPUT_CLASS} data-testid={`${testId}-entity-${i}`} />
                        <RemoveButton
                            onClick={() => onChange(list.filter((_, idx) => idx !== i))}
                            label={t('common.remove', 'Remove')}
                            testId={`${testId}-remove-${i}`}
                        />
                    </div>
                ))}
                <ActionButton icon={Plus} size="sm" className="self-start" onClick={() => onChange([...list, { name: '', email: '', entity: '' }])} data-testid={`${testId}-add`}>
                    {t('compliance.add', 'Add')}
                </ActionButton>
            </div>
        </Field>
    );
}

/** The framework-relevance answer — it is NOT a settings column; it goes to `frameworks.setRelevance`. */
function RelevanceField({ field, relevanceOf, onRelevance, t }) {
    const current = relevanceOf(field.name) || 'unknown';
    return (
        <Field label={t(field.labelKey, field.labelEn)} hint={field.hintKey ? t(field.hintKey, field.hintEn) : null} testId={`settings-f-${field.name}-field`}>
            <Select
                value={current}
                onChange={(v) => onRelevance?.(field.name, v)}
                options={RELEVANCE_OPTIONS.map(o => ({ value: o.value, label: t(o.key, o.en) }))}
                data-testid={`settings-f-${field.name}`}
            />
        </Field>
    );
}
