import { useState, Suspense, lazy } from 'react';
import {
    assetSrc, formatPostDate, indexHref, label, postHref, postSections,
    type BlogPostFull, type BlogPostPayload, type BlogPostSummary, type PostSection,
} from './blogFormat';

// react-markdown stays out of every non-post page's bundle.
const BlogMarkdown = lazy(() => import('./BlogMarkdown'));

/** Fewer sections than this and a list of them tells the reader nothing. */
const MIN_SECTIONS_FOR_LIST = 3;

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
            <span className="blog-neighbour-caption">{caption}</span>
            <span className="blog-neighbour-title">{post.title}</span>
        </a>
    );
}

/** Where this post sits: the blog, then its first topic. */
function Crumbs({ blog, post }: { blog: BlogPostPayload; post: BlogPostFull }) {
    const { labels, basePath } = blog;
    const topic = post.tags[0];
    return (
        <nav className="blog-crumbs" aria-label={label(labels, 'back_to_blog')}>
            <a href={basePath}>{blog.title || label(labels, 'title')}</a>
            {topic ? <a href={indexHref(basePath, { tag: topic.slug })}>{topic.label}</a> : null}
        </nav>
    );
}

function PostHead({ blog, post }: { blog: BlogPostPayload; post: BlogPostFull }) {
    const [now] = useState(() => Date.now());
    const { labels, locale } = blog;
    const date = formatPostDate(post.publishedAt, locale);
    const isDraft = post.status === 'draft';
    const isScheduled = post.status === 'scheduled' && !!post.publishedAt && Date.parse(post.publishedAt) > now;
    return (
        <header className="container blog-post-head">
            <Crumbs blog={blog} post={post} />
            {isDraft || isScheduled ? (
                <p className="blog-status-badge">{label(labels, isDraft ? 'draft_badge' : 'scheduled_badge')}{isScheduled && date ? ` ${date}` : ''}</p>
            ) : null}
            <h1 className="blog-post-title">{post.title}</h1>
            {post.excerpt ? <p className="blog-post-lead">{post.excerpt}</p> : null}
        </header>
    );
}

/** Beside the article: when, how long, who, and the sections to jump to. */
function PostRail({ blog, post, sections }: { blog: BlogPostPayload; post: BlogPostFull; sections: PostSection[] }) {
    const { labels, locale } = blog;
    const date = formatPostDate(post.publishedAt, locale);
    return (
        <aside className="blog-rail">
            <p className="blog-rail-meta">
                {date ? <time dateTime={post.publishedAt || undefined}>{date}</time> : null}
                {post.readingMinutes ? <span>{label(labels, 'min_read', { n: post.readingMinutes })}</span> : null}
                {post.authorName ? <span>{label(labels, 'by', { name: post.authorName })}</span> : null}
            </p>
            {sections.length >= MIN_SECTIONS_FOR_LIST ? (
                <nav className="blog-toc" aria-label={post.title}>
                    <ol>
                        {sections.map((s, i) => <li key={`${s.id}-${i}`}><a href={`#${s.id}`}>{s.text}</a></li>)}
                    </ol>
                </nav>
            ) : null}
        </aside>
    );
}

function PostFoot({ blog, post }: { blog: BlogPostPayload; post: BlogPostFull }) {
    const { labels, basePath } = blog;
    return (
        <footer className="blog-post-foot">
            {post.tags.length ? (
                <nav className="blog-topics blog-topics--post" aria-label={label(labels, 'tags')}>
                    {post.tags.map(t => (
                        <a key={t.slug} className="blog-topic" href={indexHref(basePath, { tag: t.slug })}>{t.label}</a>
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
                <a href={`${basePath}/feed.xml`} type="application/rss+xml">{label(labels, 'rss')}</a>
            </p>
        </footer>
    );
}

export default function BlogPostView({ blog }: { blog: BlogPostPayload }) {
    const post = blog.post;
    if (!post) return null;
    const cover = assetSrc(post.coverImage);
    const sections = postSections(post.body);
    return (
        <article className="blog-post">
            <PostHead blog={blog} post={post} />
            {cover ? (
                <figure className="container blog-post-cover">
                    <img src={cover} alt={post.coverAlt || ''} decoding="async" />
                </figure>
            ) : null}
            <div className="container blog-post-layout">
                <PostRail blog={blog} post={post} sections={sections} />
                <div className="blog-post-main">
                    <div className="blog-prose">
                        <Suspense fallback={<PlainBody markdown={post.body} />}>
                            <BlogMarkdown markdown={post.body} />
                        </Suspense>
                    </div>
                    <PostFoot blog={blog} post={post} />
                </div>
            </div>
        </article>
    );
}
