import type { CmsSiteDoc } from './cmsPanelTypes';
import { useTranslation } from '@/hooks/useTranslation';
import BlogInspector from '../blog/BlogInspector';
import type { BlogSettings } from '../blog/BlogInspector';
import BlogPostList from '../blog/BlogPostList';
import { AppIcon } from '../blog/jsComponents';
import type { BlogEditor } from '../blog/useBlogEditor';

export type ConfirmFn = (opts: {
    title: string;
    description?: string;
    confirmLabel?: string;
    destructive?: boolean;
}) => Promise<boolean>;

/** The navigator's Blog slot: the post list, with a confirmed delete. */
export function BlogNavigatorList({ blog, locale, confirm }: { blog: BlogEditor; locale: string; confirm: ConfirmFn }) {
    const { t } = useTranslation();
    return (
        <BlogPostList
            posts={blog.posts}
            loaded={blog.loaded}
            activePostId={blog.activePostId}
            locale={locale}
            onSelect={(id) => { void blog.selectPost(id); }}
            onCreate={() => { void blog.createPost(t('cms_blog.list.new_title', 'New post')); }}
            onDelete={async (p) => {
                const ok = await confirm({
                    title: t('cms_blog.list.delete_title', 'Delete “{title}”?', { title: p.title || t('cms_blog.list.untitled', 'Untitled post') }),
                    description: t('cms_blog.list.delete_body', 'The post and its translations are removed from the draft. The live site keeps it until you publish again. This cannot be undone.'),
                    confirmLabel: t('cms_blog.list.delete', 'Delete post'),
                    destructive: true,
                });
                if (ok) await blog.deletePost(p.id);
            }}
        />
    );
}

interface BlogInspectorSlotProps {
    blog: BlogEditor;
    blogSettings: BlogSettings;
    site: CmsSiteDoc | null;
    translationMode: boolean;
    activeLocale: string;
    localeName: string;
    defaultLocale: string;
    updateSiteChrome: (next: CmsSiteDoc) => void;
}

/** The inspector's Blog slot; the index settings ride the site save. */
export function BlogInspectorSlot({ blog, blogSettings, site, updateSiteChrome, ...rest }: BlogInspectorSlotProps) {
    return (
        <BlogInspector
            post={blog.post}
            translations={blog.translations}
            saveStatus={blog.saveStatus}
            error={blog.error}
            {...rest}
            onPostChange={blog.updatePost}
            onTranslationChange={blog.updateTranslation}
            settings={blogSettings}
            onSettingsChange={(next) => site && updateSiteChrome({ ...site, blog: next })}
        />
    );
}

/**
 * Stage empty-state overlay — the preview always stays center-stage, so
 * "nothing here yet" guidance lives ON the stage instead of a bare pane.
 */
export function StageEmptyOverlay({ noPages, onCreateFirstPage }: { noPages: boolean; onCreateFirstPage: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="pointer-events-auto max-w-xs w-full mx-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)]/95 shadow-xl p-5 text-center">
                <AppIcon
                    name={noPages ? 'FileText' : 'LayoutGrid'}
                    className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)]"
                />
                <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                    {noPages ? t('cms_site.site.panel.no_pages_title', 'This site has no pages yet') : t('cms_site.site.panel.empty_page', 'Empty page')}
                </h4>
                <p className="text-xs text-[var(--text-muted)] mb-3">
                    {noPages
                        ? t('cms_site.site.panel.no_pages_body', 'Every website starts with a page.')
                        : t('cms_site.site.panel.empty_page_body', 'Add your first block from the Blocks list on the left (+).')}
                </p>
                {noPages && (
                    <button
                        type="button"
                        onClick={onCreateFirstPage}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent-primary)] text-white text-xs font-medium hover:bg-[var(--accent-primary)]/90"
                    >
                        <AppIcon name="Plus" className="w-3.5 h-3.5" />
                        {t('cms_site.site.panel.create_first_page', 'Create your first page')}
                    </button>
                )}
            </div>
        </div>
    );
}
