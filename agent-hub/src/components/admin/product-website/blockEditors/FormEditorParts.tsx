import React from 'react';
import { TextField, TextArea, Toggle, RepeatableList } from '../fields';
import { InlineHint, CollapsibleCard, FieldSelect } from '../primitives';
import { useTranslation } from '@/hooks/useTranslation';
import { useFormAutomationsQuery, useSetFormAutomationEnabled, useSetFormBlockApproved } from '@/api/queries/cmsFormAutomations';
import { FORM_FIELD_TYPES } from '@/marketing/sections/formBlockModel';
import type { FormField, FormFieldType } from '@/marketing/sections/formBlockModel';

// The cards of the Form block editor (FormEditor.tsx composes them).

type ConsentData = { enabled?: boolean; text?: string };

export type FormData = Partial<Record<
    | 'backgroundVariant' | 'eyebrow' | 'title' | 'lead'
    | 'submitLabel' | 'successTitle' | 'successBody' | 'errorText' | 'automationId',
    string
>> & {
    fields?: FormField[];
    consent?: ConsentData;
};

export type SetField = (key: string, value: unknown) => void;

const FIELD_ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

const optionsToText = (f: FormField) => (f.options || []).map(o => o.value).join('\n');
const textToOptions = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean).map(value => ({ value, label: value }));

function newFieldId(fields: FormField[]): string {
    const taken = new Set(fields.map(f => f.id));
    for (let n = fields.length + 1; ; n += 1) {
        if (!taken.has(`field_${n}`)) return `field_${n}`;
    }
}

/** Which automation the form starts, and the admin's switch that lets it. */
export function DestinationCard({ data, setField }: { data: FormData; setField: SetField }) {
    const { t } = useTranslation();
    const automations = useFormAutomationsQuery();
    const toggle = useSetFormAutomationEnabled();
    const approve = useSetFormBlockApproved();
    const selected = (automations.data || []).find(a => a.id === data.automationId);
    return (
        <CollapsibleCard title={t('cms_site.blocks.form.destination', 'Destination')} defaultOpen={true} persistKey="blk.form.destination">
            <FieldSelect
                label={t('cms_site.blocks.form.automation', 'Automation')}
                value={data.automationId || ''}
                onChange={v => setField('automationId', v)}
                options={[
                    { value: '', label: t('cms_site.blocks.form.pick_automation', 'Choose an automation') },
                    ...(automations.data || []).map(a => ({ value: a.id, label: a.title || a.id })),
                ]}
                hint={t('cms_site.blocks.form.automation_hint', 'Only active automations with a webhook trigger are listed. The answers arrive as trigger.output.<field id>.')}
            />
            {selected ? (
                <Toggle
                    label={t('cms_site.blocks.form.allow_website_forms', 'Allow website forms to start this automation')}
                    value={selected.enabled}
                    onChange={enabled => toggle.mutate({ id: selected.id, enabled })}
                />
            ) : null}
            {selected && !selected.enabled ? (
                <InlineHint>{t('cms_site.blocks.form.not_enabled', 'Until this is switched on, visitors see the form as unavailable.')}</InlineHint>
            ) : null}
            {selected?.enabled ? (
                <>
                    <InlineHint>{selected.blocks.length === 0
                        ? t('cms_site.blocks.form.no_blocks', 'No form block names this automation yet. Choose it in a form block and save the page.')
                        : t('cms_site.blocks.form.blocks_using', 'Form blocks that name this automation. Only an approved block can start it.')}
                    </InlineHint>
                    {selected.blocks.map(b => (
                        <div key={b.blockId}>
                            <Toggle
                                label={t('cms_site.blocks.form.approve_block', 'Allow the form on {page} ({id})', { page: b.pageTitle || '-', id: b.blockId })}
                                value={b.approved}
                                onChange={approved => approve.mutate({ automationId: selected.id, blockId: b.blockId, approved })}
                            />
                            {b.drops.honeypot + b.drops.tooFast > 0 ? (
                                <InlineHint>{t('cms_site.blocks.form.drops', '{honeypot} caught by the trap field, {fast} sent too fast. Both look like success to the sender.', { honeypot: b.drops.honeypot, fast: b.drops.tooFast })}</InlineHint>
                            ) : null}
                        </div>
                    ))}
                </>
            ) : null}
            {toggle.isError || approve.isError ? (
                <InlineHint>{t('cms_site.blocks.form.toggle_failed', 'Could not change this setting. Try again.')}</InlineHint>
            ) : null}
        </CollapsibleCard>
    );
}

export function TextCard({ data, setField }: { data: FormData; setField: SetField }) {
    const { t } = useTranslation();
    return (
        <CollapsibleCard title={t('cms_site.blocks.form.text', 'Text')} defaultOpen={true} persistKey="blk.form.text">
            <TextField label={t('cms_site.blocks.form.eyebrow', 'Eyebrow')} value={data.eyebrow || ''} onChange={v => setField('eyebrow', v)} />
            <TextField label={t('cms_site.blocks.form.title', 'Title')} value={data.title || ''} onChange={v => setField('title', v)} />
            <TextField label={t('cms_site.blocks.form.intro', 'Intro')} value={data.lead || ''} onChange={v => setField('lead', v)} />
            <TextField label={t('cms_site.blocks.form.submit_button', 'Submit button')} value={data.submitLabel || ''} onChange={v => setField('submitLabel', v)} />
        </CollapsibleCard>
    );
}

