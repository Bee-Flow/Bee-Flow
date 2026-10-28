// Admin API + types for blog posts (server/routes/cmsBlog.js).
import { API_BASE } from '@/utils/helpers';

const root = `${API_BASE}/api/cms`;

export type PostStatus = 'draft' | 'scheduled' | 'published';

interface PostSeo {
    metaTitle: string;
    metaDescription: string;
    ogImage: string;
    noIndex: boolean;
}

/** The stored PostDoc (server/stores/cms/posts.js). */
export interface AdminPost {
    id: string;
    slug: string;
    title: string;
    excerpt: string;
    body: string;
    coverImage: string;
    coverAlt: string;
    authorName: string;
    tags: string[];
    status: PostStatus;
    publishedAt: string | null;
    seo: PostSeo;
    createdAt: string;
    updatedAt: string;
}

/** A row of the post list (no body). */
export interface AdminPostSummary {
    id: string;
    slug: string;
    title: string;
    excerpt: string;
    status: PostStatus;
    publishedAt: string | null;
    updatedAt: string | null;
    coverImage: string;
    tags: { slug: string; label: string }[];
    translatedLocales: string[];
}

export interface PostTranslation {
    title?: string;
    excerpt?: string;
    body?: string;
    coverAlt?: string;
    seo?: { metaTitle?: string; metaDescription?: string };
}

export const blogApi = {
    posts: (siteId: string) => `${root}/sites/${siteId}/posts`,
    post: (siteId: string, postId: string) => `${root}/sites/${siteId}/posts/${encodeURIComponent(postId)}`,
    postLocale: (siteId: string, postId: string, locale: string) =>
        `${root}/sites/${siteId}/posts/${encodeURIComponent(postId)}/locale/${encodeURIComponent(locale)}`,
};

/** The fields the editor may send in a PUT (everything but ids and timestamps). */
export const EDITABLE_POST_FIELDS = [
    'title', 'slug', 'excerpt', 'body', 'coverImage', 'coverAlt', 'authorName', 'tags', 'status', 'publishedAt', 'seo',
] as const;

export const POST_LIMITS = {
    title: 200,
    excerpt: 500,
    body: 100_000,
    tags: 10,
    tagLength: 40,
} as const;

/** Same rule as server normalizePostSlug: what the public router can reach. */
export function normalizePostSlug(raw: string): string {
    return String(raw || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 96)
        .replace(/-+$/g, '');
}

export function postSummary(post: AdminPost, translatedLocales: string[] = []): AdminPostSummary {
    return {
        id: post.id,
        slug: post.slug,
        title: post.title,
        excerpt: post.excerpt,
        status: post.status,
        publishedAt: post.publishedAt,
        updatedAt: post.updatedAt,
        coverImage: post.coverImage,
        tags: post.tags.map(label => ({ slug: normalizePostSlug(label), label })),
        translatedLocales,
    };
}

/** ISO → the value a <input type="datetime-local"> shows (local time). */
export function toLocalInput(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value (local time) → ISO, or null when empty/invalid. */
export function fromLocalInput(value: string): string | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Who sees the post right now, for the status pill. */
export function visibility(post: Pick<AdminPost, 'status' | 'publishedAt'>, now = Date.now()): 'draft' | 'scheduled' | 'live' {
    if (post.status === 'draft') return 'draft';
    const t = Date.parse(post.publishedAt || '');
    if (post.status === 'scheduled' && Number.isFinite(t) && t > now) return 'scheduled';
    return 'live';
}
