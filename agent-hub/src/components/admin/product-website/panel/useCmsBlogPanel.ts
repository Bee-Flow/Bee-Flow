import { useMemo } from 'react';
import type { CmsSiteDoc } from './cmsPanelTypes';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { BlogSettings } from '../blog/BlogInspector';
import { buildBlogPreview } from '../blog/blogPreview';
import useBlogEditor from '../blog/useBlogEditor';
import type { BlogEditor } from '../blog/useBlogEditor';
import { BLOG_VIRTUAL_ID, normalizeVirtualId } from '../sentinels';

interface BlogPanelInput {
    activeSiteId: string | null;
    activePageId: string | null;
    site: CmsSiteDoc | null;
    translationMode: boolean;
    activeLocale: string;
    defaultLocale: string;
    setDirtySincePublish: (dirty: boolean) => void;
    t: TranslateFn;
}

export interface CmsBlogPanel {
    isBlogView: boolean;
    blog: BlogEditor;
    blogSettings: BlogSettings;
    /** The `content.blog` payload the preview renders while the Blog entry is open. */
    blogPreview: ReturnType<typeof buildBlogPreview> | null;
}

/**
 * The Blog entry of the builder. Posts are their own documents with their own
 * autosave (blog/useBlogEditor); the index settings live on the SiteDoc
 * (site.blog) and ride the site save.
 */
export default function useCmsBlogPanel({
    activeSiteId, activePageId, site, translationMode, activeLocale, defaultLocale, setDirtySincePublish, t,
}: BlogPanelInput): CmsBlogPanel {
    const isBlogView = normalizeVirtualId(activePageId) === BLOG_VIRTUAL_ID;
    const blog = useBlogEditor({
        siteId: activeSiteId,
        enabled: isBlogView,
        onSaved: () => setDirtySincePublish(true),
    });
    const blogSettings = useMemo(() => ({
        title: site?.blog?.title || {},
        description: site?.blog?.description || {},
        postsPerPage: site?.blog?.postsPerPage || 10,
    }), [site]);
    const blogPreview = useMemo(() => (isBlogView ? buildBlogPreview({
        post: blog.post,
        posts: blog.posts,
        translation: translationMode && blog.post ? (blog.translations[activeLocale] || null) : null,
        locale: activeLocale,
        defaultLocale,
        settings: blogSettings,
        labelFor: (key, fallback) => t(`cms_blog.public.${key}`, fallback),
    }) : null), [isBlogView, blog.post, blog.posts, blog.translations, translationMode, activeLocale, defaultLocale, blogSettings, t]);
    return { isBlogView, blog, blogSettings, blogPreview };
}
