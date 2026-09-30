/**
 * A whole site by its sitemap (POST /:id/ingest/sitemap): every page the
 * sitemap lists, up to a cap, read once. The answer says what went in, what
 * was skipped and whether the cap cut the walk short — a 5000-page sitemap
 * read to 500 is a partial ingest, and the person has to be able to see that.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet } from '@/shared/patterns';
import { Text, TextField, useToast } from '@/shared/ui';

import { useIngestSitemap } from '../hooks/sources';
import { sourceErrorMessage } from '../model/sourceErrors';
import { isWebAddress, withScheme } from '../model/webAddress';

export function SitemapSheet({ kbId, visible, onClose }: { kbId: string; visible: boolean; onClose: () => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const [url, setUrl] = useState('');
    const [pages, setPages] = useState('100');
    const ingest = useIngestSitemap(kbId, {
        onSuccess: (r) => {
            toast(
                t('mobile.knowledge.sitemap_done', '{ingested} pages added, {skipped} skipped, {errors} failed', {
                    ingested: r.ingested,
                    skipped: r.skipped,
                    errors: r.errors,
                }),
                r.errors > 0 ? 'error' : 'success',
            );
            if (r.maxPagesCapped) toast(t('mobile.knowledge.sitemap_capped', 'The sitemap had more pages than the limit; the rest were left out.'), 'neutral');
            onClose();
        },
    });
    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.knowledge.sitemap', 'Sitemap')}
            subtitle={t('mobile.knowledge.sitemap_hint', 'Every page a sitemap lists, read once. Large sites take a while.')}
            submitLabel={t('knowledge.form.add', 'Add source')}
            canSubmit={isWebAddress(url)}
            submitting={ingest.isPending}
            onSubmit={() => ingest.mutate({ url: withScheme(url), maxPages: Math.max(Number.parseInt(pages, 10) || 1, 1) })}
        >
            {ingest.error ? <Text variant="caption" tone="error">{sourceErrorMessage(t, ingest.error)}</Text> : null}
            <TextField
                label={t('knowledge.form.url', 'Address')}
                value={url}
                onChangeText={setUrl}
                placeholder={t('mobile.knowledge.sitemap_placeholder', 'https://example.com/sitemap.xml')}
                hint={t('mobile.knowledge.url_scheme_hint', 'You can leave out https:// — it is added for you.')}
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
            />
            <TextField label={t('knowledge.form.max_pages', 'At most this many pages')} value={pages} onChangeText={setPages} keyboardType="number-pad" />
        </FormSheet>
    );
}
