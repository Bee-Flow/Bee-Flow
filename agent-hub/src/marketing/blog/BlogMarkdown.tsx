import { Children, isValidElement, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isExternalUrl, safeBlogUrl } from './blogFormat';

/**
 * A blog post body, Markdown → React, with the same rules as the server
 * renderer (server/core/cms/blogMarkdown.js):
 *   - no raw HTML: react-markdown without rehype-raw never turns it into
 *     elements (skipHtml drops it outright);
 *   - every link and image URL passes safeBlogUrl(): unsafe schemes are
 *     removed, CMS asset keys become asset URLs;
 *   - external links open without referrer or opener;
 *   - headings shift down one level — the post title is the page's h1.
 *
 * Loaded lazily by BlogPostView, so react-markdown never weighs on a page
 * that is not a blog post.
 */

type AnchorProps = ComponentPropsWithoutRef<'a'>;
type ImgProps = ComponentPropsWithoutRef<'img'>;
type HeadingProps = ComponentPropsWithoutRef<'h2'>;

function Anchor({ href, children, ...rest }: AnchorProps) {
    const safe = safeBlogUrl(href || '', 'link');
    if (!safe) return <>{children}</>;
    const external = isExternalUrl(safe) && !(typeof window !== 'undefined' && safe.startsWith(window.location.origin));
    return (
        <a {...rest} href={safe} {...(external ? { rel: 'noopener noreferrer nofollow' } : {})}>
            {children}
        </a>
    );
}

function Img({ src, alt, title }: ImgProps) {
    const safe = safeBlogUrl(typeof src === 'string' ? src : '', 'image');
    if (!safe) return alt ? <>{alt}</> : null;
    return <img src={safe} alt={alt || ''} title={title} loading="lazy" decoding="async" />;
}

function textOf(node: ReactNode): string {
    let out = '';
    Children.forEach(node, (child) => {
        if (typeof child === 'string' || typeof child === 'number') out += String(child);
        else if (isValidElement<{ children?: ReactNode }>(child)) out += textOf(child.props.children);
    });
    return out;
}

/** Same id rule as the server's headingId(), so #section links survive hydration. */
function headingSlug(text: string): string {
    return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
}

const shift = (Tag: 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => function Heading({ children }: HeadingProps) {
    return <Tag id={headingSlug(textOf(children))}>{children}</Tag>;
};

const COMPONENTS = {
    a: Anchor,
    img: Img,
    h1: shift('h2'),
    h2: shift('h3'),
    h3: shift('h4'),
    h4: shift('h5'),
    h5: shift('h6'),
    h6: shift('h6'),
};

export default function BlogMarkdown({ markdown }: { markdown: string }) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            urlTransform={(url: string, key: string) => safeBlogUrl(url, key === 'src' ? 'image' : 'link')}
            components={COMPONENTS}
        >
            {markdown || ''}
        </ReactMarkdown>
    );
}