function FieldRowEditor({ f, update }: { f: FormField; update: (next: FormField) => void }) {
    const { t } = useTranslation();
    const typeLabels: Record<FormFieldType, string> = {
        text: t('cms_site.blocks.form.type_text', 'Short text'),
        email: t('cms_site.blocks.form.type_email', 'Email'),
        textarea: t('cms_site.blocks.form.type_textarea', 'Long text'),
        select: t('cms_site.blocks.form.type_select', 'Choice'),
        checkbox: t('cms_site.blocks.form.type_checkbox', 'Checkbox'),
    };
    return (
        <>
            <TextField label={t('cms_site.blocks.form.field_label', 'Label')} value={f.label || ''} onChange={v => update({ ...f, label: v })} />
            <FieldSelect
                label={t('cms_site.blocks.form.field_type', 'Type')}
                value={f.type}
                onChange={v => update({ ...f, type: v as FormFieldType })}
                options={FORM_FIELD_TYPES.map(type => ({ value: type, label: typeLabels[type] }))}
            />
            <TextField
                label={t('cms_site.blocks.form.field_id', 'Field id')}
                value={f.id}
                onChange={v => update({ ...f, id: v })}
                hint={FIELD_ID_RE.test(f.id)
                    ? t('cms_site.blocks.form.field_id_hint', 'The name the answer arrives under in the automation. Letters, digits and _, starting with a letter.')
                    : t('cms_site.blocks.form.field_id_invalid', 'Not a valid id: use letters, digits and _, starting with a letter. This field is ignored until fixed.')}
            />
            {f.type !== 'checkbox' ? (
                <TextField label={t('cms_site.blocks.form.field_placeholder', 'Placeholder')} value={f.placeholder || ''} onChange={v => update({ ...f, placeholder: v })} />
            ) : null}
            {f.type === 'select' ? (
                <TextArea
                    label={t('cms_site.blocks.form.field_options', 'Choices')}
                    value={optionsToText(f)}
                    onChange={v => update({ ...f, options: textToOptions(v) })}
                    hint={t('cms_site.blocks.form.field_options_hint', 'One choice per line.')}
                />
            ) : null}
            <Toggle label={t('cms_site.blocks.form.field_required', 'Required')} value={!!f.required} onChange={v => update({ ...f, required: v })} />
        </>
    );
}

export function FieldsCard({ data, setField }: { data: FormData; setField: SetField }) {
    const { t } = useTranslation();
    const fields = data.fields || [];
    return (
        <CollapsibleCard title={t('cms_site.blocks.form.fields', 'Fields')} defaultOpen={true} persistKey="blk.form.fields">
            <RepeatableList<FormField>
                items={fields}
                onChange={v => setField('fields', v)}
                makeNew={() => ({ id: newFieldId(fields), type: 'text', label: '', required: false })}
                itemLabel={f => f.label || f.id}
                addLabel={t('cms_site.blocks.form.add_field', 'Add field')}
                renderItem={(f, update) => <FieldRowEditor f={f} update={update} />}
            />
        </CollapsibleCard>
    );
}

export function ConsentCard({ data, setField }: { data: FormData; setField: SetField }) {
    const { t } = useTranslation();
    const consent = data.consent || {};
    return (
        <CollapsibleCard title={t('cms_site.blocks.form.consent', 'Consent')} defaultOpen={false} persistKey="blk.form.consent">
            <Toggle
                label={t('cms_site.blocks.form.consent_required', 'Ask for consent before sending')}
                value={consent.enabled === true}
                onChange={v => setField('consent', { ...consent, enabled: v })}
            />
            <TextArea
                label={t('cms_site.blocks.form.consent_text', 'Consent text')}
                value={consent.text || ''}
                onChange={v => setField('consent', { ...consent, text: v })}
                hint={t('cms_site.blocks.form.consent_hint', 'Shown next to the checkbox. The exact wording is stored with every submission.')}
            />
        </CollapsibleCard>
    );
}

export function MessagesCard({ data, setField }: { data: FormData; setField: SetField }) {
    const { t } = useTranslation();
    return (
        <CollapsibleCard title={t('cms_site.blocks.form.messages', 'Messages')} defaultOpen={false} persistKey="blk.form.messages">
            <TextField label={t('cms_site.blocks.form.success_title', 'Success title')} value={data.successTitle || ''} onChange={v => setField('successTitle', v)} />
            <TextField label={t('cms_site.blocks.form.success_body', 'Success text')} value={data.successBody || ''} onChange={v => setField('successBody', v)} />
            <TextField label={t('cms_site.blocks.form.error_text', 'Error text')} value={data.errorText || ''} onChange={v => setField('errorText', v)} />
        </CollapsibleCard>
    );
}
