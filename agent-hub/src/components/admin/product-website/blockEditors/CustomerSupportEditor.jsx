import React from 'react';
import { TextField } from '../fields';
import { InlineHint, CollapsibleCard, BackgroundVariantSelect } from '../primitives';
import { set } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Customer Support ──────────────────────────────────────────────────
//
// Public AI-first support form. Submits to POST /api/support/threads
// (source: 'marketing'); the AI replies inline and a human takes over on
// escalation.

export function CustomerSupportEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    const setField = (key, value) => onChange(set(data, key, value));
    return (
        <>
            <InlineHint>{t('cms_site.blocks.customer_support.click_the_title_and_intro_in', 'Click the title and intro in the preview to edit them inline.')}</InlineHint>

            <BackgroundVariantSelect
                label={t('cms_site.blocks.customer_support.background', 'Background')}
                value={data.backgroundVariant || 'surface'}
                onChange={v => setField('backgroundVariant', v)}
            />

            <CollapsibleCard title={t('cms_site.blocks.customer_support.text', 'Text')} defaultOpen={true} persistKey="blk.customer-support.text">
                <TextField label={t('cms_site.blocks.customer_support.title', 'Title')} value={data.title || ''} onChange={v => setField('title', v)} placeholder={t('cms_site.blocks.customer_support.talk_to_us', 'Talk to us')} />
                <TextField label={t('cms_site.blocks.customer_support.intro', 'Intro')} value={data.lead || ''} onChange={v => setField('lead', v)} placeholder={t('cms_site.blocks.customer_support.short_intro_under_the_title', 'Short intro under the title')} />
            </CollapsibleCard>

            <CollapsibleCard title={t('cms_site.blocks.customer_support.form_fields', 'Form fields')} defaultOpen={false} persistKey="blk.customer-support.form-fields">
                <TextField label={t('cms_site.blocks.customer_support.name_label', 'Name label')}          value={data.nameLabel || ''}          onChange={v => setField('nameLabel', v)}          placeholder={t('cms_site.blocks.customer_support.your_name', 'Your name')} />
                <TextField label={t('cms_site.blocks.customer_support.name_placeholder', 'Name placeholder')}    value={data.namePlaceholder || ''}    onChange={v => setField('namePlaceholder', v)}    placeholder={t('cms_site.blocks.customer_support.jane_doe', 'Jane Doe')} />
                <TextField label={t('cms_site.blocks.customer_support.email_label', 'Email label')}         value={data.emailLabel || ''}         onChange={v => setField('emailLabel', v)}         placeholder={t('cms_site.blocks.customer_support.email', 'Email')} />
                <TextField label={t('cms_site.blocks.customer_support.email_placeholder', 'Email placeholder')}   value={data.emailPlaceholder || ''}   onChange={v => setField('emailPlaceholder', v)}   placeholder="you@company.com" />
                <TextField label={t('cms_site.blocks.customer_support.subject_label', 'Subject label')}       value={data.subjectLabel || ''}       onChange={v => setField('subjectLabel', v)}       placeholder={t('cms_site.blocks.customer_support.subject', 'Subject')} />
                <TextField label={t('cms_site.blocks.customer_support.subject_placeholder', 'Subject placeholder')} value={data.subjectPlaceholder || ''} onChange={v => setField('subjectPlaceholder', v)} placeholder={t('cms_site.blocks.customer_support.how_can_we_help', 'How can we help?')} />
                <TextField label={t('cms_site.blocks.customer_support.message_label', 'Message label')}       value={data.messageLabel || ''}       onChange={v => setField('messageLabel', v)}       placeholder={t('cms_site.blocks.customer_support.message', 'Message')} />
                <TextField label={t('cms_site.blocks.customer_support.message_placeholder', 'Message placeholder')} value={data.messagePlaceholder || ''} onChange={v => setField('messagePlaceholder', v)} placeholder={t('cms_site.blocks.customer_support.tell_us_about_your_team', 'Tell us about your team…')} />
                <TextField label={t('cms_site.blocks.customer_support.submit_button', 'Submit button')}       value={data.submitLabel || ''}        onChange={v => setField('submitLabel', v)}        placeholder={t('cms_site.blocks.customer_support.send_to_bee_flow', 'Send to Bee Flow')} />
            </CollapsibleCard>

            <CollapsibleCard title={t('cms_site.blocks.customer_support.confirmation_message', 'Confirmation message')} defaultOpen={false} persistKey="blk.customer-support.confirmation">
                <TextField
                    label={t('cms_site.blocks.customer_support.success_title', 'Success title')}
                    value={data.successTitle || ''}
                    onChange={v => setField('successTitle', v)}
                    placeholder={t('cms_site.blocks.customer_support.thanks_we_ve_got_your_message', "Thanks — we've got your message")}
                />
                <TextField
                    label={t('cms_site.blocks.customer_support.success_body', 'Success body')}
                    value={data.successBody || ''}
                    onChange={v => setField('successBody', v)}
                    placeholder={t('cms_site.blocks.customer_support.what_the_visitor_sees_after_submitting', 'What the visitor sees after submitting')}
                    hint={t('cms_site.blocks.customer_support.shown_while_the_ai_prepares_its', 'Shown while the AI prepares its first reply.')}
                />
            </CollapsibleCard>
        </>
    );
}
