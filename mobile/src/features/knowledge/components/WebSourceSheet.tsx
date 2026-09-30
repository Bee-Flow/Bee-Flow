/**
 * A web page — or the whole site behind it — as a SOURCE that keeps itself up
 * to date: it is fetched now and again on the chosen schedule (the web's
 * AddSourcePanel "Web page / URL" with ScheduleMenu). Unlike "Add a link" in
 * the upload sheet, which keeps one copy of the page, this refreshes.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet } from '@/shared/patterns';
import { OptionRow, Text, TextField, ToggleRow, useToast } from '@/shared/ui';

import { useCreateKbSource } from '../hooks/sources';
import { sourceErrorMessage } from '../model/sourceErrors';
import { CRON_PRESETS, refreshModeLabel, ruleFor } from '../model/sources';
import { isWebAddress, withScheme } from '../model/webAddress';

const MAX_PAGES = 500;

export function WebSourceSheet({ kbId, visible, onClose }: { kbId: string; visible: boolean; onClose: () => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const [url, setUrl] = useState('');
    const [name, setName] = useState('');
    const [site, setSite] = useState(false);
    const [pages, setPages] = useState('50');
    const [cron, setCron] = useState<string | null>(CRON_PRESETS[1].cron);
    const create = useCreateKbSource(kbId, {
        onSuccess: () => {
            toast(t('mobile.knowledge.source_added', 'Source added — it is being read now'), 'success');
            onClose();
        },
    });
    const maxPages = Math.min(Math.max(Number.parseInt(pages, 10) || 1, 1), MAX_PAGES);
    const submit = () =>
        create.mutate({
            kind: 'webpage',
            ...(name.trim() ? { name: name.trim() } : {}),
            config: { url: withScheme(url), ...(site ? { crawl: { maxPages } } : {}) },
            refresh: cron ? ruleFor('schedule', cron) : ruleFor('manual'),
        });
    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('knowledge.kind.webpage', 'Web page / URL')}
            submitLabel={t('knowledge.form.add', 'Add source')}
            canSubmit={isWebAddress(url)}
            submitting={create.isPending}
            onSubmit={submit}
        >
            {create.error ? <Text variant="caption" tone="error">{sourceErrorMessage(t, create.error)}</Text> : null}
            <TextField
                label={t('knowledge.form.url', 'Address')}
                value={url}
                onChangeText={setUrl}
                placeholder={t('mobile.knowledge.url_placeholder', 'https://')}
                hint={t('mobile.knowledge.url_scheme_hint', 'You can leave out https:// — it is added for you.')}
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
            />
            <TextField label={t('knowledge.form.name', 'Name')} value={name} onChangeText={setName} />
            <ToggleRow gutter={false} label={t('knowledge.form.whole_site', 'Follow links on the same site')} value={site} onValueChange={setSite} />
            {site ? (
                <TextField label={t('knowledge.form.max_pages', 'At most this many pages')} value={pages} onChangeText={setPages} keyboardType="number-pad" />
            ) : null}
            <Text variant="label" tone="tertiary">{t('knowledge.schedule.title', 'Refresh')}</Text>
            <OptionRow label={refreshModeLabel(t, 'manual')} selected={cron === null} onPress={() => setCron(null)} />
            {CRON_PRESETS.map((p) => (
                <OptionRow key={p.id} label={t(p.key, p.en)} selected={cron === p.cron} onPress={() => setCron(p.cron)} />
            ))}
        </FormSheet>
    );
}
