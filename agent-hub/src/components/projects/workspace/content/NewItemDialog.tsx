// The small "name it and create it" form the documents and notebooks tabs
// open: a name, plus either a type choice or a description. A type choice
// whose options explain themselves is shown as cards (a page or a designed
// document is not a choice to make from a bare word); otherwise a select.

import React, { useId, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
import { SelectField } from '../workspaceUi';

export const MAX_ITEM_NAME = 200;
export const MAX_ITEM_DESCRIPTION = 1000;

export interface NewItemValues {
    name: string;
    type: string;
    description: string;
}

export interface NewItemDialogProps {
    open: boolean;
    onClose: () => void;
    title: string;
    nameLabel: string;
    namePlaceholder?: string;
    submitLabel: string;
    /** A type choice when given (the first option is the default). */
    typeOptions?: Array<{ value: string; label: string; description?: string }>;
    typeLabel?: string;
    /** An optional description field. */
    withDescription?: boolean;
    busy: boolean;
    error: string | null;
    onSubmit: (values: NewItemValues) => void;
}

const FIELD = 'w-full px-3 py-2 rounded-lg text-sm border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-primary)]';
const LABEL = 'block text-[12px] font-medium text-[var(--text-secondary)] mb-1';

function Footer({ onClose, submitLabel, busy, disabled, formId }: { onClose: () => void; submitLabel: string; busy: boolean; disabled: boolean; formId: string }) {
    const { t } = useTranslation();
    return (
        <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="h-8 px-3 rounded-lg text-[13px] border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50 disabled:cursor-not-allowed">
                {t('project_content.cancel', 'Cancel')}
            </button>
            <button
                type="submit"
                form={formId}
                disabled={disabled}
                className="h-8 px-3 rounded-[10px] text-xs font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {busy ? t('project_content.creating', 'Creating…') : submitLabel}
            </button>
        </div>
    );
}

function TypeCards({ legend, name, options, value, onChange }: { legend: string; name: string; options: NonNullable<NewItemDialogProps['typeOptions']>; value: string; onChange: (v: string) => void }) {
    return (
        <fieldset>
            <legend className={LABEL}>{legend}</legend>
            <div className="space-y-2">
                {options.map((o) => (
                    <label key={o.value} className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer ${value === o.value ? 'border-[var(--accent-primary)] bg-[var(--bg-tertiary)]' : 'border-[var(--border-default)]'}`}>
                        <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-0.5" />
                        <span>
                            <span className="block text-[13px] font-medium text-[var(--text-primary)]">{o.label}</span>
                            {o.description && <span className="block text-[12px] text-[var(--text-tertiary)]">{o.description}</span>}
                        </span>
                    </label>
                ))}
            </div>
        </fieldset>
    );
}

export default function NewItemDialog(props: NewItemDialogProps) {
    const { open, onClose, title, nameLabel, namePlaceholder, submitLabel, typeOptions, typeLabel, withDescription = false, busy, error, onSubmit } = props;
    const { t } = useTranslation();
    const ids = useId();
    const [name, setName] = useState('');
    const [type, setType] = useState(typeOptions?.[0]?.value || '');
    const [description, setDescription] = useState('');
    const clean = name.trim();
    // While it is being made there is no going back: the new item opens as soon as it exists.
    const close = () => { if (!busy) onClose(); };

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!clean || busy) return;
        onSubmit({ name: clean, type, description: description.trim() });
    };

    return (
        <Modal open={open} onClose={close} title={title} size="sm" disableEscapeClose={busy}
            footer={<Footer onClose={close} submitLabel={submitLabel} busy={busy} disabled={!clean || busy} formId={`${ids}-form`} />}>
            <form id={`${ids}-form`} onSubmit={submit} className="space-y-3">
                <div>
                    <label htmlFor={`${ids}-name`} className={LABEL}>{nameLabel}</label>
                    <input id={`${ids}-name`} className={FIELD} value={name} maxLength={MAX_ITEM_NAME} autoFocus
                        placeholder={namePlaceholder} onChange={(e) => setName(e.target.value)} />
                </div>
                {typeOptions && typeOptions.length > 1 && (typeOptions.some((o) => o.description)
                    ? <TypeCards legend={typeLabel || t('project_content.type', 'Type')} name={`${ids}-type`} options={typeOptions} value={type} onChange={setType} />
                    : (
                        <div>
                            <label htmlFor={`${ids}-type`} className={LABEL}>{typeLabel || t('project_content.type', 'Type')}</label>
                            <SelectField id={`${ids}-type`} wrapperClassName="relative block" className="w-full" value={type} onChange={(e) => setType(e.target.value)}>
                                {typeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </SelectField>
                        </div>
                    ))}
                {withDescription && (
                    <div>
                        <label htmlFor={`${ids}-desc`} className={LABEL}>{t('project_content.description_optional', 'Description (optional)')}</label>
                        <textarea id={`${ids}-desc`} className={`${FIELD} min-h-[72px]`} value={description} maxLength={MAX_ITEM_DESCRIPTION}
                            onChange={(e) => setDescription(e.target.value)} />
                    </div>
                )}
                {error && <p role="alert" className="text-[12px] text-[var(--error)]">{error}</p>}
            </form>
        </Modal>
    );
}
