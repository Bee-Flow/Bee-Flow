/**
 * Add a web address or a pasted text to the page's knowledge — the web's URL
 * and Text panes (WebpageSources.jsx). Files go through the picker instead.
 * The server answers at once and reads the source afterwards, so the new row
 * appears as "Processing…".
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet, required, useForm } from '@/shared/patterns';
import { TextField, useToast } from '@/shared/ui';

import { useAddTextSource, useAddUrlSource } from '../hooks/buildMutations';

export type AddSourceKind = 'url' | 'text';

type SourceForm = { url: string; name: string; text: string };

const EMPTY: SourceForm = { url: '', name: '', text: '' };

export function AddSourceSheet({
    pageId,
    kind,
    onClose,
}: {
    pageId: string;
    kind: AddSourceKind | null;
    onClose: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const addUrl = useAddUrlSource(pageId);
    const addText = useAddTextSource(pageId);
    const form = useForm({
        initial: EMPTY,
        validate:
            kind === 'url'
                ? { url: [required(t('mobile.webpages.source.url_required', 'Enter an address.'))] }
                : { text: [required(t('mobile.webpages.source.text_required', 'Paste some text.'))] },
        onSubmit: ({ url, name, text }) =>
            kind === 'url' ? addUrl.mutateAsync(url) : addText.mutateAsync({ text, name }),
    });

    const close = () => {
        form.reset(EMPTY);
        onClose();
    };

    const submit = async () => {
        if (!(await form.submit())) return;
        toast(t('mobile.webpages.source.added', 'Added to knowledge'), 'success');
        close();
    };

    return (
        <FormSheet
            visible={kind !== null}
            onClose={close}
            title={
                kind === 'url'
                    ? t('mobile.webpages.source.add_url_title', 'Add a web page')
                    : t('mobile.webpages.source.add_text_title', 'Add text')
            }
            submitLabel={t('mobile.webpages.source.add_submit', 'Add to knowledge')}
            onSubmit={() => void submit()}
            canSubmit={form.canSubmit}
            submitting={form.submitting}
            error={form.submitError}
        >
            {kind === 'url' ? (
                <TextField
                    label={t('knowledge.form.url', 'Address')}
                    placeholder={t('mobile.webpages.source.url_placeholder', 'https://example.com')}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    {...form.field('url')}
                />
            ) : (
                <>
                    <TextField
                        label={t('common.name', 'Name')}
                        placeholder={t('mobile.webpages.source.name_placeholder', "Name (e.g. 'Brand guidelines')")}
                        {...form.field('name')}
                    />
                    <TextField
                        label={t('mobile.webpages.source.text', 'Text')}
                        placeholder={t('mobile.webpages.source.text_placeholder', 'Paste text content…')}
                        multiline
                        maxLines={10}
                        {...form.field('text')}
                    />
                </>
            )}
        </FormSheet>
    );
}
