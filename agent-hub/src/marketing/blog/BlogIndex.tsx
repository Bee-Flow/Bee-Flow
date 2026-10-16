import BlogSearch from './BlogSearch';
import {
    assetSrc, formatPostDate, indexHref, label, postHref,
    type BlogIndexPayload, type BlogLabels, type BlogPostSummary,
} from './blogFormat';

/**
 * The blog index (/blog): heading and intro, a tag filter, the newest post as
 * a featured card, the rest in a responsive grid, and newer/older paging.
 * Every link is a plain <a> — the marketing site navigates with full page
 * loads, which is what makes each URL server-rendered and shareable.
 */

function PostMeta({ post, locale, labels }: { post: BlogPostSummary; locale: string; labels: BlogLabels }) {
    const date = formatPostDate(post.publishedAt, locale);
    return (
        <p className="blog-meta">
            {date ? <time dateTime={post.publishedAt || undefined}>{date}</time> : null}
            {date && post.readingMinutes ? <span aria-hidden="true">·</span> : null}
            {post.readingMinutes ? <span>{label(labels, 'min_read', { n: post.readingMinutes })}</span> : null}
        </p>
    );
}

export function PostCard({ post, basePath, locale, labels, featured = false, headingLevel = 2 }: {
    post: BlogPostSummary;
    basePath: string;
    locale: string;
    labels: BlogLabels;
    featured?: boolean;
    headingLevel?: 2 | 3;
}) {
    const href = postHref(basePath, post.slug);
    const cover = assetSrc(post.coverImage);
    const Heading = headingLevel === 3 ? 'h3' : 'h2';
    return (
        <article className={`blog-card${featured ? ' blog-card--featured' : ''}${cover ? '' : ' blog-card--no-cover'}`}>
            {cover ? (
                <a className="blog-card-cover" href={href} tabIndex={-1} aria-hidden="true">
                    <img src={cover} alt="" loading={featured ? 'eager' : 'lazy'} decoding="async" />
                </a>
            ) : null}
            <div className="blog-card-body">
                {post.tags.length ? <p className="blog-eyebrow">{post.tags.slice(0, 2).map(t => t.label).join(' · ')}</p> : null}
                <Heading className="blog-card-title"><a href={href}>{post.title}</a></Heading>
                {post.excerpt ? <p className="blog-card-excerpt">{post.excerpt}</p> : null}
                <PostMeta post={post} locale={locale} labels={labels} />
            </div>
        </article>
    );
}

function TagFilter({ blog }: { blog: BlogIndexPayload }) {
    const { labels, basePath } = blog;
    if (!blog.tags?.length) return null;
    return (
        <nav className="blog-tags" aria-label={label(labels, 'tags')}>
            <a className={`blog-tag${blog.tag ? '' : ' is-active'}`} href={basePath} aria-current={blog.tag ? undefined : 'page'}>
                {label(labels, 'all_posts')}
            </a>
            {blog.tags.map(t => {
                const active = blog.tag?.slug === t.slug;
                return (
                    <a key={t.slug} className={`blog-tag${active ? ' is-active' : ''}`} href={indexHref(basePath, { tag: t.slug })} aria-current={active ? 'page' : undefined}>
                        {t.label}
                    </a>
                );
            })}
        </nav>
    );
}

function Paging({ blog }: { blog: BlogIndexPayload }) {
    const { labels, basePath, page, pageCount } = blog;
    if (pageCount <= 1) return null;
    const tag = blog.tag?.slug;
    const status = label(labels, 'page_of', { page, pages: pageCount });
    return (
        <nav className="blog-paging" aria-label={status}>
            {page > 1 ? <a className="btn btn-secondary" href={indexHref(basePath, { tag, page: page - 1 })} rel="prev">{label(labels, 'newer')}</a> : <span />}
            <span className="blog-paging-status">{status}</span>
            {page < pageCount ? <a className="btn btn-secondary" href={indexHref(basePath, { tag, page: page + 1 })} rel="next">{label(labels, 'older')}</a> : <span />}
        </nav>
    );
}

export default function BlogIndex({ blog }: { blog: BlogIndexPayload }) {
    const { labels, basePath, locale } = blog;
    const posts = Array.isArray(blog.posts) ? blog.posts : [];
    const showFeatured = blog.page === 1 && !blog.tag;
    const featured = showFeatured ? posts[0] : null;
    const rest = showFeatured ? posts.slice(1) : posts;
    const heading = blog.tag ? label(labels, 'tagged', { tag: blog.tag.label }) : blog.title;
    return (
        <section className="blog-index">
            <div className="container">
                <header className="blog-index-head">
                    <h1 className="blog-index-title">{heading}</h1>
                    {blog.description && !blog.tag ? <p className="blog-index-lead">{blog.description}</p> : null}
                </header>
                <BlogSearch blog={blog} />
                <TagFilter blog={blog} />
                {!posts.length ? <p className="blog-empty">{label(labels, blog.tag ? 'no_posts_tag' : 'no_posts')}</p> : null}
                {featured ? <PostCard post={featured} basePath={basePath} locale={locale} labels={labels} featured /> : null}
                {rest.length ? (
                    <div className="blog-grid">
                        {rest.map(p => <PostCard key={p.id} post={p} basePath={basePath} locale={locale} labels={labels} />)}
                    </div>
                ) : null}
                <Paging blog={blog} />
            </div>
        </section>
    );
}
