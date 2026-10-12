// Builds the `content.blog` payload the preview iframe renders while the Blog
// entry is open — the same shape server/stores/cms/blogEffective.js sends the
// public site, so the canvas shows the real public renderer (BlogView) with
// the unsaved editor state, in the language being edited.
import { DEFAULT_LABELS, type BlogLabels, type BlogPayload, type BlogPostSummary } from '../../../../marketing/blog/blogFormat';
import { normalizePostSlug, visibility, type AdminPost, type AdminPostSummary, type PostTranslation } from './blogApi';
import { wordCount } from './markdownCommands';

export interface BlogPreviewInput {
    post: AdminPost | null;
    posts: AdminPostSummary[];
    translation: PostTranslation | null;
    locale: string;
    defaultLocale: string;
    settings: { title?: Record<string, string>; description?: Record<string, string>; postsPerPage?: number } | null;
    /** (key, fallback) → label, e.g. the admin's t() bound to cms_blog.public.* */
    labelFor: (key: string, fallback: string) => string;
}

const pick = (map: Record<string, string> | undefined, locale: string, defaultLocale: string) =>
    (map && (map[locale] || map[defaultLocale])) || '';

const nonEmpty = (v: string | undefined, fallback: string) => (typeof v === 'string' && v.trim() ? v : fallback);

function previewPost(post: AdminPost, translation: PostTranslation | null) {
    const tr = translation || {};
    const body = nonEmpty(tr.body, post.body);
    const words = wordCount(body);
    return {
        id: post.id,
        slug: post.slug,
        title: nonEmpty(tr.title, post.title),
        excerpt: nonEmpty(tr.excerpt, post.excerpt),
        body,
        coverImage: post.coverImage,
        coverAlt: nonEmpty(tr.coverAlt, post.coverAlt),
        authorName: post.authorName,
        tags: post.tags.map(label => ({ slug: normalizePostSlug(label), label })),
        publishedAt: post.publishedAt,
        updatedAt: post.updatedAt,
        readingMinutes: words ? Math.max(1, Math.round(words / 220)) : 0,
        status: post.status,
    };
}

function toSummary(p: AdminPostSummary): BlogPostSummary {
    return {
        id: p.id, slug: p.slug, title: p.title, excerpt: p.excerpt, coverImage: p.coverImage, coverAlt: '',
        authorName: '', tags: p.tags, publishedAt: p.publishedAt, updatedAt: p.updatedAt, readingMinutes: 0,
    };
}

function tagCloud(posts: BlogPostSummary[]) {
    const counts = new Map<string, { slug: string; label: string; count: number }>();
    for (const p of posts) for (const tg of p.tags) {
        const cur = counts.get(tg.slug);
        counts.set(tg.slug, { slug: tg.slug, label: cur ? cur.label : tg.label, count: (cur ? cur.count : 0) + 1 });
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
}

export function buildBlogPreview({ post, posts, translation, locale, defaultLocale, settings, labelFor }: BlogPreviewInput): BlogPayload {
    const labels: BlogLabels = {};
    for (const [key, fallback] of Object.entries(DEFAULT_LABELS)) labels[key] = labelFor(key, fallback);
    const common = {
        locale,
        defaultLocale,
        basePath: locale !== defaultLocale ? `/${locale}/blog` : '/blog',
        title: pick(settings?.title, locale, defaultLocale) || labels.title,
        description: pick(settings?.description, locale, defaultLocale),
        labels,
    };
    if (post) return { ...common, view: 'post', post: previewPost(post, translation), newer: null, older: null };

    // The index as visitors will see it after the next publish: visible posts only.
    const visible = posts.filter(p => visibility(p) === 'live').map(toSummary);
    const perPage = settings?.postsPerPage || 10;
    return {
        ...common,
        view: 'index',
        posts: visible.slice(0, perPage),
        page: 1,
        pageCount: Math.max(1, Math.ceil(visible.length / perPage)),
        total: visible.length,
        tag: null,
        tags: tagCloud(visible),
    };
}
