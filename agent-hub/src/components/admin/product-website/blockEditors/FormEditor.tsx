import React from 'react';
import { InlineHint, BackgroundVariantSelect } from '../primitives';
import type { BlockEditorProps } from './editorProps';
import { set } from './shared';
import { useTranslation } from '@/hooks/useTranslation';
import { ConsentCard, DestinationCard, FieldsCard, MessagesCard, TextCard } from './FormEditorParts';
import type { FormData } from './FormEditorParts';

// ── Form ──────────────────────────────────────────────────────────────
//
// A lead-capture form that posts to a Bee Flow automation of this install:
// the visitor's details stay inside it. The block only NAMES the automation;
// an admin separately switches that automation on for website forms in the
// Destination card, and the server re-checks that on every submission.

export function FormEditor({ data = {}, onChange }: BlockEditorProps<FormData>) {
    const { t } = useTranslation();
    const setField = (key: string, value: unknown) => onChange(set(data, key, value));
    return (
        <>
            <InlineHint>{t('cms_site.blocks.form.hint', 'Submissions start a Bee Flow automation on this install. Nothing is sent to a third party.')}</InlineHint>
            <BackgroundVariantSelect
                label={t('cms_site.blocks.form.background', 'Background')}
                value={data.backgroundVariant || 'surface'}
                onChange={v => setField('backgroundVariant', v)}
            />
            <DestinationCard data={data} setField={setField} />
            <TextCard data={data} setField={setField} />
            <FieldsCard data={data} setField={setField} />
            <ConsentCard data={data} setField={setField} />
            <MessagesCard data={data} setField={setField} />
        </>
    );
}
