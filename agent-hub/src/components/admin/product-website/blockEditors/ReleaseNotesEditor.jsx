import React from 'react';
import { TextField } from '../fields';
import { InlineHint, FieldSelect } from '../primitives';
import { set, SectionHeaderFields } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Release notes ─────────────────────────────────────────────────────
//
// The block stores no entries. Published releases are fetched client-side
// from /api/release-notes/public at view time, so this editor only controls
// presentation. Entries themselves are written by the build pipeline and
// approved in Admin → Release notes — nothing reaches the public site until
// someone publishes it there.
//
// `variant` is structural and stays on the translation denylist, so a locale
// override can never flip the layout. `kindLabels` IS prose and translates.

export function ReleaseNotesEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    const kindLabels = data.kindLabels || {};
    const setKind = (key, v) => onChange(set(data, 'kindLabels', { ...kindLabels, [key]: v }));

    return (
        <>
            <InlineHint>
                {t('cms_site.blocks.release_notes.entries_come_from_the_build_pipeline_and', 'Entries come from the build pipeline and appear here once published in Admin → Release notes. This panel controls how they look.')}
            </InlineHint>

            <FieldSelect
                label={t('cms_site.blocks.release_notes.layout', 'Layout')}
                value={data.variant || 'compact'}
                onChange={v => onChange(set(data, 'variant', v))}
                options={[
                    { value: 'compact', label: t('cms_site.blocks.release_notes.layout_compact', 'Compact — latest release only') },
                    { value: 'full', label: t('cms_site.blocks.release_notes.layout_full', 'Full — the changelog archive') },
                ]}
            />

            <SectionHeaderFields data={data} onChange={onChange} persistScope="release-notes" />

            <TextField
                label={t('cms_site.blocks.release_notes.how_many_releases_to_show', 'How many releases to show')}
                value={String(data.limit ?? '')}
                onChange={v => onChange(set(data, 'limit', v === '' ? '' : Number(v)))}
                placeholder="1"
            />

            <TextField
                label={t('cms_site.blocks.release_notes.heading_new_features', 'Heading — new features')}
                value={kindLabels.feature || ''}
                onChange={v => setKind('feature', v)}
                placeholder={t('cms_site.blocks.release_notes.new', 'New')}
            />
            <TextField
                label={t('cms_site.blocks.release_notes.heading_improvements', 'Heading — improvements')}
                value={kindLabels.improvement || ''}
                onChange={v => setKind('improvement', v)}
                placeholder={t('cms_site.blocks.release_notes.improved', 'Improved')}
            />
            <TextField
                label={t('cms_site.blocks.release_notes.heading_fixes', 'Heading — fixes')}
                value={kindLabels.fix || ''}
                onChange={v => setKind('fix', v)}
                placeholder={t('cms_site.blocks.release_notes.fixed', 'Fixed')}
            />

            <TextField
                label={t('cms_site.blocks.release_notes.text_when_nothing_is_published_yet', 'Text when nothing is published yet')}
                value={data.emptyText || ''}
                onChange={v => onChange(set(data, 'emptyText', v))}
                placeholder={t('cms_site.blocks.release_notes.leave_empty_to_hide_the_block', 'Leave empty to hide the block entirely')}
            />

            <TextField
                label={t('cms_site.blocks.release_notes.link_label', 'Link label')}
                value={data.linkLabel || ''}
                onChange={v => onChange(set(data, 'linkLabel', v))}
                placeholder={t('cms_site.blocks.release_notes.see_all_releases', 'See all releases')}
            />
            <TextField
                label={t('cms_site.blocks.release_notes.link_url', 'Link URL')}
                value={data.linkUrl || ''}
                onChange={v => onChange(set(data, 'linkUrl', v))}
                placeholder="/changelog"
            />
        </>
    );
}
