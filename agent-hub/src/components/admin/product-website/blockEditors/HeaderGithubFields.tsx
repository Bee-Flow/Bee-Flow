import { TextField } from '../fields';
import { FieldSelect } from '../primitives';
import { useTranslation } from '../../../../hooks/useTranslation';

// The "GitHub button" kind of a header button (issue 244): label, repository
// address, a manual star count and its screen-reader words. The live count
// comes from the server's cached /api/public/github-stats, which reports one
// repository (the server's own); it is shown only when the address below is
// empty or that same repository. Otherwise, and while the server has no
// number, the manual count shows.

export interface GithubCtaValue {
    kind?: string;
    label?: string;
    repoUrl?: string;
    starsFallback?: number;
    starsText?: string;
    newTabText?: string;
}

export function HeaderKindSelect({ value, onChange }: { value: string | undefined; onChange: (kind: string) => void }) {
    const { t } = useTranslation();
    return (
        <FieldSelect
            label={t('cms_site.blocks.header.button_kind', 'Button type')}
            value={value === 'github' ? 'github' : 'link'}
            options={[
                { value: 'link', label: t('cms_site.blocks.header.kind_link', 'Link button') },
                { value: 'github', label: t('cms_site.blocks.header.kind_github', 'GitHub button with star count') },
            ]}
            onChange={onChange}
        />
    );
}

export function HeaderGithubFields<T extends GithubCtaValue>({ item, update }: { item: T; update: (next: T) => void }) {
    const { t } = useTranslation();
    return (
        <>
            <TextField
                label={t('cms_site.blocks.header.github_label', 'Label (optional)')}
                value={item.label || ''}
                onChange={(v: string) => update({ ...item, label: v })}
            />
            <TextField
                label={t('cms_site.blocks.header.github_repo', 'Repository URL')}
                value={item.repoUrl || ''}
                onChange={(v: string) => update({ ...item, repoUrl: v })}
                placeholder="https://github.com/owner/repo"
                hint={t('cms_site.blocks.header.github_repo_hint', 'Leave empty to link to the repository your server reports the stars of. The live count only appears for that repository; any other address shows the manual count below.')}
            />
            <TextField
                label={t('cms_site.blocks.header.github_stars_fallback', 'Star count to show until the live number is known')}
                value={item.starsFallback === undefined ? '' : String(item.starsFallback)}
                onChange={(v: string) => {
                    const n = Number.parseInt(v.replace(/[^0-9]/g, ''), 10);
                    update({ ...item, starsFallback: Number.isFinite(n) ? n : undefined });
                }}
                hint={t('cms_site.blocks.header.github_stars_hint', 'The live count is fetched and cached by your own server, never by the visitor\'s browser.')}
            />
            <TextField
                label={t('cms_site.blocks.header.github_stars_text', 'Word after the count (screen readers)')}
                value={item.starsText || ''}
                onChange={(v: string) => update({ ...item, starsText: v })}
                placeholder={t('cms_site.blocks.header.github_stars_text_placeholder', 'stars')}
            />
            <TextField
                label={t('cms_site.blocks.header.github_new_tab_text', 'New-tab note (screen readers)')}
                value={item.newTabText || ''}
                onChange={(v: string) => update({ ...item, newTabText: v })}
                placeholder={t('cms_site.blocks.header.github_new_tab_text_placeholder', 'opens in a new tab')}
                hint={t('cms_site.blocks.header.github_a11y_hint', 'Screen readers announce the button as label, count and this note. Empty uses the English words; the site translation fills them per language.')}
            />
        </>
    );
}
