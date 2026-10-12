import { useEffect, useState, type ComponentType, type MouseEvent, type ReactNode } from 'react';
import SectionHeaderJs from '../components/SectionHeader';
import EditableTextJs from '../components/EditableText';
import SectionFrameJs from '../components/SectionFrame';
import { sectionBgClass } from './sectionBg';
import { PostCard } from '../blog/BlogIndex';
import { indexHref, label, type BlogLabels, type BlogPostSummary } from '../blog/blogFormat';
import { LOCALE_PREFIXES } from '../../utils/cmsPublicRouting';
import '../blog/blog.css';

// Plain-JS section components: TypeScript infers every destructured prop as
// required (same note as admin blockEditors/ClipFields.tsx).
const SectionHeader = SectionHeaderJs as unknown as ComponentType<Record<string, unknown>>;
const EditableText = EditableTextJs as unknown as ComponentType<{ path: string; placeholder?: string; children?: ReactNode }>;
const SectionFrame = SectionFrameJs as unknown as ComponentType<{ id: string; name: string; enabled: boolean; children?: ReactNode }>;

/**
 * "Latest posts" block — the newest blog posts on any page. Content shape
 * (BLOCK_DEFAULTS['blog-latest'] in server/i18n/defaults/cmsDefaults.js):
 *
 *   { eyebrow, title, lead, limit (1-6), tagId, linkLabel, emptyText, backgroundVariant }
 *
 * Like the release-notes block, the posts are NOT block content: they come
 * from GET /api/cms/blog/posts (the live site's PUBLISHED, visible posts), so a
 * post going live never needs this page to be re-published, and a draft can
 * never leak through a page. Fail-soft: no posts on the live site → nothing;
 * the editor keeps the scaffold so the block can be placed and styled.
 */

interface LatestPostsData {
    enabled?: boolean;
    eyebrow?: string;
    title?: string;
    lead?: string;
    limit?: number;
    tagId?: string;
    linkLabel?: string;
    emptyText?: string;
    backgroundVariant?: string;
    align?: string;
    [key: string]: unknown;
}

const isEditable = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('preview');

/** The page's language from its path prefix (/nl/…), like the cookie banner. */
function pageLocale(): string {
    if (typeof window === 'undefined') return '';
    const seg = (window.location.pathname.split('/')[1] || '').toLowerCase();
    if (LOCALE_PREFIXES.has(seg)) return seg;
    return new URLSearchParams(window.location.search).get('locale') || '';
}

interface LatestState { posts: BlogPostSummary[]; basePath: string; locale: string; labels: BlogLabels }

/** The newest visible posts of the live site, fetched once per limit/tag. */
function useLatestPosts(limit: number, tag: string): LatestState | null {
    const [state, setState] = useState<LatestState | null>(null);
    useEffect(() => {
        let cancelled = false;
        const locale = pageLocale();
        const qs = new URLSearchParams({ limit: String(limit) });
        if (locale) qs.set('locale', locale);
        if (tag) qs.set('tag', tag);
        fetch(`/api/cms/blog/posts?${qs.toString()}`, { credentials: 'omit' })
            .then(r => (r.ok ? r.json() : null))
            .then((payload: { posts?: BlogPostSummary[]; basePath?: string; labels?: BlogLabels; locale?: string } | null) => {
                if (cancelled || !payload || !Array.isArray(payload.posts)) return;
                setState({
                    posts: payload.posts,
                    basePath: payload.basePath || '/blog',
                    locale: payload.locale || locale || 'en',
                    labels: payload.labels || {},
                });
            })
            .catch(() => { /* fail-soft: the block renders nothing */ });
        return () => { cancelled = true; };
    }, [limit, tag]);
    return state;
}

const EMPTY_STATE: LatestState = { posts: [], basePath: '/blog', locale: 'en', labels: {} };

const HEADER_KEYS = ['eyebrow', 'title', 'lead', 'eyebrowStyle', 'titleStyle', 'leadStyle', 'eyebrowAlign', 'titleAlign', 'leadAlign', 'align'];

function stopEditNavigation(e: MouseEvent<HTMLAnchorElement>) {
    // Editing the label must not navigate away (same guard as release-notes).
    const target = e.target as HTMLElement;
    if (target.closest && target.closest('.cms-editable')) e.preventDefault();
}

export default function LatestPosts({ data = {} }: { data?: LatestPostsData }) {
    const limit = Math.min(6, Math.max(1, Math.floor(Number(data.limit) || 3)));
    const tag = typeof data.tagId === 'string' ? data.tagId.trim() : '';
    const state = useLatestPosts(limit, tag);
    if (data.enabled === false) return null;
    const editing = isEditable();
    const { posts, basePath, labels, locale } = state || EMPTY_STATE;
    if (!posts.length && !editing) return null;
    const header = Object.fromEntries(HEADER_KEYS.map(k => [k, data[k]]));
    return (
        <SectionFrame id="blog-latest" name="Latest posts" enabled>
            <section className={`latest-posts ${sectionBgClass(data)}`.trim()}>
                <div className="container">
                    <SectionHeader pathPrefix="blog-latest" {...header} />
                    {posts.length ? (
                        <div className="latest-posts-grid reveal">
                            {posts.map(p => (
                                <PostCard key={p.id} post={p} basePath={basePath} locale={locale} labels={labels} headingLevel={3} />
                            ))}
                        </div>
                    ) : (
                        <p className="latest-posts-empty">
                            <EditableText path="blog-latest.emptyText" placeholder={label(labels, 'latest_empty')}>
                                {data.emptyText || ''}
                            </EditableText>
                        </p>
                    )}
                    {(data.linkLabel || editing) ? (
                        <a className="latest-posts-more" href={indexHref(basePath, { tag: tag || null })} onClick={stopEditNavigation}>
                            <EditableText path="blog-latest.linkLabel" placeholder={label(labels, 'all_posts')}>
                                {data.linkLabel || ''}
                            </EditableText>
                            <span aria-hidden="true">→</span>
                        </a>
                    ) : null}
                </div>
            </section>
        </SectionFrame>
    );
}
