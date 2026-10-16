import { useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { ConfirmOptions } from '../../../shared/useConfirm';
import type { CmsPageIndexEntry } from './cmsPanelTypes';

export interface DeleteChoice {
    confirmed: boolean;
    /** The path the deleted address should lead to; '' = no redirect. */
    redirectTo: string;
}

export interface RedirectTarget {
    value: string;
    label: string;
}

/** The other pages a deleted address can lead to: the homepage is `/`, the 404 page is no target. */
export function redirectTargets(pages: CmsPageIndexEntry[], deletedId: string): RedirectTarget[] {
    return pages
        .filter(p => p.id !== deletedId && !p.isNotFound)
        .map(p => ({ value: p.isHomepage ? '/' : `/${p.slug ?? ''}`, label: p.title || p.slug || '/' }));
}

function RedirectPicker({ targets, onPick }: { targets: RedirectTarget[]; onPick: (path: string) => void }) {
    const { t } = useTranslation();
    const [value, setValue] = useState('');
    return (
        <div className="mt-3 flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[var(--text-secondary)]" htmlFor="cms-delete-redirect">
                {t('cms_site.site.page_delete.redirect_label', 'Redirect the old address to')}
            </label>
            <select
                id="cms-delete-redirect"
                className="w-full px-3 py-2 rounded-md text-sm border bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-primary)]"
                value={value}
                onChange={e => { setValue(e.target.value); onPick(e.target.value); }}
            >
                <option value="">{t('cms_site.site.page_delete.redirect_none', 'No redirect')}</option>
                {targets.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <span className="text-xs text-[var(--text-muted)]">
                {t('cms_site.site.page_delete.redirect_hint', 'Visitors and search engines that still use the old address land on that page (301).')}
            </span>
        </div>
    );
}

/**
 * The delete confirmation of a page, with a choice of where its old address
 * should lead. The homepage is deleted without a choice (the server makes no
 * redirect for it), as is a page when no other page exists.
 */
export async function askDeletePage(
    confirm: (opts: ConfirmOptions) => Promise<boolean>,
    page: CmsPageIndexEntry,
    pages: CmsPageIndexEntry[],
    options: ConfirmOptions,
): Promise<DeleteChoice> {
    const targets = page.isHomepage ? [] : redirectTargets(pages, page.id);
    let redirectTo = '';
    const description = (
        <>
            {options.description}
            {targets.length ? <RedirectPicker targets={targets} onPick={path => { redirectTo = path; }} /> : null}
        </>
    );
    const confirmed = await confirm({ ...options, description, destructive: true });
    return { confirmed, redirectTo: confirmed ? redirectTo : '' };
}
