// Shared, dependency-free helpers for the public blog: the payload types the
// server sends (server/stores/cms/blogEffective.js), link builders, date and
// label formatting, and the URL gate the Markdown renderer uses.
//
// The marketing site deliberately loads no i18n catalogue (see
// hooks/useTranslation.tsx): visitor-facing blog labels arrive in the payload
// (`blog.labels`, from the cms_blog.public.* keys). DEFAULT_LABELS below is
// only the fallback for a payload without them (an old snapshot, a test).

interface BlogTag { slug: string; label: string; count?: number }

export interface BlogPostSummary {
    id: string;
    slug: string;
    title: string;
    excerpt: string;
    coverImage: string;
    coverAlt: string;
    authorName: string;
    tags: BlogTag[];
    publishedAt: string | null;
    updatedAt: string | null;
    readingMinutes: number;
}

export interface BlogPostFull extends BlogPostSummary {
    body: string;
    status?: string;
    seo?: Record<string, unknown>;
}

export type BlogLabels = Record<string, string>;

interface BlogCommon {
    locale: string;
    defaultLocale: string;
    basePath: string;
    title: string;
    description: string;
    labels: BlogLabels;
    locales?: string[];
}

export interface BlogIndexPayload extends BlogCommon {
    view: 'index';
    posts: BlogPostSummary[];
    page: number;
    pageCount: number;
    total: number;
    tag: BlogTag | null;
    tags: BlogTag[];
}

export interface BlogPostPayload extends BlogCommon {
    view: 'post';
    post: BlogPostFull | null;
    newer?: BlogPostSummary | null;
    older?: BlogPostSummary | null;
}

export type BlogPayload = BlogIndexPayload | BlogPostPayload;

export const DEFAULT_LABELS: BlogLabels = {
    title: 'Blog',
    read_more: 'Read more',
    all_posts: 'All posts',
    newer: 'Newer posts',
    older: 'Older posts',
    page_of: 'Page {page} of {pages}',
    tagged: 'Posts tagged “{tag}”',
    no_posts: 'No posts yet.',
    no_posts_tag: 'No posts with this tag.',
    min_read: '{n} min read',
    by: 'By {name}',
    back_to_blog: 'Back to the blog',
    rss: 'RSS feed',
    previous_post: 'Previous post',
    next_post: 'Next post',
    tags: 'Tags',
    search: 'Search posts',
    search_none: 'No posts match your search.',
    home: 'Home',
    latest_heading: 'Latest posts',
    latest_empty: 'Published posts appear here',
    draft_badge: 'Draft — not visible to visitors',
    scheduled_badge: 'Scheduled',
};

/** Label lookup with `{name}` interpolation and the English fallback. */
export function label(labels: BlogLabels | undefined, key: string, params: Record<string, string | number> = {}): string {
    const template = (labels && typeof labels[key] === 'string' && labels[key]) || DEFAULT_LABELS[key] || key;
    return template.replace(/\{(\w+)\}/g, (_m, k: string) => (params[k] !== undefined ? String(params[k]) : ''));
}

export function formatPostDate(iso: string | null | undefined, locale: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    try {
        return new Intl.DateTimeFormat(locale || 'en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
    } catch {
        return d.toISOString().slice(0, 10);
    }
}

export function postHref(basePath: string, slug: string): string {
    return `${basePath}/${encodeURIComponent(slug)}`;
}

export function indexHref(basePath: string, { tag, page }: { tag?: string | null; page?: number } = {}): string {
    const qs = new URLSearchParams();
    if (tag) qs.set('tag', tag);
    if (page && page > 1) qs.set('page', String(page));
    const s = qs.toString();
    return s ? `${basePath}?${s}` : basePath;
}

/** cms/<key> → /api/cms/asset/<key>; full URLs and absolute paths pass through. */
export function assetSrc(urlOrKey: string | null | undefined): string {
    if (!urlOrKey) return '';
    if (urlOrKey.startsWith('cms/')) return `/api/cms/asset/${urlOrKey.split('/').map(encodeURIComponent).join('/')}`;
    if (/^https?:\/\//i.test(urlOrKey) || (urlOrKey.startsWith('/') && !urlOrKey.startsWith('//'))) return urlOrKey;
    return '';
}

/**
 * The browser twin of server/core/cms/blogMarkdown.js safeUrl(): http(s),
 * mailto (links only), site-relative paths, #anchors and CMS asset keys;
 * everything else (javascript:, data:, vbscript:, //host) becomes ''.
 */
export function safeBlogUrl(raw: string | null | undefined, kind: 'link' | 'image' = 'link'): string {
    if (typeof raw !== 'string') return '';
    // Browsers ignore whitespace and control characters inside a scheme ("java\tscript:").
    const s = raw.trim().replace(CONTROL_OR_SPACE, '');
    if (!s || s.length > 2048) return '';
    if (s.startsWith('cms/')) return s.includes('..') ? '' : assetSrc(s);
    if (s.startsWith('#')) return kind === 'link' ? s : '';
    if (s.startsWith('/')) return s.startsWith('//') || s.startsWith('/\\') ? '' : s;
    return schemeUrl(s, kind);
}

const CONTROL_OR_SPACE = /[\u0000-\u001F\u007F\s]+/g;

/** An absolute URL by scheme (http(s), mailto for links), or a bare relative path. */
function schemeUrl(s: string, kind: 'link' | 'image'): string {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored single-character tests, linear
    if (!scheme) return /^[a-z0-9._~-]/i.test(s) && !s.includes('\\') ? `/${s.replace(/^\.\//, '')}` : '';
    const proto = scheme[1].toLowerCase();
    if (proto === 'https' || proto === 'http') return s;
    return proto === 'mailto' && kind === 'link' ? s : '';
}

export function isExternalUrl(href: string): boolean {
    return /^https?:\/\//i.test(href);
}
