import { Fragment, Suspense, lazy, type ReactNode } from 'react';
import {
    assetSrc, formatPostDate, indexHref, label, postHref,
    type BlogPostFull, type BlogPostPayload, type BlogPostSummary,
} from './blogFormat';

// react-markdown stays out of every non-post page's bundle.
const BlogMarkdown = lazy(() => import('./BlogMarkdown'));

/**
 * Plain paragraphs while the Markdown renderer loads: the text is readable at
 * once instead of a blank gap where the server-rendered article was.
 */
function PlainBody({ markdown }: { markdown: string }) {
    const paragraphs = String(markdown || '').split(/\n{2,}/).map(p => p.replace(/^[#>*\-\s]+/, '').trim()).filter(Boolean);
    return <>{paragraphs.map((p, i) => <p key={i}>{p}</p>)}</>;
}

function NeighbourLink({ post, basePath, caption, rel }: { post: BlogPostSummary; basePath: string; caption: string; rel: 'prev' | 'next' }) {
    return (
        <a className={`blog-neighbour blog-neighbour--${rel}`} href={postHref(basePath, post.slug)} rel={rel}>
            <span className="blog-eyebrow">{caption}</span>
            <span className="blog-neighbour-title">{post.title}</span>
        </a>
    );
}

function PostHead({ blog, post }: { blog: BlogPostPayload; post: BlogPostFull }) {
    const { labels, basePath, locale } = blog;
    const date = formatPostDate(post.publishedAt, locale);
    const isDraft = post.status === 'draft';
    const isScheduled = post.status === 'scheduled' && !!post.publishedAt && Date.parse(post.publishedAt) > Date.now();
    return (
        <div className="container blog-post-head">
            <a className="blog-back" href={basePath}>
                <span aria-hidden="true">←</span> {label(labels, 'back_to_blog')}
            </a>
            {isDraft || isScheduled ? (
                <p className="blog-status-badge">{label(labels, isDraft ? 'draft_badge' : 'scheduled_badge')}{isScheduled && date ? ` · ${date}` : ''}</p>
            ) : null}
            {post.tags.length ? (
                <p className="blog-eyebrow">
                    {post.tags.map((t, i) => (
                        <span key={t.slug}>{i ? ' · ' : ''}<a href={indexHref(basePath, { tag: t.slug })}>{t.label}</a></span>
                    ))}
                </p>
            ) : null}
            <h1 className="blog-post-title">{post.title}</h1>
            {post.excerpt ? <p className="blog-post-lead">{post.excerpt}</p> : null}
            <PostMetaLine blog={blog} post={post} date={date} />
        </div>
    );
}

function PostMetaLine({ blog, post, date }: { blog: BlogPostPayload; post: BlogPostFull; date: string }) {
    const parts: ReactNode[] = [];
    if (post.authorName) parts.push(<span key="a">{label(blog.labels, 'by', { name: post.authorName })}</span>);
    if (date) parts.push(<time key="d" dateTime={post.publishedAt || undefined}>{date}</time>);
    if (post.readingMinutes) parts.push(<span key="r">{label(blog.labels, 'min_read', { n: post.readingMinutes })}</span>);
    return (
        <p className="blog-meta">
            {parts.map((part, i) => <Fragment key={i}>{i ? <span aria-hidden="true">·</span> : null}{part}</Fragment>)}
        </p>
    );
}

function PostFoot({ blog, post }: { blog: BlogPostPayload; post: BlogPostFull }) {
    const { labels, basePath } = blog;
    return (
        <>
            {post.tags.length ? (
                <nav className="blog-tags blog-tags--post" aria-label={label(labels, 'tags')}>
                    {post.tags.map(t => (
                        <a key={t.slug} className="blog-tag" href={indexHref(basePath, { tag: t.slug })}>#{t.label}</a>
                    ))}
                </nav>
            ) : null}
            {blog.newer || blog.older ? (
                <nav className="blog-neighbours" aria-label={label(labels, 'all_posts')}>
                    {blog.older ? <NeighbourLink post={blog.older} basePath={basePath} caption={label(labels, 'previous_post')} rel="prev" /> : <span />}
                    {blog.newer ? <NeighbourLink post={blog.newer} basePath={basePath} caption={label(labels, 'next_post')} rel="next" /> : <span />}
                </nav>
            ) : null}
            <p className="blog-foot">
                <a href={basePath}>{label(labels, 'all_posts')}</a>
                <span aria-hidden="true">·</span>
                <a href={`${basePath}/feed.xml`} type="application/rss+xml">{label(labels, 'rss')}</a>
            </p>
        </>
    );
}

export default function BlogPostView({ blog }: { blog: BlogPostPayload }) {
    const post = blog.post;
    if (!post) return null;
    const cover = assetSrc(post.coverImage);
    return (
        <article className="blog-post">
            <PostHead blog={blog} post={post} />
            {cover ? (
                <figure className="container blog-post-cover">
                    <img src={cover} alt={post.coverAlt || ''} decoding="async" />
                </figure>
            ) : null}
            <div className="container">
                <div className="blog-prose">
                    <Suspense fallback={<PlainBody markdown={post.body} />}>
                        <BlogMarkdown markdown={post.body} />
                    </Suspense>
                </div>
                <PostFoot blog={blog} post={post} />
            </div>
        </article>
    );
}
