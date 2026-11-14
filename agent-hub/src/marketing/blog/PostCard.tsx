import './postCard.css';
import { assetSrc, formatPostDate, label, postHref, type BlogLabels, type BlogPostSummary } from './blogFormat';

/**
 * The post card of the "latest posts" block (sections/LatestPosts), with the
 * date line and topic line the blog index shares. Kept apart from the index
 * and post views so a page that only shows the block does not load them.
 */

export function PostMeta({ post, locale, labels }: { post: BlogPostSummary; locale: string; labels: BlogLabels }) {
    const date = formatPostDate(post.publishedAt, locale);
    return (
        <p className="blog-meta">
            {date ? <time dateTime={post.publishedAt || undefined}>{date}</time> : null}
            {post.readingMinutes ? <span>{label(labels, 'min_read', { n: post.readingMinutes })}</span> : null}
        </p>
    );
}

export const tagLine = (post: BlogPostSummary, max: number) => post.tags.slice(0, max).map(t => t.label).join(', ');

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
                {post.tags.length ? <p className="blog-eyebrow">{tagLine(post, 2)}</p> : null}
                <Heading className="blog-card-title"><a href={href}>{post.title}</a></Heading>
                {post.excerpt ? <p className="blog-card-excerpt">{post.excerpt}</p> : null}
                <PostMeta post={post} locale={locale} labels={labels} />
            </div>
        </article>
    );
}
