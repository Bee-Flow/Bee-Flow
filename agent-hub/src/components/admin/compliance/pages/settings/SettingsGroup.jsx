import { ChevronDown, GraduationCap, CheckCircle2, Plus, X } from 'lucide-react';
import React, { useState } from 'react';
import BreachRecipients from './BreachRecipients';
import { RELEVANCE_OPTIONS } from './settingsFields';
import { SPAN_CLASS, groupProgress, isVisible, sectionsOf, spanOf } from './settingsLayout';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { FilterPill } from '../../../../shared/FilterPills';
import { formatDay } from '../../shared/formatDates';
import {
    Field, TextInput, DateInput, Select, UserSelect, Toggle, ActionButton, INPUT_CLASS, LABEL_CLASS,
} from '../audits/auditForms';

/**
 * SettingsGroup — one collapsible card of the compliance settings form.
 *
 * It renders the field table from `settingsFields.js`; the page owns the form
 * state and the save. The header says how far the group is answered
 * (settingsLayout.groupProgress). The body is a container-queried grid: one
 * column on a narrow card, six tracks from 640px, where a field takes a
 * third, half or the whole row (settingsLayout.spanOf), so short inputs sit
 * side by side. A group with `sections` gets a sub-heading per section; a
 * `userfill` field sits in its section's heading row as a compact picker.
 *
 * `saved` is the form as last loaded or saved: the AI-literacy stamp reads
 * "not saved yet" only while it differs from it. A group whose framework is
 * off is not hidden: the page lists it under one "Frameworks that are off"
 * disclosure (locked ≠ invisible, PLAN §1.4).
 */
export default function SettingsGroup({
    group, form, saved = null, onChange, orgUsers = null, open = true, onToggle = null,
    inactive = false, relevanceOf = () => 'unknown', onRelevance = null, sectionFooters = null,
}) {
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

/** One section of a group: its sub-heading (with any member picker), the grid of fields, an optional footer. */
function GroupSection({ section, first, footer, fieldProps }) {
    const { t, form } = fieldProps;
    const titled = !!section.titleKey;
    const fillers = section.fields.filter(f => f.kind === 'userfill');
    const cells = section.fields.filter(f => !fillers.includes(f) && isVisible(f, form));
    return (
        <div
            className={`flex flex-col gap-3 ${titled && !first ? 'pt-3 border-t border-[var(--border-default)]' : ''}`}
            data-testid={section.id ? `settings-section-${section.id}` : undefined}
        >
            {(titled || fillers.length > 0) && (
                <div className="flex items-center gap-2 flex-wrap min-h-7">
                    {titled && <h3 className="m-0 text-xs font-bold text-[var(--text-primary)]">{t(section.titleKey, section.titleEn)}</h3>}
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

/** "Fill from member": a compact picker in the heading row that copies a member's name, e-mail and phone. */
function MemberFill({ field, orgUsers, onChange, t }) {
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

function GroupField({ field, form, saved, onChange, orgUsers, relevanceOf, onRelevance, t, locale }) {
    const name = field.name;
    const value = form?.[name];
    const label = t(field.labelKey, field.labelEn);
    const hint = field.hintKey ? t(field.hintKey, field.hintEn) : null;
    const testId = `settings-f-${name}`;
    const set = (v) => onChange(name, v);

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
                            {value && (unsaved ? t(field.unsavedKey, field.unsavedEn, { date }) : t(field.setKey, field.setEn, { date }))}
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
