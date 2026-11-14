import BlogSearch from './BlogSearch';
import { PostMeta, tagLine } from './PostCard';
import {
    assetSrc, formatPostDay, indexHref, label, postHref,
    type BlogIndexPayload, type BlogLabels, type BlogPostSummary,
} from './blogFormat';

/**
 * The blog index (/blog): heading and intro with the search box beside them,
 * the topics as a row of text links, the newest post in one tinted panel and
 * the rest as a dated list. A post without a cover image is the normal case,
 * so nothing here depends on one. Every link is a plain <a> — the marketing
 * site navigates with full page loads, which is what makes each URL
 * server-rendered and shareable.
 */

/** The newest post: the one tinted panel of the page. */
function PostFeature({ post, basePath, locale, labels }: { post: BlogPostSummary; basePath: string; locale: string; labels: BlogLabels }) {
    const href = postHref(basePath, post.slug);
    const cover = assetSrc(post.coverImage);
    return (
        <article className={`blog-feature${cover ? ' blog-feature--cover' : ''}`}>
            <div className="blog-feature-body">
                <PostMeta post={post} locale={locale} labels={labels} />
                <h2 className="blog-feature-title"><a href={href}>{post.title}</a></h2>
                {post.excerpt ? <p className="blog-feature-excerpt">{post.excerpt}</p> : null}
                {post.tags.length ? <p className="blog-feature-tags">{tagLine(post, 3)}</p> : null}
            </div>
            {cover ? (
                <div className="blog-feature-cover">
                    <img src={cover} alt="" loading="eager" decoding="async" />
                </div>
            ) : null}
        </article>
    );
}

/** One post in the dated list: date, title and excerpt, topic and reading time. */
function PostRow({ post, basePath, locale, labels }: { post: BlogPostSummary; basePath: string; locale: string; labels: BlogLabels }) {
    const href = postHref(basePath, post.slug);
    const cover = assetSrc(post.coverImage);
    const { day, year } = formatPostDay(post.publishedAt, locale);
    return (
        <li className={`blog-row${cover ? ' blog-row--cover' : ''}`}>
            <p className="blog-row-date">
                {day ? (
                    <time dateTime={post.publishedAt || undefined}>
                        <span className="blog-row-day">{day}</span>
                        <span className="blog-row-year">{year}</span>
                    </time>
                ) : null}
            </p>
            <div className="blog-row-body">
                <h2 className="blog-row-title"><a href={href}>{post.title}</a></h2>
                {post.excerpt ? <p className="blog-row-excerpt">{post.excerpt}</p> : null}
            </div>
            <p className="blog-row-aside">
                {post.tags.length ? <span>{tagLine(post, 1)}</span> : null}
                {post.readingMinutes ? <span>{label(labels, 'min_read', { n: post.readingMinutes })}</span> : null}
            </p>
            {cover ? (
                <div className="blog-row-cover">
                    <img src={cover} alt="" loading="lazy" decoding="async" />
                </div>
            ) : null}
        </li>
    );
}

function Topics({ blog }: { blog: BlogIndexPayload }) {
    const { labels, basePath } = blog;
    if (!blog.tags?.length) return null;
    return (
        <nav className="blog-topics" aria-label={label(labels, 'tags')}>
            <a className={`blog-topic${blog.tag ? '' : ' is-active'}`} href={basePath} aria-current={blog.tag ? undefined : 'page'}>
                {label(labels, 'all_posts')}
            </a>
            {blog.tags.map(t => {
                const active = blog.tag?.slug === t.slug;
                return (
                    <a key={t.slug} className={`blog-topic${active ? ' is-active' : ''}`} href={indexHref(basePath, { tag: t.slug })} aria-current={active ? 'page' : undefined}>
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
                <div className="blog-index-top">
                    <header className="blog-index-head">
                        <h1 className="blog-index-title">{heading}</h1>
                        {blog.description && !blog.tag ? <p className="blog-index-lead">{blog.description}</p> : null}
                    </header>
                    <BlogSearch blog={blog} />
                </div>
                <Topics blog={blog} />
                {!posts.length ? <p className="blog-empty">{label(labels, blog.tag ? 'no_posts_tag' : 'no_posts')}</p> : null}
                {featured ? <PostFeature post={featured} basePath={basePath} locale={locale} labels={labels} /> : null}
                {rest.length ? (
                    <ol className="blog-list">
                        {rest.map(p => <PostRow key={p.id} post={p} basePath={basePath} locale={locale} labels={labels} />)}
                    </ol>
                ) : null}
                <Paging blog={blog} />
            </div>
        </section>
    );
}
