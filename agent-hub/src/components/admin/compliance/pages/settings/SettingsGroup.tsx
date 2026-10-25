import { ChevronDown, GraduationCap, CheckCircle2, Plus, X } from 'lucide-react';
import React, { useState } from 'react';
import BreachRecipients from './BreachRecipients';
import { RELEVANCE_OPTIONS } from './settingsFields.helpers';
import { SPAN_CLASS, groupProgress, isVisible, sectionsOf, spanOf, type SettingsForm, type SettingsSection } from './settingsLayout';
import { useTranslation, type TranslateParams } from '../../../../../hooks/useTranslation';
import { FilterPill } from '../../../../shared/FilterPills';
import { formatDay } from '../../shared/formatDates';
import {
    Field, TextInput, DateInput, Select, UserSelect, Toggle, ActionButton, INPUT_CLASS, LABEL_CLASS,
} from '../audits/auditForms';
import type { OrgUser } from '../accessAuditLabels';
import type { SettingsFieldDef, SettingsGroupDef, Contact } from './settingsFields.types';
import type { Translate, MemberValue, SettingsValue, SettingsChange, RelevanceSetter, FieldProps, SettingsGroupProps, GroupSectionProps, MemberFillProps, GroupFieldProps, RemoveButtonProps, ListEntry, StringListProps, ContactRow, ContactListProps, RelevanceFieldProps } from './SettingsGroup.types';
export type { MemberValue, SettingsValue, SettingsChange } from './SettingsGroup.types';

