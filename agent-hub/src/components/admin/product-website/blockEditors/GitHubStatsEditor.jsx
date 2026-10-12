import React from 'react';
import { TextField } from '../fields';
import { InlineHint } from '../primitives';
import { set, SectionHeaderFields } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── GitHub stats ──────────────────────────────────────────────────────
//
// The block stores no numbers: stars and the latest release are fetched
// client-side from /api/public/github-stats at view time, so the section
// can never advertise a stale count. When that endpoint has nothing, the
// section renders a plain repo link instead of empty digits.

export function GitHubStatsEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    return (
        <>
            <InlineHint>{t('cms_site.blocks.git_hub_stats.stars_and_releases_are_fetched_live', 'Stars and releases are fetched live — nothing here goes stale.')}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="github-stats" />
            <TextField
                label={t('cms_site.blocks.git_hub_stats.repository_url', 'Repository URL')}
                value={data.repoUrl || ''}
                onChange={v => onChange(set(data, 'repoUrl', v))}
                placeholder="https://github.com/owner/repo"
            />
            <TextField
                label={t('cms_site.blocks.git_hub_stats.link_label', 'Link label')}
                value={data.linkLabel || ''}
                onChange={v => onChange(set(data, 'linkLabel', v))}
                placeholder={t('cms_site.blocks.git_hub_stats.source_on_github', 'Source on GitHub')}
            />
        </>
    );
}