export default function SettingsGroup({
    group, form, saved = null, onChange, orgUsers = null, open = true, onToggle = null,
    inactive = false, relevanceOf = () => 'unknown', onRelevance = null, sectionFooters = null,
}: SettingsGroupProps) {
    const { t, resolvedLocale } = useTranslation();
    const [selfOpen, setSelfOpen] = useState(open);
    const isOpen = onToggle ? open : selfOpen;
    const toggle = () => (onToggle ? onToggle(!isOpen) : setSelfOpen(v => !v));
    const progress = groupProgress(group, form, relevanceOf);
    const fieldProps = { form, saved, onChange, orgUsers, relevanceOf, onRelevance, t, locale: resolvedLocale || 'en' };

    return (
        <section
            className="shrink-0 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden shadow-[var(--shadow-sm)]"
            data-testid={`settings-group-${group.id}`}
            data-inactive={inactive ? 'true' : 'false'}
        >
            <button
                type="button"
                onClick={toggle}
                aria-expanded={isOpen}
                className="w-full flex items-start gap-2 px-3.5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                data-testid={`settings-group-${group.id}-toggle`}
            >
                <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span className="flex items-baseline gap-x-2 flex-wrap">
                        <span className="text-sm font-bold text-[var(--text-primary)]">{t(group.titleKey, group.titleEn)}</span>
                        {progress.total > 0 && (
                            <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]" data-testid={`settings-group-${group.id}-progress`}>
                                {t('compliance.set_group_progress', '{n} of {total} answered', { n: progress.answered, total: progress.total })}
                            </span>
                        )}
                    </span>
                    <span className="text-xs text-[var(--text-secondary)]">{t(group.descKey, group.descEn)}</span>
                </span>
                <ChevronDown size={14} aria-hidden="true" className={`mt-1 shrink-0 text-[var(--text-tertiary)] transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
                <div className="@container px-3.5 pb-3.5 flex flex-col gap-3" data-testid={`settings-group-${group.id}-body`}>
                    {sectionsOf(group).map((section, i) => (
                        <GroupSection
                            key={section.id || `s${i}`}
                            section={section}
                            first={i === 0}
                            footer={section.id ? sectionFooters?.[section.id] : null}
                            fieldProps={fieldProps}
                        />
                    ))}
                </div>
            )}
        </section>
    );
}

function GroupSection({ section, first, footer, fieldProps }: GroupSectionProps) {
    const { t, form } = fieldProps;
    const titled = !!section.titleKey;
    const fillers = (section.fields as SettingsFieldDef[]).filter(f => f.kind === 'userfill');
    const cells = (section.fields as SettingsFieldDef[]).filter(f => !fillers.includes(f) && isVisible(f, form));
    return (
        <div
            className={`flex flex-col gap-3 ${titled && !first ? 'pt-3 border-t border-[var(--border-default)]' : ''}`}
            data-testid={section.id ? `settings-section-${section.id}` : undefined}
        >
            {(titled || fillers.length > 0) && (
                <div className="flex items-center gap-2 flex-wrap min-h-7">
                    {titled && <h3 className="m-0 text-xs font-bold text-[var(--text-primary)]">{t(section.titleKey ?? undefined, section.titleEn ?? undefined)}</h3>}
                    {fillers.map(f => <MemberFill key={f.name} field={f} {...fieldProps} />)}
                </div>
            )}
            <div className="grid grid-cols-1 @[640px]:grid-cols-6 gap-3">
                {cells.map(f => (
                    <div key={f.name} className={SPAN_CLASS[spanOf(f)]}>
                        <GroupField field={f} {...fieldProps} />
                    </div>
                ))}
            </div>
            {footer}
        </div>
    );
}

function MemberFill({ field, orgUsers, onChange, t }: MemberFillProps) {
    const label = t(field.labelKey, field.labelEn);
    return (
        <div className="ml-auto w-[200px] max-w-full">
            <UserSelect
                value=""
                orgUsers={orgUsers}
                noneLabel={label}
                aria-label={label}
                className="py-1"
                onChange={(id) => {
                    const u = (Array.isArray(orgUsers) ? orgUsers : []).find(x => String(x.id) === String(id));
                    if (u) onChange('__fill_dpo__', u);
                }}
                data-testid={`settings-f-${field.name}`}
            />
        </div>
    );
}

function GroupField({ field, form, saved, onChange, orgUsers, relevanceOf, onRelevance, t, locale }: GroupFieldProps) {
    const name = field.name;
    const value = form?.[name];
    const label = t(field.labelKey, field.labelEn);
    const hint = field.hintKey ? t(field.hintKey, field.hintEn) : null;
    const testId = `settings-f-${name}`;
    const set = (v: string | boolean | (string | Contact)[]) => onChange(name, v);

    switch (field.kind) {
        case 'relevance':
            return <RelevanceField field={field} relevanceOf={relevanceOf} onRelevance={onRelevance} t={t} />;

        case 'toggle':
            return <Toggle checked={value === true} onChange={set} label={label} hint={hint} testId={testId} />;

        case 'select':
            return (
                <Field label={label} hint={hint} testId={`${testId}-field`}>
                    <Select
                        value={String(value ?? '')}
                        onChange={set}
                        data-testid={testId}
                        options={(field.options || []).map(o => ({ value: o.value, label: t(o.key, o.en) }))}
                    />
                </Field>
            );

        case 'date':
            return (
                <Field label={label} hint={hint} testId={`${testId}-field`}>
                    <DateInput value={String(value ?? '')} onChange={set} data-testid={testId} />
                </Field>
            );

        case 'number':
            return (
                <Field label={label} hint={hint} testId={`${testId}-field`}>
                    <TextInput type="number" min={field.min ?? 0} value={String(value ?? '')} onChange={set} placeholder={field.placeholder} data-testid={testId} />
                </Field>
            );

        case 'user':
            return (
                <Field label={label} hint={hint} testId={`${testId}-field`}>
                    <UserSelect
                        value={String(value ?? '')}
                        orgUsers={orgUsers}
                        noneLabel={t('compliance.set_no_user', 'Nobody selected')}
                        onChange={set}
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
                                    checked={active}
                                    onClick={() => set(active ? list.filter(x => x !== o.value) : [...list, o.value])}
                                    testId={`${testId}-${o.value}`}
                                />
                            );
                        })}
                    </div>
                </Field>
            );

        case 'emails':
            return <BreachRecipients label={label} hint={hint} value={value} onChange={set} orgUsers={orgUsers} testId={testId} />;

        case 'strings':
            return <StringList label={label} hint={hint} value={value} onChange={set} placeholder={field.placeholder} testId={testId} t={t} />;

        case 'contacts':
            return <ContactList label={label} hint={hint} value={value} onChange={set} testId={testId} t={t} />;

        case 'stamp': {
            // "not saved yet" only while the stamp differs from the loaded one.
            const unsaved = !!value && value !== (saved ? saved[name] : value);
            const date = value ? formatDay(value, locale) : '';
            return (
                <div className="flex flex-col gap-1" data-testid={`${testId}-field`}>
                    <span className={LABEL_CLASS}>{label}</span>
                    <div className="flex items-center gap-2 flex-wrap">
                        <ActionButton icon={GraduationCap} variant="success" onClick={() => set(new Date().toISOString())} data-testid={`${testId}-confirm`}>
                            {t(field.actionKey, field.actionEn)}
                        </ActionButton>
                        <span
                            className={`text-[11px] inline-flex items-center gap-1 ${unsaved ? 'text-[var(--warning-ink)]' : 'text-[var(--text-tertiary)]'}`}
                            data-testid={`${testId}-state`}
                            data-unsaved={unsaved || undefined}
                        >
                            {value ? <CheckCircle2 size={12} aria-hidden="true" /> : null}
                            {!value && t(field.unsetKey, field.unsetEn)}
                            {!!value && (unsaved ? t(field.unsavedKey, field.unsavedEn, { date }) : t(field.setKey, field.setEn, { date }))}
                        </span>
                    </div>
                </div>
            );
        }

        case 'email':
        case 'url':
        case 'text':
        default:
            return (
                <Field label={label} hint={hint} testId={`${testId}-field`}>
                    <TextInput
                        type={field.kind === 'email' ? 'email' : 'text'}
                        value={String(value ?? '')}
                        onChange={set}
                        placeholder={field.placeholder}
                        data-testid={testId}
                    />
                </Field>
            );
    }
}

/* ── list editors ────────────────────────────────────────────────────────── */

function RemoveButton({ onClick, label, testId }: RemoveButtonProps) {
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

function StringList({ label, hint, value, onChange, placeholder, testId, t }: StringListProps) {
    const list: ListEntry[] = Array.isArray(value) ? value : [];
    const [draft, setDraft] = useState('');
    const add = () => {
        const s = draft.trim();
        if (!s) return;
        onChange([...list, s]);
        setDraft('');
    };
    /** A non-string entry (the detector's `{id,label,note}` shape) is shown, never rewritten. */
    const textOf = (x: ListEntry) => (typeof x === 'string' ? x : (x?.label || x?.id || ''));
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

function ContactList({ label, hint, value, onChange, testId, t }: ContactListProps) {
    const list: ContactRow[] = Array.isArray(value) ? value : [];
    const patch = (i: number, p: ContactRow) => onChange(list.map((c, idx) => (idx === i ? { ...c, ...p } : c)));
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

function RelevanceField({ field, relevanceOf, onRelevance, t }: RelevanceFieldProps) {
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
